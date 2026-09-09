import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS, createStore, type Db } from "./store.ts";
import { validate, type Draft } from "./envelope.ts";

const fresh = () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  return { db, store: createStore(db as unknown as Db) };
};

const env = (over: Partial<Draft> = {}) => {
  const r = validate({
    kind: "report", to: "thr_b", ref: "task:MX-1",
    fields: { status: "working", next: "keep going" }, body: null, ackOf: null, ...over,
  });
  ok(r.ok, r.ok ? "" : r.error);
  return r.envelope;
};

test("there is no rooms table, no members table and no cursors table", () => {
  const { db } = fresh();
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
    .map((r) => r.name).filter((n) => !n.startsWith("sqlite_"));
  deepStrictEqual(names.sort(), ["claims", "messages"]);
});

test("seq is assigned by the store and rises", () => {
  const { store } = fresh();
  strictEqual(store.insertMessage("thr_a", env(), "2026-09-09T00:00:00Z"), 1);
  strictEqual(store.insertMessage("thr_a", env(), "2026-09-09T00:00:01Z"), 2);
});

test("ack_required is stored from the ENVELOPE, never from the caller", () => {
  const { store } = fresh();
  store.insertMessage("thr_a", env({ kind: "help", fields: { blocked_on: "x" } }), "t");
  strictEqual(store.log({ limit: 10 })[0]!.ack_required, 1);
});

test("delivered_ts and read_ts start NULL and are set by their own methods", () => {
  const { store } = fresh();
  const seq = store.insertMessage("thr_a", env(), "t0");
  strictEqual(store.log({ limit: 1 })[0]!.delivered_ts, null);
  store.markDelivered(seq, "t1");
  strictEqual(store.log({ limit: 1 })[0]!.delivered_ts, "t1");
  strictEqual(store.markReadFor("thr_b", "t2"), 1);
  strictEqual(store.log({ limit: 1 })[0]!.read_ts, "t2");
});

test("markReadFor touches only rows addressed to that thread, and only unread ones", () => {
  const { store } = fresh();
  store.insertMessage("thr_a", env({ to: "thr_b" }), "t0");
  store.insertMessage("thr_a", env({ to: "thr_c" }), "t0");
  strictEqual(store.markReadFor("thr_b", "t1"), 1);
  strictEqual(store.markReadFor("thr_b", "t2"), 0);
});

test("log filters compose: kind, ref, from, to, since", () => {
  const { store } = fresh();
  store.insertMessage("thr_a", env({ kind: "note", ref: null, fields: {}, body: "n" }), "2026-01-01T00:00:00Z");
  store.insertMessage("thr_a", env({ ref: "task:MX-2" }), "2026-02-01T00:00:00Z");
  strictEqual(store.log({ kind: "note", limit: 10 }).length, 1);
  strictEqual(store.log({ ref: "task:MX-2", limit: 10 }).length, 1);
  strictEqual(store.log({ from: "thr_a", limit: 10 }).length, 2);
  strictEqual(store.log({ to: "thr_b", limit: 10 }).length, 2);
  strictEqual(store.log({ since: "2026-01-15T00:00:00Z", limit: 10 }).length, 1);
});

test("log --unread is rows addressed to me with no read_ts", () => {
  const { store } = fresh();
  store.insertMessage("thr_a", env({ to: "thr_b" }), "t0");
  strictEqual(store.log({ unread: "thr_b", limit: 10 }).length, 1);
  store.markReadFor("thr_b", "t1");
  strictEqual(store.log({ unread: "thr_b", limit: 10 }).length, 0);
});

test("log returns oldest-first while the LIMIT keeps the NEWEST", () => {
  const { store } = fresh();
  for (let i = 1; i <= 5; i++) store.insertMessage("thr_a", env(), `2026-01-0${i}T00:00:00Z`);
  deepStrictEqual(store.log({ limit: 2 }).map((r) => r.seq), [4, 5]);
});

test("unanswered is ack-required rows older than N minutes with no ack pointing at them", () => {
  const { store } = fresh();
  const now = new Date("2026-09-09T01:00:00Z");
  const old = "2026-09-09T00:00:00Z";
  const recent = "2026-09-09T00:50:00Z";
  const a = store.insertMessage("thr_a", env({ kind: "help", fields: { blocked_on: "x" } }), old);
  store.insertMessage("thr_a", env({ kind: "help", fields: { blocked_on: "y" } }), recent);
  store.insertMessage("thr_a", env(), old);
  deepStrictEqual(store.unanswered(30, now).map((r) => r.seq), [a]);
});

test("an ack clears its target from unanswered", () => {
  const { store } = fresh();
  const now = new Date("2026-09-09T01:00:00Z");
  const a = store.insertMessage("thr_a", env({ kind: "question", fields: { ask: "?" } }), "2026-09-09T00:00:00Z");
  strictEqual(store.unanswered(30, now).length, 1);
  store.insertMessage("thr_b", env({ kind: "ack", ref: null, fields: { answer: "yes" }, ackOf: a }), "2026-09-09T00:30:00Z");
  strictEqual(store.unanswered(30, now).length, 0);
});

test("unanswered is oldest first", () => {
  const { store } = fresh();
  const now = new Date("2026-09-09T05:00:00Z");
  const later = store.insertMessage("thr_a", env({ kind: "help", fields: { blocked_on: "b" } }), "2026-09-09T02:00:00Z");
  const older = store.insertMessage("thr_a", env({ kind: "help", fields: { blocked_on: "a" } }), "2026-09-09T01:00:00Z");
  deepStrictEqual(store.unanswered(30, now).map((r) => r.seq), [older, later]);
});

test("claims.resource is a PRIMARY KEY — the same resource cannot hold two rows", () => {
  const { db, store } = fresh();
  store.putClaim({ resource: "pr:685", holder: "thr_a", reason: "MX-1", claimed_ts: "t",
    heartbeat_ts: "t", expires_ts: "t2", released_ts: null, released_by: null, stale: 0 });
  throws(() => db.prepare(
    `INSERT INTO claims (resource,holder,reason,claimed_ts,heartbeat_ts,expires_ts,stale) VALUES (?,?,?,?,?,?,0)`,
  ).run("pr:685", "thr_b", "x", "t", "t", "t2"));
});

test("putClaim REPLACES, so a stale row is taken over rather than colliding", () => {
  const { store } = fresh();
  const row = { resource: "pr:685", holder: "thr_a", reason: "MX-1", claimed_ts: "t",
    heartbeat_ts: "t", expires_ts: "t2", released_ts: null, released_by: null, stale: 0 };
  store.putClaim(row);
  store.putClaim({ ...row, holder: "thr_b" });
  strictEqual(store.getClaim("pr:685")!.holder, "thr_b");
});

test("listClaims --mine and --stale filter independently", () => {
  const { store } = fresh();
  store.putClaim({ resource: "pr:1", holder: "thr_a", reason: "r", claimed_ts: "t",
    heartbeat_ts: "t", expires_ts: "t2", released_ts: null, released_by: null, stale: 0 });
  store.putClaim({ resource: "pr:2", holder: "thr_b", reason: "r", claimed_ts: "t",
    heartbeat_ts: "t", expires_ts: "t2", released_ts: null, released_by: null, stale: 1 });
  strictEqual(store.listClaims({ mine: "thr_a" }).length, 1);
  strictEqual(store.listClaims({ stale: true }).length, 1);
  strictEqual(store.listClaims({}).length, 2);
});

test("getClaim on an unknown resource is null, not undefined", () => {
  const { store } = fresh();
  strictEqual(store.getClaim("pr:999"), null);
});
