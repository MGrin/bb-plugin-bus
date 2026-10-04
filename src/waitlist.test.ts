// MX-1390: the FIFO wait list, end to end through the CLI against a fake bb host.
// Every new rule has its control beside it: the same steps with the list empty must read
// exactly as the bus did before the list existed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { createStore, type Db } from "./store.ts";
import { GRANT_PICKUP_MS } from "./claims.ts";

const A = "thr_aaaaaaaaaa", B = "thr_bbbbbbbbbb", C = "thr_cccccccccc";
const R = "pr:9";
const PAST = "2000-01-01T00:00:00.000Z";

async function host(archived: Record<string, boolean> = {}) {
  const sent: { to: string; from: string; text: string }[] = [];
  const msg = (a: { threadId: string; senderThreadId: string; input: { text: string }[] }) =>
    sent.push({ to: a.threadId, from: a.senderThreadId, text: a.input.map((i) => i.text).join("") });
  const { bb, harness } = createFakePluginHost({
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          ({ id: threadId, archivedAt: archived[threadId] ? 1 : null, deletedAt: null }),
        send: async (a: never) => { msg(a); },
        queuedMessages: { create: async (a: never) => { msg(a); } },
      },
    } as never,
  });
  await plugin(bb);
  const store = createStore(bb.storage.database() as unknown as Db);
  const as = (thread: string) => (...argv: string[]) => harness.runCli(argv, { threadId: thread, cwd: "/" });
  const claims = async () => JSON.parse((await as(A)("claims", "--json")).stdout) as
    { resource: string; holder: string; released_ts: string | null; expires_ts: string;
      waiters: { waiter: string; joined_ts: string; expires_ts: string }[] }[];
  const row = async () => (await claims()).find((c) => c.resource === R);
  const expireHolder = () => {
    const c = store.getClaim(R)!;
    store.putClaim({ ...c, expires_ts: PAST });
  };
  return { harness, store, sent, as, claims, row, expireHolder };
}

test("FALSIFIER: two waiters and one release grants the EARLIER waiter", async () => {
  const h = await host();
  assert.equal((await h.as(A)("claim", R, "--reason", "a")).exitCode, 0);
  const b = await h.as(B)("claim", R, "--reason", "b", "--wait");
  assert.equal(b.exitCode, 75);
  assert.match(b.stdout, /^waiting 1 for thr_a/);
  assert.match((await h.as(C)("claim", R, "--reason", "c", "--wait")).stdout, /^waiting 2 /);
  const rel = await h.as(A)("release", R);
  assert.match(rel.stdout, new RegExp(`granted to ${B}`));
  const r = (await h.row())!;
  assert.equal(r.holder, B);
  assert.deepEqual(r.waiters.map((w) => w.waiter), [C]);
  assert.ok(h.sent.some((m) => m.to === B && /GRANTED/.test(m.text)), "the grant reached B as a bus event");
  assert.ok(!h.sent.some((m) => m.to === C && /GRANTED/.test(m.text)));
});

test("CONTROL: with the list empty a release frees the slot and grants nobody", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  const rel = await h.as(A)("release", R);
  assert.equal(rel.stdout, `released ${R}`);
  assert.notEqual((await h.row())!.released_ts, null);
  assert.ok(!h.sent.some((m) => /GRANTED/.test(m.text)));
  assert.equal((await h.as(C)("claim", R, "--reason", "c")).exitCode, 0);
});

test("a plain claim on a held resource is still rc 75 at once, and does NOT queue", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  const c = await h.as(C)("claim", R, "--reason", "c");
  assert.equal(c.exitCode, 75);
  assert.match(c.stdout, /^busy thr_a/);
  assert.deepEqual((await h.row())!.waiters, []);
});

test("an expired claim goes to the head of the list, so a newcomer cannot jump it", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b", "--wait");
  h.expireHolder();
  const c = await h.as(C)("claim", R, "--reason", "c");
  assert.equal(c.exitCode, 75);
  assert.match(c.stdout, new RegExp(`^busy ${B}`));
  assert.ok(h.sent.some((m) => m.to === A && /granted to thr_b/.test(m.text)), "the expired holder is told");
});

test("CONTROL: an expired claim with nobody waiting is taken by the next claimant, as before", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  h.expireHolder();
  const c = await h.as(C)("claim", R, "--reason", "c");
  assert.equal(c.exitCode, 0);
  assert.match(c.stdout, /taken from thr_a/);
});

test("a waiter past its --max-wait is dropped, so a dead waiter cannot hold the list", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b", "--wait", "--max-wait", "1h");
  const w = h.store.waiters(R)[0]!;
  h.store.removeWaiter(R, B);
  h.store.addWaiter({ ...w, expires_ts: PAST });
  await h.as(A)("release", R);
  assert.notEqual((await h.row())!.released_ts, null, "nobody was granted");
  assert.deepEqual(h.store.waiters(R), []);
});

test("CONTROL: a waiter inside its --max-wait is granted", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b", "--wait", "--max-wait", "1h");
  await h.as(A)("release", R);
  assert.equal((await h.row())!.holder, B);
});

test("an ARCHIVED waiter's place is dropped when bb confirms the archive", async () => {
  const h = await host({ [B]: true });
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b", "--wait");
  await h.harness.emitThreadEvent("thread.archived", { thread: { id: B } } as never);
  assert.deepEqual(h.store.waiters(R), []);
});

test("CONTROL: an archive event bb does not confirm keeps the waiter", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b", "--wait");
  await h.harness.emitThreadEvent("thread.archived", { thread: { id: B } } as never);
  assert.deepEqual(h.store.waiters(R).map((w) => w.waiter), [B]);
});

test("an archived HOLDER's slot passes to the head of the list", async () => {
  const h = await host({ [A]: true });
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b", "--wait");
  await h.harness.emitThreadEvent("thread.archived", { thread: { id: A } } as never);
  assert.equal(h.store.getClaim(R)!.holder, B);
});

test("a grant holds only a pickup window; the waiter's re-claim takes its full ttl", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b", "--wait", "--ttl", "2h");
  await h.as(A)("release", R);
  const g = h.store.getClaim(R)!;
  assert.equal(Date.parse(g.expires_ts) - Date.parse(g.claimed_ts), GRANT_PICKUP_MS);
  const re = await h.as(B)("claim", R, "--reason", "b", "--ttl", "2h");
  assert.equal(re.exitCode, 0);
  const t = h.store.getClaim(R)!;
  assert.equal(Date.parse(t.expires_ts) - Date.parse(t.claimed_ts), 2 * 3_600_000);
});

test("re-running --wait keeps the FIRST place and wakes the holder only once", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b", "--wait");
  await h.as(C)("claim", R, "--reason", "c", "--wait");
  const toA = h.sent.filter((m) => m.to === A).length;
  assert.match((await h.as(B)("claim", R, "--reason", "b", "--wait")).stdout, /^waiting 1 /);
  assert.equal(h.sent.filter((m) => m.to === A).length, toA);
});

test("a waiter leaves the list with release, and the holder keeps its claim", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b", "--wait");
  assert.match((await h.as(B)("release", R)).stdout, /left the wait list/);
  assert.deepEqual(h.store.waiters(R), []);
  assert.equal(h.store.getClaim(R)!.holder, A);
  assert.equal(h.store.getClaim(R)!.released_ts, null);
});

test("claims shows each waiter, its place and since when", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b", "--wait");
  const out = (await h.as(A)("claims")).stdout;
  assert.match(out, new RegExp(`\\n    waiting 1\\. ${B} since \\d{4}-\\d\\d-\\d\\dT[^ ]+Z  gives up `));
  assert.equal((await h.row())!.waiters[0]!.waiter, B);
});

test("an expiry nobody touches is granted by the server's own timer", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b", "--wait");
  const c = h.store.getClaim(R)!;
  h.store.putClaim({ ...c, expires_ts: new Date(Date.now() + 200).toISOString() });
  await h.as(C)("claims"); // re-arms against the new expiry
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(h.store.getClaim(R)!.holder, B);
  assert.ok(h.sent.some((m) => m.to === B && /GRANTED/.test(m.text)));
});

test("CONTROL: with nobody waiting the timer arms nothing and an expiry stays EXPIRED", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  const c = h.store.getClaim(R)!;
  h.store.putClaim({ ...c, expires_ts: new Date(Date.now() + 200).toISOString() });
  await h.as(C)("claims");
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(h.store.getClaim(R)!.holder, A);
  assert.equal(h.store.getClaim(R)!.released_ts, null);
});

test("--max-wait without --wait is refused, not silently ignored", async () => {
  const h = await host();
  const r = await h.as(A)("claim", R, "--reason", "a", "--max-wait", "1h");
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /only means something with --wait/);
});

test("--wait on a FREE resource with nobody waiting is held at once, rc 0", async () => {
  const h = await host();
  const r = await h.as(B)("claim", R, "--reason", "b", "--wait");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /^held /);
});

// ── MX-1394: no renewal while anyone waits ─────────────────────────────────────────────

test("MX-1394: a heartbeat on a claim somebody waits for is refused rc 75, naming the waiter", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  const before = h.store.getClaim(R)!.expires_ts;
  await h.as(B)("claim", R, "--reason", "b", "--wait");
  const hb = await h.as(A)("heartbeat", R);
  assert.equal(hb.exitCode, 75);
  assert.match(hb.stderr, new RegExp(`1 waiting .*1\\. ${B} since`));
  assert.equal(h.store.getClaim(R)!.expires_ts, before, "the expiry did not move");
});

test("MX-1394 CONTROL: with nobody waiting a heartbeat extends, as before", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  const before = h.store.getClaim(R)!.heartbeat_ts;
  await new Promise((r) => setTimeout(r, 5));
  const hb = await h.as(A)("heartbeat", R);
  assert.equal(hb.exitCode, 0);
  assert.notEqual(h.store.getClaim(R)!.heartbeat_ts, before);
});

test("MX-1394: a holder's re-claim is a renewal too, and refused while anyone waits", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a", "--ttl", "30m");
  const before = h.store.getClaim(R)!.expires_ts;
  await h.as(B)("claim", R, "--reason", "b", "--wait");
  const re = await h.as(A)("claim", R, "--reason", "a", "--ttl", "4h");
  assert.equal(re.exitCode, 75);
  assert.match(re.stderr, /not renewed/);
  assert.equal(h.store.getClaim(R)!.expires_ts, before);
});

test("MX-1394 CONTROL: with nobody waiting a holder's re-claim is idempotent, as before", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  assert.equal((await h.as(A)("claim", R, "--reason", "a", "--ttl", "2h")).exitCode, 0);
});

test("MX-1394: a granted waiter may still CONFIRM its pickup while others wait — once", async () => {
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b", "--wait", "--ttl", "1h");
  await h.as(C)("claim", R, "--reason", "c", "--wait");
  await h.as(A)("release", R);
  assert.equal(h.store.getClaim(R)!.pickup, 1);
  const hb = await h.as(B)("heartbeat", R);
  assert.equal(hb.exitCode, 75, "a heartbeat cannot stretch a pickup");
  const ok1 = await h.as(B)("claim", R, "--reason", "b", "--ttl", "1h");
  assert.equal(ok1.exitCode, 0);
  assert.equal(h.store.getClaim(R)!.pickup, 0);
  const again = await h.as(B)("claim", R, "--reason", "b", "--ttl", "4h");
  assert.equal(again.exitCode, 75, "the confirm is the only renewal");
});

// MX-1400: a PLAIN busy claim tells the holder once per (claimant, holder claim). Each test
// names the mutant it kills.
const fromTo = (h: { sent: { to: string; from: string }[] }, from: string, to: string) =>
  h.sent.filter((m) => m.from === from && m.to === to).length;
const tick = () => new Promise((r) => setTimeout(r, 5));

test("MX-1400: N polled plain claims wake the holder ONCE, each still rc 75 with the same output", async () => {
  // Kills: posting on every busy attempt (the pre-MX-1400 code) — 5 messages, not 1.
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await h.as(C)("claim", R, "--reason", "c"));
  assert.equal(fromTo(h, C, A), 1);
  for (const r of runs) {
    assert.equal(r.exitCode, 75);
    assert.equal(r.stdout, runs[0].stdout);
    assert.equal(r.stderr, runs[0].stderr);
  }
});

test("MX-1400: a NEW holder claim resets it — release and re-take, and expiry and take", async () => {
  // Kills: "told" read across all time instead of since the holder's claimed_ts.
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(C)("claim", R, "--reason", "c");
  await h.as(C)("claim", R, "--reason", "c");
  assert.equal(fromTo(h, C, A), 1);
  await h.as(A)("release", R);
  await tick();
  await h.as(A)("claim", R, "--reason", "a again");
  await h.as(C)("claim", R, "--reason", "c");
  await h.as(C)("claim", R, "--reason", "c");
  assert.equal(fromTo(h, C, A), 2, "a re-take is a new holder claim: told once more");
  h.expireHolder();
  await tick();
  assert.equal((await h.as(B)("claim", R, "--reason", "b")).exitCode, 0);
  await h.as(C)("claim", R, "--reason", "c");
  await h.as(C)("claim", R, "--reason", "c");
  assert.equal(fromTo(h, C, B), 1, "the expiry's taker is told once");
});

test("MX-1400: two different claimants each tell the holder once", async () => {
  // Kills: "told" read from ANY claimant's messages (the from filter dropped).
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  for (let i = 0; i < 3; i++) {
    await h.as(B)("claim", R, "--reason", "b");
    await h.as(C)("claim", R, "--reason", "c");
  }
  assert.equal(fromTo(h, B, A), 1);
  assert.equal(fromTo(h, C, A), 1);
});

test("MX-1400 CONTROL: one claimant polling two held resources tells the holder once for EACH", async () => {
  // Kills: "told" ignoring which resource the message was about.
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(A)("claim", "pr:10", "--reason", "a");
  for (let i = 0; i < 2; i++) {
    await h.as(C)("claim", R, "--reason", "c");
    await h.as(C)("claim", "pr:10", "--reason", "c");
  }
  assert.equal(fromTo(h, C, A), 2);
});

test("MX-1400: the --wait path still tells the holder on joining, after a plain claim already did", async () => {
  // Kills: gating the --wait join notification on the new "already told" check — 1, not 2.
  // And a re-run of --wait, or a later plain poll, still adds nothing.
  const h = await host();
  await h.as(A)("claim", R, "--reason", "a");
  await h.as(B)("claim", R, "--reason", "b");
  assert.equal(fromTo(h, B, A), 1);
  assert.equal((await h.as(B)("claim", R, "--reason", "b", "--wait")).exitCode, 75);
  assert.equal(fromTo(h, B, A), 2);
  await h.as(B)("claim", R, "--reason", "b", "--wait");
  await h.as(B)("claim", R, "--reason", "b");
  assert.equal(fromTo(h, B, A), 2);
});
