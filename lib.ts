// Pure argument and message logic, split out of server.ts so `node --test` can
// reach it. Everything here decides WHAT to send and to whom; server.ts keeps
// the sqlite and the SDK calls.

export interface SendArgs {
  room: string | null;
  /** null = ambient (stored quietly), "all" = every other member, else a thread id. */
  to: string | null;
  text: string;
  error: string | null;
}

/**
 * Every `bb bus` subcommand takes the room POSITIONALLY, so a mistyped flag in
 * that slot became a room name: `bb bus join --room ops` created a room called
 * `--room`, and every later `send --room ops` found it and posted there with
 * exit 0. 966 messages from four unrelated projects accumulated in that room
 * before a thread stumbled on it — a misrouted send is indistinguishable from
 * a peer that simply went quiet, so nothing ever surfaced it.
 *
 * Returns an error string, or null when the name is usable. Only the LEADING
 * dash is rejected: dashes inside a name (`vat-audit-2026`) are ordinary, and
 * flag-shaped words in a message BODY stay prose.
 */
export function validateRoom(room: string): string | null {
  if (!room.startsWith("-")) return null;
  return (
    `bus: '${room}' is not a room — the room is POSITIONAL.\n` +
    `  write: bb bus <command> <room> [...]   (a room name may not start with '-')`
  );
}

/**
 * Parse `bb bus send <room> [--to <id>|--to all] <text...>`.
 *
 * The flag can sit anywhere after the room, because that is how people type it,
 * and everything that is not the flag or its value is message body — including
 * words that look like flags. A bus message is prose, not a command line.
 */
export function parseSend(argv: string[]): SendArgs {
  const usage = "usage: bb bus send <room> [--to <thread-id>|--to all] <text...>";
  const room = argv[1] ?? null;
  if (!room) return { room: null, to: null, text: "", error: usage };
  // Before anything else: a bogus room makes every later complaint (empty
  // body, dangling --to) point at the wrong thing, and the caller retries into
  // the same hole.
  const badRoom = validateRoom(room);
  if (badRoom) return { room: null, to: null, text: "", error: `${badRoom}\n${usage}` };

  let to: string | null = null;
  const rest: string[] = [];
  // A bare `--` ends flag parsing, the usual CLI convention. It is the escape
  // hatch for the guard below: prose that genuinely opens with a flag-shaped
  // word has a way through, so refusing the accidental case costs nothing.
  let literal = false;
  for (let i = 2; i < argv.length; i++) {
    if (!literal && argv[i] === "--") {
      literal = true;
    } else if (!literal && argv[i] === "--to") {
      const value = argv[++i];
      // `--to` with nothing after it must not silently degrade into an ambient
      // send: the caller asked to WAKE someone, and quietly not waking them is
      // the failure this bus exists to avoid.
      if (value === undefined) return { room, to: null, text: "", error: "bus: --to needs a thread id or 'all'" };
      to = value;
    } else {
      rest.push(argv[i]!);
    }
  }
  const text = rest.join(" ").trim();
  if (!text) return { room, to, text: "", error: "bus: empty message body refused" };

  // `--to` is the ONLY flag, so any other `--word` is invented — and because
  // the message is positional too, it was silently welded onto the front of the
  // body and DELIVERED. 76 messages across three live rooms opened with
  // `--message`, `--body` or `--text` before this check existed. That failure is
  // more durable than a misrouted room precisely because it works: the message
  // arrives, peers read it, and nothing ever comes back to say otherwise.
  //
  // Only the FIRST token is judged, and only `--word` — `use --force on the
  // rebase` is prose, `---` is a divider, `-42` is a number.
  const first = rest[0] ?? "";
  if (!literal && /^--[A-Za-z]/.test(first)) {
    return {
      room,
      to,
      text: "",
      error:
        `bus: message starts with '${first}', which looks like a mistyped flag — ` +
        `'--to' is the only one, and anything else ends up INSIDE your message.\n` +
        `  meant to address someone? bb bus send ${room} --to <thread-id> "<text>"\n` +
        `  really starting with '${first}'? bb bus send ${room} -- ${first} …`,
    };
  }
  return { room, to, text, error: null };
}

/**
 * Who gets woken. `--to all` means every OTHER member — waking yourself is a
 * loop, and a thread that wakes itself never goes idle.
 */
export function resolveRecipients(to: string | null, members: string[], me: string): string[] {
  if (!to) return [];
  if (to === "all") return members.filter((m) => m !== me);
  return [to];
}

export interface BusMessage {
  seq: number;
  room: string;
  created_ts: string;
  sender_thread: string;
  to_thread: string | null;
  text: string;
}

/** One line per message; the arrow only appears when the message was addressed. */
export const fmt = (m: BusMessage): string =>
  `#${m.seq} [${m.room}] ${m.created_ts} ${m.sender_thread}` +
  (m.to_thread ? ` -> ${m.to_thread}` : "") +
  `: ${m.text}`;

/**
 * Has this thread ever been part of THIS room's conversation? (MX-213)
 *
 * `unknown` is a real answer, not a failure to produce one: if the history
 * cannot be read the caller must stay silent. A warning that fires when blind
 * is unfalsifiable, and an unfalsifiable warning is trained away exactly like a
 * loud one — this machine already has three of those.
 */
export type PriorContact = "prior" | "none" | "unknown";

/**
 * Params: (room, seq, thread_id, thread_id), where `seq` is the row of the send
 * being judged. The `seq <` bound is load-bearing TWICE. It stops the outgoing
 * message counting as its own prior contact — without it nothing ever warns,
 * silently — and by making that structural it removes the ordering hazard: this
 * runs AFTER the insert and would be correct before it too, so a later edit that
 * moves the call cannot quietly disable the check. It is also, verbatim, the
 * predicate the 99-of-4423 measurement was taken with, so what ships is what was
 * measured rather than a paraphrase of it.
 *
 * Both directions count — sent into the room, or been addressed in it — because
 * a worker that only ever answers briefs is a full participant with no row of
 * its own. `messages` is already indexed by (room, seq), which covers
 * `room = ? AND seq < ?` exactly, so this is one indexed scan on the send hot
 * path: no membership bookkeeping, no API call.
 */
export const PRIOR_CONTACT_SQL =
  `SELECT EXISTS (SELECT 1 FROM messages WHERE room = ? AND seq < ? ` +
  `AND (sender_thread = ? OR to_thread = ?)) AS prior`;

/**
 * A DIRECTED SEND TO A STRANGER NOW SAYS SO (MX-213).
 *
 * `resolveRecipients` returns an explicit id unconditionally — membership is
 * loaded and then ignored — so `bb bus send <room> --to <id>` delivers to
 * non-members by design, and a typo'd or stale id returns the same unqualified
 * `sent -> room, woke 1/1` as a correct one. That is how msg #4828 reached
 * thr_r9e33xniyf, a thread that has never joined anything; it replied politely
 * and the sender only found out from mgrin three minutes later.
 *
 * Non-membership is NOT the signal. Measured against the bus store 2026-08-20:
 * only 1645 of 4423 directed sends had a recipient who was a member, so warning
 * on that fires on 62.8% of all directed traffic — orchestrator-to-worker sends
 * overwhelmingly target threads that never join. FIRST CONTACT IN THE ROOM is
 * 99 of 4423, 2.2%, and the MX-203 misroute is inside it. Rare enough to read is
 * the entire property being bought here; do not widen it.
 *
 * A WARNING, never a refusal — first contact is how every new worker gets its
 * first brief, so the send has already happened by the time this is printed.
 *
 * What it catches: addressing a stranger to this room. What it does not: picking
 * the wrong one of two threads that both already talk here.
 */
export function firstContactNotice(
  to: string | null,
  room: string,
  contact: PriorContact,
): string | null {
  // Ambient wakes nobody, so there is no address to be wrong about. `--to all`
  // resolves against membership rather than a hand-typed id; neither shape is in
  // the 4423 the measurement covers, so neither gets a warning it did not earn.
  if (!to || to === "all") return null;
  if (contact !== "none") return null;
  return (
    `bus: FIRST CONTACT — ${to} has never sent into, nor been addressed in, '${room}' before; sent anyway.\n` +
    `  a stale or typo'd id looks exactly like this and would still report woke 1/1.\n` +
    `  expected? ignore. otherwise: bb bus who ${room}`
  );
}

/**
 * A WAKE THAT CANNOT LAND NOW IS NOT A WAKE THAT FAILED (MX-228).
 *
 * `bb.sdk.threads.send` refuses a thread that is awaiting a human with HTTP 409
 * `awaiting_user_interaction`, and it refuses in EVERY mode: the guard
 * (`ensureThreadIsNotAwaitingUserInteraction`) sits both in the send route's
 * queue branch and in `sendThreadMessage` itself, so `steer`, `queue` and `auto`
 * all hit it. It is a property of the THREAD, not of the mode — `--mode auto` was
 * tried as a remedy and could never have worked.
 *
 * Three states, because two collapsed into one is the whole bug. `deferred` says
 * bb still owes the recipient this message; `failed` says nobody does.
 */
export type WakeOutcome =
  | { kind: "woke"; recipient: string }
  | { kind: "deferred"; recipient: string }
  | { kind: "failed"; recipient: string; error: string };

/**
 * Is this the refusal that means "blocked on a human", as opposed to any other
 * way a send can fail?
 *
 * POSITIVE IDENTIFICATION ONLY — anything unrecognised is `false`, and the
 * caller then treats it as a hard failure. The two directions are not
 * symmetrical: misreading a 409 as a failure reproduces the behaviour that
 * shipped for months, while misreading a hard failure as a deferral returns
 * exit 0 over a message nobody will ever deliver. Safe is "not a deferral".
 *
 * The structured fields are the real check: bb throws `BbHttpError`, which
 * carries `status: number` and `code: string` alongside the message. The string
 * path is a second, independent way to reach the same conclusion — it needs BOTH
 * the 409 and the phrase, so prose that merely mentions awaiting a user cannot
 * trip it — and exists so that a re-wrapped or serialised error (a CLI boundary,
 * a structured-clone, a future transport) still classifies rather than silently
 * degrading to `failed`.
 */
export function isAwaitingUserInteraction(e: unknown): boolean {
  const err = e as { status?: unknown; code?: unknown; message?: unknown } | null;
  if (err && typeof err === "object") {
    if (err.status === 409 && err.code === "awaiting_user_interaction") return true;
  }
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /\b409\b/.test(message) && /awaiting user interaction/i.test(message);
}

/** The text a woken thread receives. `deferredSentAt` marks a replayed message. */
export function wakeText(args: {
  room: string;
  sender: string;
  text: string;
  deferredSentAt?: string;
}): string {
  // The recipient of a deferred message has NO other way to know it was held:
  // it arrives looking freshly sent, so a status report can read as current when
  // it is hours old. The send time is stamped in rather than a duration because
  // the text is fixed when the message is queued, not when it is delivered.
  const header = args.deferredSentAt
    ? `[bus:${args.room}] message from thread ${args.sender}, sent ${args.deferredSentAt} ` +
      `while you were awaiting a human — held by bb and delivered now that you are not:`
    : `[bus:${args.room}] message from thread ${args.sender}:`;
  return (
    `${header}\n${args.text}\n\n` +
    `(Reply: \`bb bus send ${args.room} --to ${args.sender} "<text>"\` · backlog: \`bb bus recv\`)`
  );
}

/**
 * Wake one recipient, falling back to bb's own durable queue when it is blocked.
 *
 * `defer` is NOT a retry. Retrying solves nothing here — a pending interaction
 * lasts as long as it takes a human to answer, which was six hours in the
 * incident this comes from — and a bounded retry loop would only hide the state
 * behind a longer wait. It hands the message to
 * `bb.sdk.threads.queuedMessages.create`, which is bb's own store-and-replay:
 * the route has no interaction guard, and bb's `queued-message-auto-send`
 * durable-intent-retry sweep drains the queue as soon as the thread is idle
 * again. Measured live 2026-08-21: delivered within 5s of the human answering.
 *
 * The bus deliberately builds NO replay machinery of its own. A second
 * mechanism would have to be swept, expired and observed, and it could go
 * silently blind — which is the failure this ticket already is.
 */
export async function deliverWake(
  deps: { send: () => Promise<void>; defer: () => Promise<void> },
  recipient: string,
): Promise<WakeOutcome> {
  const say = (e: unknown) => (e instanceof Error ? e.message : String(e));
  try {
    await deps.send();
    return { kind: "woke", recipient };
  } catch (e) {
    if (!isAwaitingUserInteraction(e)) return { kind: "failed", recipient, error: say(e) };
    try {
      await deps.defer();
      return { kind: "deferred", recipient };
    } catch (e2) {
      // Blocked AND unqueueable. Reporting this as a deferral would be the one
      // lie worse than the original bug: exit 0 over a message with no delivery
      // path at all. Both errors ride along — the second alone reads as a queue
      // problem rather than as a blocked recipient.
      return {
        kind: "failed",
        recipient,
        error: `blocked awaiting a human, and queueing it failed: ${say(e2)} (original: ${say(e)})`,
      };
    }
  }
}

/**
 * The receipt, and the EXIT CODE — which is the part that was actually costing
 * something (MX-228).
 *
 * A deferral exits 0. That is only truthful because `deliverWake` guarantees
 * eventual delivery; without the queue fallback, exit 0 would be the "stored but
 * looks delivered" state that is worse than refusing. Coupled, they give the
 * property the call site actually needs: THE EXIT CODE SAYS WHETHER ANYONE STILL
 * OWES YOU DELIVERY, and no caller has to know what a 409 is.
 *
 * What exit 1 cost: two scheduled automations shelled a directed send, one under
 * `set -euo pipefail` and one raising on any non-zero. Three refusals each and
 * bb auto-paused them both — six hours and forty-six minutes of perimeter watch
 * off, announced nowhere. And the refusal fires precisely when the operator is
 * blocked on a question, i.e. exactly when it has escalated something and its
 * workers are most likely to be reporting.
 *
 * A hard failure still exits 1, unchanged. Mixed outcomes exit 1 and name both:
 * the deferral is still true and the sender still needs it.
 */
export function summariseDirectedSend(
  room: string,
  outcomes: WakeOutcome[],
): { stdout: string; stderr: string | null; exitCode: 0 | 1 } {
  const deferred = outcomes.filter((o) => o.kind === "deferred");
  const failed = outcomes.filter((o) => o.kind === "failed") as Extract<
    WakeOutcome,
    { kind: "failed" }
  >[];
  const woke = outcomes.length - deferred.length - failed.length;
  const head =
    `sent -> ${room}, woke ${woke}/${outcomes.length}` +
    (deferred.length ? `, QUEUED ${deferred.length}` : "");
  const lines = [head];
  for (const d of deferred) {
    lines.push(
      `bus: ${d.recipient} is awaiting a human, so nothing can wake it now — the message ` +
        `was QUEUED in bb and delivers by itself when the interaction is answered.`,
      `  A deferral, not a failure: that is why this is exit 0. ` +
        `Still queued? bb thread queue list ${d.recipient}`,
    );
  }
  return {
    stdout: lines.join("\n"),
    stderr: failed.length ? `wake failures:\n${failed.map((f) => `${f.recipient}: ${f.error}`).join("\n")}` : null,
    exitCode: failed.length ? 1 : 0,
  };
}
