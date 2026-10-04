// The claim state machine, as pure functions over a row and a clock. Spec §4.
//
// This is what replaces "announce an action BEFORE taking it". An announcement had no
// holder, no TTL and no arbitration: measured 2026-08-29, two were sent in one block,
// one landed, one returned `did not respond`, and the unreached party duplicated the
// work seven seconds later. A dropped announcement is indistinguishable from an agreed
// one, so you act believing you deconflicted. A claim refuses.
//
// EVERY FUNCTION TAKES `now`. There is no Date.now() in this file, which is what makes
// expiry and heartbeat testable without waiting thirty minutes for the answer.
import type { ClaimRow } from "./store.ts";

export const DEFAULT_TTL_MS = 30 * 60_000;
export const MAX_TTL_MS = 4 * 60 * 60_000;

export function parseTtl(s: string): { ms: number } | { error: string } {
  const m = /^(\d+)(m|h)$/.exec(s.trim());
  const bad = { error: `bus: '${s}' is not a ttl — write it as 30m or 2h (default 30m, maximum 4h)` };
  if (!m) return bad;
  const n = Number(m[1]);
  if (n <= 0) return bad;
  const ms = n * (m[2] === "h" ? 3_600_000 : 60_000);
  if (ms > MAX_TTL_MS) {
    return { error: `bus: a ttl of ${s} is longer than the maximum 4h — a claim nobody renews should expire` };
  }
  return { ms };
}

/** Live = not released and not past its expiry. The one predicate everything reads. */
const live = (c: ClaimRow, now: Date): boolean =>
  c.released_ts === null && now.getTime() < Date.parse(c.expires_ts);

/**
 * THE PREDICATE cc-guard REIMPLEMENTS IN RUST, and the reason it is a named export
 * rather than an inline condition. The Rust copy is asserted against these same five
 * cases; two spellings of one rule is the drift this codebase is otherwise built to
 * avoid, and the only defence is that both are pinned to the same list.
 */
export const isHeldBy = (row: ClaimRow | null, thread: string, now: Date): boolean =>
  row !== null && row.holder === thread && live(row, now);

export type ClaimOutcome =
  | { kind: "held"; row: ClaimRow; tookFrom: string | null }
  | { kind: "busy"; holder: ClaimRow };

export function attemptClaim(a: {
  existing: ClaimRow | null;
  resource: string;
  holder: string;
  reason: string;
  ttlMs: number;
  now: Date;
}): ClaimOutcome {
  const iso = a.now.toISOString();
  const expires = new Date(a.now.getTime() + a.ttlMs).toISOString();
  const row: ClaimRow = {
    resource: a.resource, holder: a.holder, reason: a.reason,
    claimed_ts: iso, heartbeat_ts: iso, expires_ts: expires,
    released_ts: null, released_by: null, stale: 0,
  };
  if (a.existing && live(a.existing, a.now)) {
    // Re-claiming what you already hold is idempotent — a worker that re-runs its own
    // brief must not lock itself out of the thing it is holding.
    if (a.existing.holder === a.holder) return { kind: "held", row, tookFrom: null };
    return { kind: "busy", holder: a.existing };
  }
  // PAST EXPIRY THE ROW IS TAKEN, AND THE LOSS IS NAMED. Spec §4: stale is flagged,
  // never silently dropped. `tookFrom` is what the caller writes onto a `claim` message
  // addressed to the displaced holder — the ledger has to show who lost it, or an
  // expiry is indistinguishable from a resource nobody ever wanted.
  const tookFrom = a.existing && a.existing.released_ts === null ? a.existing.holder : null;
  return { kind: "held", row, tookFrom };
}

export function heartbeat(a: {
  existing: ClaimRow | null;
  holder: string;
  ttlMs: number;
  now: Date;
}): { row: ClaimRow } | { error: string } {
  if (!a.existing || a.existing.released_ts !== null) {
    return { error: `bus: nothing to heartbeat — that resource is not held. bb bus claim <resource> --reason <r>` };
  }
  if (a.existing.holder !== a.holder) {
    return { error: `bus: ${a.existing.holder} holds that, not you — a heartbeat cannot take a claim` };
  }
  if (!live(a.existing, a.now)) {
    // An expired claim is not renewed, it is re-taken. Renewing it would let a holder
    // that stopped heartbeating reach back past a successor who has already started.
    return { error: `bus: that claim expired at ${a.existing.expires_ts} — bb bus claim <resource> --reason <r> to take it again` };
  }
  const iso = a.now.toISOString();
  return {
    row: { ...a.existing, heartbeat_ts: iso,
           expires_ts: new Date(a.now.getTime() + a.ttlMs).toISOString() },
  };
}

export function release(a: {
  existing: ClaimRow | null;
  caller: string;
  force: boolean;
  reason: string | null;
  now: Date;
}): { row: ClaimRow; notifyHolder: string | null } | { error: string } {
  if (!a.existing || a.existing.released_ts !== null) {
    return { error: `bus: that resource is not held, so there is nothing to release` };
  }
  const mine = a.existing.holder === a.caller;
  if (!mine && !a.force) {
    return { error: `bus: ${a.existing.holder} holds that until ${a.existing.expires_ts}. ` +
      `To take it anyway: bb bus release ${a.existing.resource} --force --reason '<why>'` };
  }
  // A FORCE NEEDS A REASON. Taking someone else's resource silently is the hazard the
  // whole claim mechanism exists to close, and a force with no reason recreates it one
  // level up: the ledger shows the resource changed hands and cannot say why.
  if (!mine && !a.reason) {
    return { error: `bus: --force needs --reason '<why>' — a forced release with no reason is a claim nobody can audit` };
  }
  const iso = a.now.toISOString();
  return {
    row: { ...a.existing, released_ts: iso, released_by: a.caller },
    notifyHolder: mine ? null : a.existing.holder,
  };
}

// ── THE WAIT LIST (MX-1390) ────────────────────────────────────────────────────────────
//
// Without one a released slot went to whoever polled first. Measured 2026-10-02 on
// path:~/.local/state/box-cpu-hog: a 25-minute e2e run blocking two merges waited while a
// thread that arrived later took a fresh ~90-minute claim one minute after a release, and
// the operator relayed the slot by hand four times in one day. `claim --wait` joins a FIFO
// list; a release or an expiry GRANTS the slot to the head, and nobody can jump the list
// while anyone is on it.

/** How long a waiter stays on the list unless it says otherwise — then it is dropped. */
export const DEFAULT_MAX_WAIT_MS = 2 * 60 * 60_000;

/**
 * A GRANT IS HELD FOR AT MOST TEN MINUTES UNTIL THE WAITER CONFIRMS IT. A waiter whose
 * thread went idle is still a row on the list, and granting it a 3-hour claim would rebuild
 * the exact incident this list exists to close — 2026-10-02T15:16Z, a 3h claim held by a
 * thread reading idle. The grant wakes the waiter; re-running its claim takes the full ttl.
 */
export const GRANT_PICKUP_MS = 10 * 60_000;

export interface WaiterRow {
  resource: string;
  waiter: string;
  reason: string;
  /** The ttl the waiter asked for; the confirming re-claim takes it. */
  ttl_ms: number;
  spelled: string;
  joined_ts: string;
  /** The waiter is dropped from the list at this time (--max-wait). */
  expires_ts: string;
}

const waiting = (w: WaiterRow, now: Date): boolean => now.getTime() < Date.parse(w.expires_ts);

/**
 * Who gets a free slot. `waiters` is in join order. Returns null when the resource is
 * still live, or when nobody (unexpired) waits — which is exactly today's behaviour.
 */
export function settle(a: {
  existing: ClaimRow | null;
  waiters: readonly WaiterRow[];
  now: Date;
}): { grant: WaiterRow; row: ClaimRow; tookFrom: string | null } | null {
  if (a.existing && live(a.existing, a.now)) return null;
  const head = a.waiters.find((w) => waiting(w, a.now));
  if (!head) return null;
  const iso = a.now.toISOString();
  const row: ClaimRow = {
    resource: head.resource, holder: head.waiter, reason: head.reason,
    claimed_ts: iso, heartbeat_ts: iso,
    expires_ts: new Date(a.now.getTime() + Math.min(head.ttl_ms, GRANT_PICKUP_MS)).toISOString(),
    released_ts: null, released_by: null, stale: 0, spelled: head.spelled, pickup: 1,
  };
  const tookFrom = a.existing && a.existing.released_ts === null ? a.existing.holder : null;
  return { grant: head, row, tookFrom };
}

/** Join the list, or keep the place you already have: a re-run brief must not lose it. */
export function joinWaitList(a: {
  waiters: readonly WaiterRow[];
  resource: string;
  spelled: string;
  waiter: string;
  reason: string;
  ttlMs: number;
  maxWaitMs: number;
  now: Date;
}): { row: WaiterRow; position: number; joined: boolean } {
  const queue = a.waiters.filter((w) => waiting(w, a.now));
  const i = queue.findIndex((w) => w.waiter === a.waiter);
  if (i >= 0) return { row: queue[i]!, position: i + 1, joined: false };
  const row: WaiterRow = {
    resource: a.resource, waiter: a.waiter, reason: a.reason, ttl_ms: a.ttlMs,
    spelled: a.spelled, joined_ts: a.now.toISOString(),
    expires_ts: new Date(a.now.getTime() + a.maxWaitMs).toISOString(),
  };
  return { row, position: queue.length + 1, joined: true };
}

/**
 * NO RENEWAL WHILE ANYONE WAITS (MX-1394). A contended claim is held for the ttl its holder
 * asked for and no longer: on 2026-10-02T15:16Z a 3-hour claim sat on box-cpu-hog with its
 * thread reading idle while a 15-minute run waited, and a heartbeat or a re-claim is how a
 * hold like that is extended. Both are refused while the list is non-empty.
 *
 * The ONE exception is a grant's pickup: the waiter re-claiming to take its own ttl is not a
 * renewal, it is the claim it queued for. With nobody waiting this returns null, which is the
 * bus as it was.
 */
export function renewalRefused(a: {
  existing: ClaimRow | null;
  waiters: readonly WaiterRow[];
  caller: string;
  /** A re-claim may confirm a pickup; a heartbeat never can. */
  confirming: boolean;
  now: Date;
}): string | null {
  if (!a.existing || a.existing.holder !== a.caller || !live(a.existing, a.now)) return null;
  if (a.confirming && a.existing.pickup === 1) return null;
  const q = a.waiters.filter((w) => waiting(w, a.now));
  if (!q.length) return null;
  const who = q.map((w, i) => `${i + 1}. ${w.waiter} since ${w.joined_ts}`).join(", ");
  return `bus: ${q.length} waiting for ${a.existing.spelled ?? a.existing.resource} (${who}), so it is not ` +
    `renewed — a contended claim lasts the ttl you asked for, until ${a.existing.expires_ts}. ` +
    `Finish and release it: bb bus release ${a.existing.spelled ?? a.existing.resource}`;
}

/**
 * Has `claimant` already told the holder of this claim that it wants the slot? (MX-1400)
 *
 * A plain busy claim wakes the holder; a claimant that polls instead of passing --wait
 * woke it on EVERY attempt — seven identical wakes for one wait on 2026-10-04. So a busy
 * claim tells each claimant's holder once per HOLDER CLAIM, and "once" is derived from the
 * message rows the bus already keeps rather than from a table of its own: any `claim`
 * message from the claimant to the holder, about the same key, written at or after the
 * holder's `claimed_ts`. A release and re-take or an expiry and take writes a new
 * `claimed_ts`, so it resets on its own. A --wait join counts: the holder already knows.
 *
 * A GRANT does not count. It is sent as from the holder whose claim lapsed, and that
 * thread wanting the slot back is news to the new holder.
 */
export function holderAlreadyTold(a: {
  holder: ClaimRow;
  sent: { fields: string; created_ts: string }[];
  keyOf: (spelled: string) => string | null;
}): boolean {
  return a.sent.some((m) => {
    if (m.created_ts < a.holder.claimed_ts) return false;
    let f: { resource?: unknown; reason?: unknown };
    try { f = JSON.parse(m.fields); } catch { return false; }
    if (typeof f.reason === "string" && f.reason.startsWith("GRANTED")) return false;
    return typeof f.resource === "string" && a.keyOf(f.resource) === a.holder.resource;
  });
}
