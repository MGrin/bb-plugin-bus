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
