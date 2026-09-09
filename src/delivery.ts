// THE ONE DELIVERY PRIMITIVE. Two modes, chosen by the kind table and by nothing else.
import type { WakeMode } from "./kinds.ts";

export type Outcome =
  | { kind: "sent" }
  | { kind: "queued" }
  | { kind: "failed"; error: string };

/**
 * Is this the refusal that means "blocked on a human", as opposed to any other way a
 * send can fail? (MX-228, carried across unchanged.)
 *
 * `bb.sdk.threads.send` refuses a thread awaiting a human with HTTP 409
 * `awaiting_user_interaction`, and it refuses in EVERY mode: the guard sits both in the
 * send route's queue branch and in `sendThreadMessage` itself, so `steer`, `queue` and
 * `auto` all hit it. It is a property of the THREAD, not of the mode — `--mode auto` was
 * tried as a remedy and could never have worked.
 *
 * POSITIVE IDENTIFICATION ONLY — anything unrecognised is `false`, and the caller then
 * treats it as a hard failure. The two directions are not symmetrical: misreading a 409
 * as a failure reproduces the behaviour that shipped for months, while misreading a hard
 * failure as a deferral returns exit 0 over a message nobody will ever deliver. Safe is
 * "not a deferral".
 *
 * The structured fields are the real check: bb throws `BbHttpError`, which carries
 * `status` and `code` alongside the message. The string path is a second, independent
 * way to reach the same conclusion — it needs BOTH the 409 and the phrase, so prose that
 * merely mentions awaiting a user cannot trip it — and exists so a re-wrapped or
 * serialised error still classifies rather than silently degrading to `failed`.
 */
export function isAwaitingUserInteraction(e: unknown): boolean {
  const err = e as { status?: unknown; code?: unknown } | null;
  if (err && typeof err === "object") {
    if (err.status === 409 && err.code === "awaiting_user_interaction") return true;
  }
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /\b409\b/.test(message) && /awaiting user interaction/i.test(message);
}

/**
 * `immediate` is `bb.sdk.threads.send({ mode: "auto" })` — it steers a live turn and
 * starts an idle one — with MX-228's fallback: a thread awaiting a human refuses in
 * EVERY send mode, so the message goes to bb's own durable queue and bb delivers it when
 * the human answers, measured within 5s. That fallback is why a deferral exits 0:
 * nobody still owes you delivery. `defer` is NOT a retry — a pending interaction lasts
 * as long as it takes a human to answer, which was six hours in the incident this comes
 * from, and a bounded retry loop would only hide the state behind a longer wait.
 *
 * `queue` is `bb.sdk.threads.queuedMessages.create` and NEVER `send`. It cannot steer,
 * cannot 409, and is delivered when the recipient's current turn ends.
 *
 * WHAT `queue` DOES NOT BUY, measured in bb 2026-09-09 and stated in the README.
 * bb has no delivery that leaves an idle thread asleep. The send-mode enum is
 * start|auto|steer|steer-if-active|queue-if-active; `queue-if-active` queues only on an
 * ACTIVE thread and `resolveSendMode` returns "start" for an idle one.
 * `createQueuedMessageForThread` requests an auto-send when the target is idle, and
 * `runQueuedMessageAutoSendSweep` sweeps every idle thread holding a queued message. So
 * spec §3's "a thread that never runs again never sees it" is not implementable here.
 * The alternative — store it and wake nobody — is the ambient send this design deletes:
 * 446 of 472 of those reached no one, and every idle-worker stall on record is that gap.
 * Waking is the lesser cost, and the property that actually mattered — a queue message
 * never interrupts work in flight — is delivered in full.
 *
 * THE BUS BUILDS NO REPLAY MACHINERY OF ITS OWN. A second mechanism would have to be
 * swept, expired and observed, and it could go silently blind.
 */
export async function deliver(
  deps: { send(): Promise<void>; queue(): Promise<void> },
  wake: WakeMode,
): Promise<Outcome> {
  const say = (e: unknown) => (e instanceof Error ? e.message : String(e));
  if (wake === "queue") {
    try {
      await deps.queue();
      return { kind: "queued" };
    } catch (e) {
      return { kind: "failed", error: say(e) };
    }
  }
  try {
    await deps.send();
    return { kind: "sent" };
  } catch (e) {
    if (!isAwaitingUserInteraction(e)) return { kind: "failed", error: say(e) };
    try {
      await deps.queue();
      return { kind: "queued" };
    } catch (e2) {
      // Blocked AND unqueueable. Reporting this as a deferral would be the one lie worse
      // than the original bug: exit 0 over a message with no delivery path at all. Both
      // errors ride along — the second alone reads as a queue problem rather than as a
      // blocked recipient.
      return {
        kind: "failed",
        error: `blocked awaiting a human, and queueing it failed: ${say(e2)} (original: ${say(e)})`,
      };
    }
  }
}

/**
 * The receipt, and the EXIT CODE — which is the part that costs something.
 *
 * A deferral exits 0, and that is only truthful because `deliver` guarantees eventual
 * delivery. What exit 1 cost when a deferral raised it: two scheduled automations
 * shelled a directed send, one under `set -euo pipefail`; three refusals each and bb
 * auto-paused them both — six hours and forty-six minutes of perimeter watch off,
 * announced nowhere. THE EXIT CODE SAYS WHETHER ANYONE STILL OWES YOU DELIVERY.
 */
export function receipt(a: {
  seq: number;
  kind: string;
  to: string;
  outcome: Outcome;
  ackRequired: boolean;
}): { stdout: string; stderr: string | null; exitCode: 0 | 1 } {
  if (a.outcome.kind === "failed") {
    return {
      stdout: `not delivered: #${a.seq} ${a.kind} -> ${a.to}`,
      stderr: `bus: ${a.to}: ${a.outcome.error}`,
      exitCode: 1,
    };
  }
  const verb = a.outcome.kind === "sent" ? "sent" : "queued";
  const lines = [`${verb} #${a.seq} ${a.kind} -> ${a.to}`];
  if (a.ackRequired) {
    lines.push(`  awaiting an ack — bb bus unanswered lists it if none comes.`);
  }
  return { stdout: lines.join("\n"), stderr: null, exitCode: 0 };
}
