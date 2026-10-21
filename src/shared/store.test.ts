import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS, createStore, type Db } from "../store.ts";
import { MAX_ATTEMPTS, attachShared, createSharedStore, sharedPathFor } from "./store.ts";
import type { RelayMessage } from "./relay.ts";

const msg = (over: Partial<RelayMessage> = {}): RelayMessage => ({
  id: 1, kind: "question", from_thread: "thr_m", from_server: "beta", to_thread: "thr_o", to_server: "alpha",
  ref: "task:FL-1", fields: { ask: "how?" }, body: null, ack_required: true, ack_of: null,
  created: "2026-10-21T10:00:00.000Z", ...over,
});

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "bus-shared-"));
  const db = new Database(join(dir, "data.db"));
  for (const m of MIGRATIONS) db.exec(m);
  attachShared(db as unknown as Db, sharedPathFor(db as unknown as Db));
  return { dir, db, s: createSharedStore(db as unknown as Db), done: () => { db.close(); rmSync(dir, { recursive: true }); } };
};

test("THE SHARED STORE IS A SEPARATE FILE: data.db holds none of its tables or rows", () => {
  const { dir, db, s, done } = fresh();
  s.putMessage(msg({ body: "SECRET-ONLY-IN-SHARED" }), true);
  const mainTables = (db.prepare(`SELECT name FROM main.sqlite_master WHERE type='table'`).all() as { name: string }[])
    .map((r) => r.name).filter((n) => !n.startsWith("sqlite_") && n !== "_bb_migrations");
  deepStrictEqual(mainTables.sort(), ["claim_waiters", "claims", "messages"]);
  db.close();
  // Read data.db alone, the way `mx state backup` does: the row must not be in it.
  const solo = new Database(join(dir, "data.db"), { readonly: true });
  strictEqual((solo.prepare(`SELECT count(*) n FROM sqlite_master WHERE sql LIKE '%SECRET%'`).get() as { n: number }).n, 0);
  strictEqual((solo.prepare(`SELECT count(*) n FROM messages`).get() as { n: number }).n, 0);
  solo.close();
  const other = new Database(join(dir, "shared.db"), { readonly: true });
  strictEqual((other.prepare(`SELECT body FROM messages`).get() as { body: string }).body, "SECRET-ONLY-IN-SHARED");
  other.close();
  rmSync(dir, { recursive: true });
  void s;
});

test("a message is stored once per relay id; a repeat sync is a no-op", () => {
  const { s, done } = fresh();
  strictEqual(s.putMessage(msg(), true), true);
  strictEqual(s.putMessage(msg(), true), false);
  strictEqual(s.getMessage(1)!.ack_required, 1);
  done();
});

test("only deliverable rows addressed to THIS server are offered for delivery, at most MAX_ATTEMPTS times", () => {
  const { s, done } = fresh();
  s.putMessage(msg({ id: 1 }), true);
  s.putMessage(msg({ id: 2 }), false); // backfill: stored, never delivered
  s.putMessage(msg({ id: 3, from_server: "alpha", from_thread: "thr_o", to_server: "beta", to_thread: "thr_m" }), false);
  deepStrictEqual(s.undelivered("alpha").map((r) => r.relay_id), [1]);
  for (let i = 0; i < MAX_ATTEMPTS; i++) s.markFailed(1, "thread gone");
  deepStrictEqual(s.undelivered("alpha"), []);
  strictEqual(s.getMessage(1)!.last_error, "thread gone");
  done();
});

test("log filters by kind, ref, thread@server and unread, newest N oldest-first", () => {
  const { s, done } = fresh();
  s.putMessage(msg({ id: 1, created: "2026-10-21T10:00:01Z" }), true);
  s.putMessage(msg({ id: 2, kind: "ack", ack_of: 1, ack_required: false, fields: { answer: "x" },
    from_thread: "thr_o", from_server: "alpha", to_thread: "thr_m", to_server: "beta", created: "2026-10-21T10:00:02Z" }), false);
  deepStrictEqual(s.log({ limit: 10 }, "alpha").map((r) => r.relay_id), [1, 2]);
  deepStrictEqual(s.log({ kind: "ack", limit: 10 }, "alpha").map((r) => r.relay_id), [2]);
  deepStrictEqual(s.log({ to: "thr_o", limit: 10 }, "alpha").map((r) => r.relay_id), [1]);
  deepStrictEqual(s.log({ from: "thr_m@beta", limit: 10 }, "alpha").map((r) => r.relay_id), [1]);
  deepStrictEqual(s.log({ unread: "thr_o", limit: 10 }, "alpha").map((r) => r.relay_id), [1]);
  strictEqual(s.markReadFor("thr_o", "alpha", "t"), 1);
  deepStrictEqual(s.log({ unread: "thr_o", limit: 10 }, "alpha"), []);
  deepStrictEqual(s.log({ limit: 1 }, "alpha").map((r) => r.relay_id), [2]);
  done();
});

test("unanswered: ack-required crossed rows with no crossed ack", () => {
  const { s, done } = fresh();
  s.putMessage(msg({ id: 1 }), true);
  s.putMessage(msg({ id: 5, created: "2026-10-21T10:00:00.000Z" }), true);
  s.putMessage(msg({ id: 6, kind: "ack", ack_of: 5, ack_required: false, fields: { answer: "y" } }), false);
  deepStrictEqual(s.unanswered(30, new Date("2026-10-21T11:00:00Z")).map((r) => r.relay_id), [1]);
  done();
});

test("peers, claims, joined, pending leaves and meta round-trip", () => {
  const { s, done } = fresh();
  s.setPeers([{ thread: "thr_m", server: "beta", description: "marco", joined: "t" }]);
  deepStrictEqual(s.peers().map((p) => p.thread), ["thr_m"]);
  s.setPeers([]);
  deepStrictEqual(s.peers(), []);
  s.setClaims([{ resource: "pr:a/b#1", spelled: "pr:a/b#1", holder_thread: "thr_m", holder_server: "beta",
    reason: "r", claimed: "t0", expires: "2999-01-01T00:00:00Z", pickup: 0, waiters: [] }]);
  strictEqual(s.claim("pr:a/b#1")!.holder_server, "beta");
  strictEqual(s.claim("pr:nope"), null);
  s.join("thr_o", "ops", "t");
  ok(s.joined("thr_o"));
  deepStrictEqual(s.joinedAll().map((j) => j.thread), ["thr_o"]);
  s.leave("thr_o");
  strictEqual(s.joined("thr_o"), null);
  s.addPendingLeave("thr_o", "thread-archived", "t");
  deepStrictEqual(s.pendingLeaves().map((p) => p.thread), ["thr_o"]);
  s.removePendingLeave("thr_o");
  deepStrictEqual(s.pendingLeaves(), []);
  s.setMeta("cursor", "41");
  strictEqual(s.getMeta("cursor"), "41");
  strictEqual(s.getMeta("absent"), null);
  done();
});

test("an in-memory main database gets an in-memory shared one (the fake host's case)", () => {
  const db = new Database(":memory:");
  strictEqual(sharedPathFor(db as unknown as Db), ":memory:");
  attachShared(db as unknown as Db, ":memory:");
  createSharedStore(db as unknown as Db).setMeta("k", "v");
  db.close();
  void createStore;
});
