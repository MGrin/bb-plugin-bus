import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Db } from "../store.ts";
import { RelayRefused, RelayUnreachable, type RelayClient, type RelayMessage, type SyncResult } from "./relay.ts";
import { attachShared, createSharedStore } from "./store.ts";
import { syncOnce } from "./sync.ts";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const m = (id: number, over: Partial<RelayMessage> = {}): RelayMessage => ({
  id, kind: "question", from_thread: "thr_m", from_server: "beta", to_thread: "thr_o", to_server: "alpha",
  ref: "task:FL-1", fields: { ask: "?" }, body: null, ack_required: true, ack_of: null,
  created: "2026-10-21T11:59:00.000Z", ...over,
});

function setup(pages: SyncResult[] | Error, opts: { leave?: (t: string) => Promise<unknown> } = {}) {
  const db = new Database(":memory:");
  attachShared(db as unknown as Db, ":memory:");
  const store = createSharedStore(db as unknown as Db);
  const afters: number[] = [];
  const left: string[] = [];
  const client = {
    async sync(after: number) {
      afters.push(after);
      if (pages instanceof Error) throw pages;
      return pages.shift() ?? { relay: "r1", now: "", messages: [], peers: [], claims: [] };
    },
    async leave(t: string) { left.push(t); return opts.leave ? opts.leave(t) : { left: true, released: 0 }; },
  } as unknown as RelayClient;
  const delivered: number[] = [];
  const warnings: string[] = [];
  const run = (deliver: (id: number) => boolean = () => true) => syncOnce({
    client, store, myServer: "alpha", now: () => NOW, warn: (w) => warnings.push(w),
    deliver: async (row) => { delivered.push(row.relay_id); return deliver(row.relay_id) ? { ok: true } : { ok: false, error: "nope" }; },
  });
  return { store, afters, delivered, warnings, left, run };
}
const page = (messages: RelayMessage[], over: Partial<SyncResult> = {}): SyncResult =>
  ({ relay: "r1", now: "", messages, peers: [], claims: [], ...over });

test("messages addressed here are stored and delivered once; the cursor advances", async () => {
  const s = setup([page([m(1), m(2)]), page([])]);
  deepStrictEqual(await s.run(), { stored: 2, delivered: 2, failed: 0 });
  await s.run();
  deepStrictEqual(s.afters, [0, 2]);
  deepStrictEqual(s.delivered, [1, 2]);
});

test("a message THIS server sent is stored for the log, never delivered back", async () => {
  const s = setup([page([m(1, { from_thread: "thr_o", from_server: "alpha", to_thread: "thr_m", to_server: "beta" })])]);
  deepStrictEqual(await s.run(), { stored: 1, delivered: 0, failed: 0 });
  strictEqual(s.store.getMessage(1)!.delivered_ts, "2026-10-21T11:59:00.000Z");
});

test("a fresh store never re-delivers history older than an hour before its first sync", async () => {
  const s = setup([page([m(1, { created: "2026-10-21T10:00:00.000Z" }), m(2)])]);
  deepStrictEqual(await s.run(), { stored: 2, delivered: 1, failed: 0 });
  deepStrictEqual(s.delivered, [2]);
});

test("a failed delivery is retried on the next sync, and given up after five", async () => {
  const s = setup([page([m(1)])]);
  for (let i = 0; i < 7; i++) await s.run(() => false);
  deepStrictEqual(s.delivered, [1, 1, 1, 1, 1]);
  strictEqual(s.store.getMessage(1)!.last_error, "nope");
});

test("peers and claims are replaced from every sync", async () => {
  const peer = { thread: "thr_m", server: "beta", description: "peer", joined: "t" };
  const s = setup([page([], { peers: [peer] }), page([], { peers: [] })]);
  await s.run();
  deepStrictEqual(s.store.peers(), [peer]);
  await s.run();
  deepStrictEqual(s.store.peers(), []);
});

test("a replaced relay database restarts the cursor rather than skipping its messages", async () => {
  const s = setup([page([m(7)]), page([], { relay: "r2" }), page([m(1, { created: NOW.toISOString() })], { relay: "r2" })]);
  await s.run();
  await s.run();
  deepStrictEqual(s.afters, [0, 7, 0]);
  strictEqual(s.warnings.length, 1);
});

test("an unreachable relay throws, and the pending leave stays pending", async () => {
  const s = setup(new RelayUnreachable("down"), { leave: async () => { throw new RelayUnreachable("down"); } });
  s.store.addPendingLeave("thr_gone", "thread-archived", "t");
  await rejects(s.run(), RelayUnreachable);
  deepStrictEqual(s.store.pendingLeaves().map((p) => p.thread), ["thr_gone"]);
});

test("a pending leave is flushed once the relay answers, even with a refusal", async () => {
  const s = setup([page([])], { leave: async () => { throw new RelayRefused(404, "not joined"); } });
  s.store.addPendingLeave("thr_gone", "thread-archived", "t");
  await s.run();
  deepStrictEqual(s.left, ["thr_gone"]);
  deepStrictEqual(s.store.pendingLeaves(), []);
});
