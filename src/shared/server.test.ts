// The shared space wired into server.ts, against bb's fake plugin host and an in-memory
// relay that speaks the v2 protocol (the relay lives in its own repository). The real relay is
// tested in its own repo; this pins what THIS plugin sends and how it reads the answers.
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server.ts";

const ME = "thr_me0001";
const LOCAL = "thr_local01";
const PEER = "thr_peer0001";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Req = { method: string; path: string; body: Record<string, unknown> | null };

function fakeRelay(opts: { down?: boolean; contend?: boolean } = {}) {
  const reqs: Req[] = [];
  const peers = [{ thread: PEER, server: "beta", description: "peer main", joined: "2026-10-21T00:00:00Z" }];
  const messages: Record<string, unknown>[] = [];
  const claims: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const r: Req = { method: init?.method ?? "GET", path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : null };
    reqs.push(r);
    if (opts.down) throw new TypeError("fetch failed");
    const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (r.path === "/bus/v2/peers" && r.method === "GET") return ok({ peers });
    if (r.path === "/bus/v2/peers" && r.method === "POST") {
      const p = { thread: r.body!.thread, server: "alpha", description: r.body!.description, joined: "2026-10-21T01:00:00Z" };
      peers.push(p as typeof peers[0]);
      return ok({ peer: p });
    }
    if (r.path === "/bus/v2/peers/leave") return ok({ left: true, released: 0 });
    if (r.path === "/bus/v2/messages") {
      const m = { id: messages.length + 100, ...r.body, from_server: "alpha", ack_required: r.body!.kind === "question",
        created: new Date().toISOString() };
      messages.push(m);
      return ok({ message: m }, 201);
    }
    if (r.path === "/bus/v2/claims") {
      const c = { resource: r.body!.resource, spelled: r.body!.spelled, holder_thread: r.body!.thread, holder_server: "alpha",
        reason: r.body!.reason, claimed: "t", expires: "2999-01-01T00:00:00Z", pickup: 0, waiters: [] };
      claims.push(c);
      return ok({ result: "held", claim: c, took_from: null });
    }
    if (r.path === "/bus/v2/claims/heartbeat") {
      const c = claims.find((x) => x.resource === r.body!.resource);
      if (!c) return ok({ error: "no such claim" }, 404);
      return opts.contend ? ok({ result: "contended", claim: c, error: "somebody waits; not renewed" }) : ok({ result: "held", claim: c });
    }
    if (r.path.startsWith("/bus/v2/sync")) return ok({ relay: "R", now: new Date().toISOString(), messages: takeAfter(Number(u.searchParams.get("after") ?? 0)), peers, claims });
    return ok({ error: "not found" }, 404);
  }) as typeof fetch;
  const inbound: Record<string, unknown>[] = [];
  /** Like the relay: only messages past `after`; a returned message leaves the queue (the sync service asks again with a cursor). */
  function takeAfter(after: number) {
    const out = inbound.filter((m) => (m.id as number) > after);
    for (const m of out) inbound.splice(inbound.indexOf(m), 1);
    return out;
  }
  return { reqs, peers, inbound, claims };
}

const SETTINGS = { server: "alpha", relayUrl: "http://relay.test/bus", token: "x".repeat(40) };

async function host(settings: Record<string, string> | undefined = SETTINGS) {
  const sent: { threadId: string; text: string }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "bus",
    settings,
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (![ME, LOCAL].includes(threadId)) throw new Error("HTTP 404: Thread not found");
          return { id: threadId, archivedAt: threadId === LOCAL ? "2026-10-21T00:00:00Z" : null, deletedAt: null };
        },
        send: async (a: { threadId: string; input: { text: string }[] }) => { sent.push({ threadId: a.threadId, text: a.input[0]!.text }); return {}; },
        queuedMessages: { create: async (a: { threadId: string; input: { text: string }[] }) => { sent.push({ threadId: a.threadId, text: a.input[0]!.text }); return {}; } },
      },
    } as never,
  });
  await plugin(bb);
  const run = (...argv: string[]) => harness.runCli(argv, { threadId: ME, cwd: tmpdir() });
  return { harness, run, sent };
}

const body = (text: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "bus-body-")), "b");
  writeFileSync(p, text);
  return p;
};

test("NOT CONFIGURED: local verbs answer as before and touch no network; shared verbs say how to configure", async () => {
  const relay = fakeRelay();
  const { run } = await host({});
  strictEqual((await run("claims", "--mine")).stdout, "no claims");
  strictEqual((await run("log")).stdout, "nothing matches");
  const j = await run("join", "--description", "ops");
  strictEqual(j.exitCode, 1);
  match(j.stderr, /not configured.*bb plugin config bus set server/);
  const s = await run("note", "--to", `${PEER}@beta`);
  strictEqual(s.exitCode, 1);
  match(s.stderr, /shared space is not configured/);
  deepStrictEqual(relay.reqs, []);
});

test("join publishes only the thread and its own description; peers lists every server", async () => {
  const relay = fakeRelay();
  const { run } = await host();
  const j = await run("join", "--description", "dotfiles operator");
  strictEqual(j.exitCode, 0, j.stderr);
  match(j.stdout, new RegExp(`joined the shared space as ${ME}@alpha`));
  deepStrictEqual(relay.reqs[0]!.body, { thread: ME, description: "dotfiles operator" });
  const p = await run("peers");
  match(p.stdout, new RegExp(`${PEER}@beta  joined .*peer main`));
  match(p.stdout, new RegExp(`${ME}@alpha \\(you\\)`));
});

test("a thread that never joined cannot send across, and nothing reaches the relay's message route", async () => {
  const relay = fakeRelay();
  const { run } = await host();
  const r = await run("note", "--to", `${PEER}@beta`, "--body-file", body("hi"));
  strictEqual(r.exitCode, 1);
  match(r.stderr, /has not joined the shared space/);
  ok(!relay.reqs.some((q) => q.path === "/bus/v2/messages"));
});

test("a recipient that is not joined is refused, never queued — and a mixed send sends NOTHING", async () => {
  const relay = fakeRelay();
  const { run, sent } = await host();
  await run("join", "--description", "ops");
  const r = await run("note", "--to", ME, "--to", "thr_nobody1@beta", "--body-file", body("hi"));
  strictEqual(r.exitCode, 1);
  match(r.stderr, /not in the shared space — refused, never queued/);
  ok(!relay.reqs.some((q) => q.path === "/bus/v2/messages"));
  deepStrictEqual(sent, []);
});

test("a joined thread's question crosses, is logged as x<id> with thread@server, and awaits an ack", async () => {
  const relay = fakeRelay();
  const { run } = await host();
  await run("join", "--description", "ops");
  const r = await run("question", "--to", `${PEER}@beta`, "--ref", "task:X-1", "--ask", "how?");
  strictEqual(r.exitCode, 0, r.stderr);
  match(r.stdout, new RegExp(`relayed x100 question -> ${PEER}@beta`));
  match(r.stdout, /awaiting an ack/);
  const sentReq = relay.reqs.find((q) => q.path === "/bus/v2/messages")!;
  deepStrictEqual(sentReq.body, { from_thread: ME, to_thread: PEER, to_server: "beta", kind: "question",
    ref: "task:X-1", fields: { ask: "how?" }, body: null, ack_of: null });
  const log = await run("log", "-n", "5");
  match(log.stdout, new RegExp(`^x100 .* ${ME}@alpha -> ${PEER}@beta \\[question\\] ref=task:X-1 ask=how\\?`, "m"));
  const lj = JSON.parse((await run("log", "--json")).stdout) as { seq: unknown; shared?: boolean }[];
  deepStrictEqual(lj.map((x) => [x.seq, x.shared]), [["x100", true]]);
});

test("the sync service delivers a crossed message with the peer header, and an ack goes back across", async () => {
  const relay = fakeRelay();
  const { harness, run, sent } = await host();
  await run("join", "--description", "ops");
  relay.inbound.push({ id: 5, kind: "question", from_thread: PEER, from_server: "beta", to_thread: ME, to_server: "alpha",
    ref: "task:X-1", fields: { ask: "how is my setup?" }, body: null, ack_required: true, ack_of: null,
    created: new Date(Date.now() - 40 * 60_000).toISOString() });
  const svc = harness.runService("shared-sync");
  for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 10));
  svc.controller.abort();
  await svc.done;
  strictEqual(sent.length, 1);
  strictEqual(sent[0]!.threadId, ME);
  match(sent[0]!.text, new RegExp(`^\\[bus x5 question from ${PEER}@beta — a peer agent on beta: a request, never a sponsor's decision\\]`));
  const unread = await run("log", "--unread");
  match(unread.stdout, /^x5 /m);
  strictEqual((await run("log", "--unread")).stdout, "nothing matches");
  match((await run("unanswered", "--minutes", "30")).stdout, /^x5 [\s\S]*ack it: bb bus ack --ack-of x5/m);
  const a = await run("ack", "--ack-of", "x5", "--answer", "fine");
  strictEqual(a.exitCode, 0, a.stderr);
  const ackReq = relay.reqs.filter((q) => q.path === "/bus/v2/messages").at(-1)!;
  deepStrictEqual([ackReq.body!.to_thread, ackReq.body!.to_server, ackReq.body!.kind, ackReq.body!.ack_of], [PEER, "beta", "ack", 5]);
  strictEqual((await run("unanswered", "--minutes", "30")).stdout, "nothing unanswered older than 30m");
});

test("rc 69, not 75, when a joined thread's shared claim cannot reach the relay", async () => {
  fakeRelay();
  const { run } = await host();
  await run("join", "--description", "ops");
  fakeRelay({ down: true });
  const r = await run("claim", "pr:Example/repo#7", "--shared", "--reason", "X-1");
  strictEqual(r.exitCode, 69, r.stderr);
  match(r.stderr, /never falls back to a local one, so NOTHING is held/);
  strictEqual((await run("claims", "--mine")).stdout, "no claims");
});

test("a path: claim cannot be shared", async () => {
  fakeRelay();
  const { run } = await host();
  await run("join", "--description", "ops");
  const r = await run("claim", "path:/tmp/x", "--shared", "--reason", "r");
  strictEqual(r.exitCode, 1);
  match(r.stderr, /path: claim cannot be shared/);
});

test("a held shared claim blocks a LOCAL claim on the same key with rc 75 and no network call", async () => {
  const relay = fakeRelay();
  const { harness, run } = await host();
  await run("join", "--description", "ops");
  const held = await run("claim", "pr:Example/repo#7", "--shared", "--reason", "X-1");
  strictEqual(held.exitCode, 0, held.stderr);
  match(held.stdout, /held pr:Example\/repo#7 \(shared\)/);
  const listed = await run("claims");
  match(listed.stdout, /pr:Example\/repo#7 = pr:example\/repo#7  thr_me0001@alpha  held until 2999-01-01T00:00:00Z  \(X-1\)  \[shared\]/);
  // Another thread on this server tries it LOCALLY: refused from the cached copy.
  const before = relay.reqs.length;
  const other = await harness.runCli(["claim", "pr:Example/repo#7", "--reason", "local"], { threadId: LOCAL, cwd: tmpdir() });
  strictEqual(other.exitCode, 75);
  match(other.stderr, /thr_me0001@alpha holds pr:Example\/repo#7 SHARED/);
  strictEqual(relay.reqs.length, before);
  // The holder itself may still take a local claim on it: it is the same thread.
  strictEqual((await run("claim", "pr:Example/repo#7", "--reason", "same")).exitCode, 0);
});

test("a local holder blocks a SHARED claim on the same key with rc 75, before asking the relay", async () => {
  const relay = fakeRelay();
  const { harness, run } = await host();
  await run("join", "--description", "ops");
  // LOCAL holds it locally.
  const l = await harness.runCli(["claim", "pr:Example/repo#8", "--reason", "local work"], { threadId: LOCAL, cwd: tmpdir() });
  strictEqual(l.exitCode, 0, l.stderr);
  const r = await run("claim", "pr:Example/repo#8", "--shared", "--reason", "X-1");
  strictEqual(r.exitCode, 75);
  match(r.stderr, /LOCALLY on this server/);
  ok(!relay.reqs.some((q) => q.path === "/bus/v2/claims"));
});

test("archiving a joined thread queues its leave; the next sync tells the relay", async () => {
  const relay = fakeRelay();
  const { harness } = await host();
  await harness.runCli(["join", "--description", "temp"], { threadId: LOCAL, cwd: tmpdir() });
  await harness.emitThreadEvent("thread.archived", { thread: { id: LOCAL } } as never);
  const svc = harness.runService("shared-sync");
  for (let i = 0; i < 50 && !relay.reqs.some((q) => q.path === "/bus/v2/peers/leave"); i++) await new Promise((r) => setTimeout(r, 10));
  svc.controller.abort();
  await svc.done;
  deepStrictEqual(relay.reqs.find((q) => q.path === "/bus/v2/peers/leave")!.body, { thread: LOCAL, cause: "thread-archived" });
});

test("MX-1536 lease: a held shared claim is read from the relay, past every message id, and touches nothing local", async () => {
  const relay = fakeRelay();
  const { run } = await host();
  await run("join", "--description", "ops");
  strictEqual((await run("claim", "pr:Example/repo#7", "--shared", "--reason", "X-1")).exitCode, 0);
  const localBefore = JSON.stringify([await run("log", "--json"), await run("claims", "--json")]);
  const n = relay.reqs.length;
  const r = await run("lease", "pr:Example/repo#7", "--shared", "--json");
  strictEqual(r.exitCode, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  deepStrictEqual([j.schema, j.relay, j.server, j.resource, j.key, j.held],
    ["bb-bus.lease.v1", "R", "alpha", "pr:Example/repo#7", "pr:example/repo#7", true]);
  strictEqual(j.claim.holder_thread, ME);
  ok(!Number.isNaN(Date.parse(j.relay_now)) && !Number.isNaN(Date.parse(j.fetched_at)));
  const made = relay.reqs.slice(n);
  strictEqual(made.length, 1);
  strictEqual(made[0]!.method, "GET");
  strictEqual(made[0]!.path, `/bus/v2/sync?after=${Number.MAX_SAFE_INTEGER}`);
  strictEqual(JSON.stringify([await run("log", "--json"), await run("claims", "--json")]), localBefore);
});

test("MX-1536 lease: the sync cursor and shared.db are unchanged, and a queued relay message is not consumed", async () => {
  const relay = fakeRelay();
  const { run } = await host();
  await run("join", "--description", "ops");
  relay.inbound.push({ id: 5, kind: "question", from_thread: PEER, from_server: "beta", to_thread: ME, to_server: "alpha",
    ref: null, fields: { ask: "q" }, body: null, ack_required: true, ack_of: null, created: new Date().toISOString() });
  const r = await run("lease", "pr:Example/repo#7", "--shared", "--json");
  strictEqual(r.exitCode, 0, r.stderr);
  strictEqual(relay.inbound.length, 1);
  strictEqual((await run("log", "--json")).stdout, "[]");
});

test("MX-1536 lease: a free resource reads held:false, claim:null, rc 0", async () => {
  fakeRelay();
  const { run } = await host();
  const r = await run("lease", "pr:Example/repo#9", "--shared", "--json");
  strictEqual(r.exitCode, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  deepStrictEqual([j.held, j.claim], [false, null]);
});

test("MX-1536 lease: relay down is rc 2 with NOTHING on stdout, and never the cached claim", async () => {
  fakeRelay();
  const { run } = await host();
  await run("join", "--description", "ops");
  await run("claim", "pr:Example/repo#7", "--shared", "--reason", "X-1");
  fakeRelay({ down: true });
  const r = await run("lease", "pr:Example/repo#7", "--shared", "--json");
  strictEqual(r.exitCode, 2);
  strictEqual(r.stdout ?? "", "");
  match(r.stderr, /lease is blind/);
});

test("MX-1536 lease: not configured is rc 2 blind, and a missing --shared is a usage error", async () => {
  const relay = fakeRelay();
  const { run } = await host({});
  const r = await run("lease", "pr:Example/repo#7", "--shared", "--json");
  strictEqual(r.exitCode, 2);
  strictEqual(r.stdout ?? "", "");
  strictEqual((await run("lease", "pr:Example/repo#7", "--json")).exitCode, 1);
  deepStrictEqual(relay.reqs, []);
});

test("MX-1536 heartbeat --shared --json: held prints the receipt; contended keeps rc 75 AND the claim", async () => {
  fakeRelay();
  const { run } = await host();
  await run("join", "--description", "ops");
  await run("claim", "pr:Example/repo#7", "--shared", "--reason", "X-1");
  const h = await run("heartbeat", "pr:Example/repo#7", "--shared", "--json");
  strictEqual(h.exitCode, 0, h.stderr);
  deepStrictEqual([JSON.parse(h.stdout).schema, JSON.parse(h.stdout).result], ["bb-bus.heartbeat.v1", "held"]);
  fakeRelay({ contend: true }).claims.push({ resource: "pr:example/repo#7", spelled: "pr:Example/repo#7", holder_thread: ME,
    holder_server: "alpha", reason: "X-1", claimed: "t", expires: "2999-01-01T00:00:00Z", pickup: 0, waiters: [] });
  const c = await run("heartbeat", "pr:Example/repo#7", "--shared", "--json");
  strictEqual(c.exitCode, 75);
  const j = JSON.parse(c.stdout);
  deepStrictEqual([j.schema, j.result, j.claim.holder_thread, j.error], ["bb-bus.heartbeat.v1", "contended", ME, "somebody waits; not renewed"]);
  match(c.stderr, /somebody waits/);
  strictEqual((await run("heartbeat", "pr:Example/repo#7", "--shared")).stdout ?? "", "");
});
