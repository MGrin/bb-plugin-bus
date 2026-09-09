import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TTL_MS, MAX_TTL_MS, attemptClaim, heartbeat, isHeldBy, parseTtl, release } from "./claims.ts";
import type { ClaimRow } from "./store.ts";

const T0 = new Date("2026-09-09T00:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const held = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  resource: "pr:685", holder: "thr_a", reason: "MX-1",
  claimed_ts: T0.toISOString(), heartbeat_ts: T0.toISOString(),
  expires_ts: at(30).toISOString(), released_ts: null, released_by: null, stale: 0, ...over,
});

test("ttl parses m and h; default is 30m; the maximum is 4h", () => {
  strictEqual((parseTtl("30m") as { ms: number }).ms, DEFAULT_TTL_MS);
  strictEqual((parseTtl("4h") as { ms: number }).ms, MAX_TTL_MS);
  match(String((parseTtl("5h") as { error: string }).error), /4h/);
  match(String((parseTtl("soon") as { error: string }).error), /30m/);
  match(String((parseTtl("0m") as { error: string }).error), /30m/);
});

test("first holder wins: an unheld resource is held", () => {
  const r = attemptClaim({ existing: null, resource: "pr:685", holder: "thr_a",
    reason: "MX-1", ttlMs: DEFAULT_TTL_MS, now: T0 });
  ok(r.kind === "held");
  strictEqual(r.row.holder, "thr_a");
  strictEqual(r.row.expires_ts, at(30).toISOString());
  strictEqual(r.tookFrom, null);
});

test("a second claimant inside the TTL gets busy, naming holder, reason and expiry", () => {
  const r = attemptClaim({ existing: held(), resource: "pr:685", holder: "thr_b",
    reason: "MX-2", ttlMs: DEFAULT_TTL_MS, now: at(10) });
  ok(r.kind === "busy");
  strictEqual(r.holder.holder, "thr_a");
  strictEqual(r.holder.reason, "MX-1");
  strictEqual(r.holder.expires_ts, at(30).toISOString());
});

test("re-claiming what you already hold is held, not busy — it is idempotent", () => {
  const r = attemptClaim({ existing: held(), resource: "pr:685", holder: "thr_a",
    reason: "MX-1", ttlMs: DEFAULT_TTL_MS, now: at(10) });
  ok(r.kind === "held");
  strictEqual(r.tookFrom, null);
});

test("PAST EXPIRY THE ROW IS TAKEN and the new row names who lost it", () => {
  const r = attemptClaim({ existing: held(), resource: "pr:685", holder: "thr_b",
    reason: "MX-2", ttlMs: DEFAULT_TTL_MS, now: at(31) });
  ok(r.kind === "held");
  strictEqual(r.tookFrom, "thr_a");
  strictEqual(r.row.holder, "thr_b");
  strictEqual(r.row.stale, 0);
});

test("a released resource is free for anyone, and nobody lost it", () => {
  const r = attemptClaim({ existing: held({ released_ts: at(5).toISOString(), released_by: "thr_a" }),
    resource: "pr:685", holder: "thr_b", reason: "MX-2", ttlMs: DEFAULT_TTL_MS, now: at(6) });
  ok(r.kind === "held");
  strictEqual(r.tookFrom, null);
});

test("heartbeat extends expiry by the ttl from NOW and is refused to a non-holder", () => {
  const r = heartbeat({ existing: held(), holder: "thr_a", ttlMs: DEFAULT_TTL_MS, now: at(20) });
  ok("row" in r);
  strictEqual(r.row.expires_ts, at(50).toISOString());
  strictEqual(r.row.heartbeat_ts, at(20).toISOString());
  const bad = heartbeat({ existing: held(), holder: "thr_b", ttlMs: DEFAULT_TTL_MS, now: at(20) });
  ok("error" in bad);
  match(bad.error, /thr_a/);
});

test("heartbeat on an unheld resource is an error, not a silent claim", () => {
  const r = heartbeat({ existing: null, holder: "thr_a", ttlMs: DEFAULT_TTL_MS, now: T0 });
  ok("error" in r);
});

test("heartbeat on an EXPIRED claim is an error — reclaim it, do not resurrect it", () => {
  const r = heartbeat({ existing: held(), holder: "thr_a", ttlMs: DEFAULT_TTL_MS, now: at(31) });
  ok("error" in r);
  match(r.error, /bb bus claim/);
});

test("release by the holder sets released_by = holder and notifies nobody", () => {
  const r = release({ existing: held(), caller: "thr_a", force: false, reason: null, now: at(5) });
  ok("row" in r);
  strictEqual(r.row.released_by, "thr_a");
  strictEqual(r.row.released_ts, at(5).toISOString());
  strictEqual(r.notifyHolder, null);
});

test("release by a non-holder without --force is refused", () => {
  const r = release({ existing: held(), caller: "thr_b", force: false, reason: null, now: at(5) });
  ok("error" in r);
  match(r.error, /--force/);
});

test("FORCE release records the caller and NAMES THE HOLDER TO NOTIFY", () => {
  const r = release({ existing: held(), caller: "thr_b", force: true, reason: "stalled", now: at(5) });
  ok("row" in r);
  strictEqual(r.row.released_by, "thr_b");
  strictEqual(r.notifyHolder, "thr_a");
});

test("a force release needs a reason — taking someone's resource silently is the hazard", () => {
  const r = release({ existing: held(), caller: "thr_b", force: true, reason: null, now: at(5) });
  ok("error" in r);
  match(r.error, /--reason/);
});

test("releasing an unheld or already-released resource is an error, not a no-op", () => {
  ok("error" in release({ existing: null, caller: "thr_a", force: false, reason: null, now: T0 }));
  ok("error" in release({ existing: held({ released_ts: at(1).toISOString() }),
    caller: "thr_a", force: false, reason: null, now: at(2) }));
});

test("isHeldBy: true only inside the TTL, for that thread, unreleased", () => {
  ok(isHeldBy(held(), "thr_a", at(10)));
  ok(!isHeldBy(held(), "thr_b", at(10)));
  ok(!isHeldBy(held(), "thr_a", at(31)));
  ok(!isHeldBy(held({ released_ts: at(1).toISOString() }), "thr_a", at(2)));
  ok(!isHeldBy(null, "thr_a", T0));
});
