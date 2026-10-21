// THE CONTRACT, against the REAL relay (MX-1528). Two plugin instances in bb's fake host —
// two "servers" — talk through a real relay process on loopback, so a disagreement between
// this client and the relay's protocol goes red here rather than on a live server.
//
//   BUS_RELAY_PY=<path to relay.py> BUS_RELAY_SERVERS=<a>,<b>,<c> npm run test:relay
//
// The relay is not in this repo, and its server names are its own; both come from the
// environment. Without them the suite SKIPS, and a skip is a finding, not a pass.
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { randomBytes } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server.ts";

const PY = process.env.BUS_RELAY_PY ?? "";
const NAMES = (process.env.BUS_RELAY_SERVERS ?? "").split(",").filter(Boolean);
const suite = PY && NAMES.length >= 3 ? describe : describe.skip;

async function startRelay(): Promise<{ url: string; tokens: Record<string, string>; proc: ChildProcess }> {
  const dir = mkdtempSync(join(tmpdir(), "bus-relay-"));
  const tokens = Object.fromEntries(NAMES.map((n) => [n, randomBytes(32).toString("base64url")]));
  const tf = join(dir, "tokens");
  writeFileSync(tf, Object.entries(tokens).map(([k, v]) => `${k}=${v}\n`).join(""));
  chmodSync(tf, 0o600);
  const proc = spawn("python3", [PY, "--port", "0", "--db", join(dir, "relay.db"), "--tokens", tf], { stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise<number>((res, rej) => {
    let err = "";
    proc.stderr!.on("data", (b: Buffer) => {
      err += b.toString();
      const m = /on 127\.0\.0\.1:(\d+)/.exec(err);
      if (m) res(Number(m[1]));
    });
    proc.on("exit", () => rej(new Error(`relay exited: ${err}`)));
  });
  return { url: `http://127.0.0.1:${port}`, tokens, proc };
}

async function server(name: string, url: string, token: string) {
  const sent: { threadId: string; text: string }[] = [];
  const deliver = async (a: { threadId: string; input: { text: string }[] }) => { sent.push({ threadId: a.threadId, text: a.input[0]!.text }); return {}; };
  const { bb, harness } = createFakePluginHost({
    pluginId: "bus",
    settings: { server: name, relayUrl: url, token },
    sdk: { threads: { get: async ({ threadId }: { threadId: string }) => ({ id: threadId, archivedAt: null, deletedAt: null }),
      send: deliver, queuedMessages: { create: deliver } } } as never,
  });
  await plugin(bb);
  const as = (thread: string) => (...argv: string[]) => harness.runCli(argv, { threadId: thread, cwd: tmpdir() });
  /** One pass of the sync service: run it until `until` holds, then stop it. */
  const sync = async (until: () => boolean) => {
    const svc = harness.runService("shared-sync");
    for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 10));
    svc.controller.abort();
    await svc.done;
    ok(until(), "the sync never produced what was expected");
  };
  return { as, sent, sync };
}

suite("two servers through the real relay", () => {
  let relay: Awaited<ReturnType<typeof startRelay>>;
  let A: Awaited<ReturnType<typeof server>>;
  let B: Awaited<ReturnType<typeof server>>;
  const [na, nb, nc] = NAMES as [string, string, string];
  const OP = "thr_operator1", MARCO = "thr_marcomain", SHY = "thr_neverjoined";

  before(async () => {
    relay = await startRelay();
    A = await server(na, relay.url, relay.tokens[na]!);
    B = await server(nb, relay.url, relay.tokens[nb]!);
  });
  after(() => { relay?.proc.kill(); });

  it("both join; each sees the other in the peer list the relay serves", async () => {
    strictEqual((await A.as(OP)("join", "--description", "operator")).exitCode, 0);
    strictEqual((await B.as(MARCO)("join", "--description", "main")).exitCode, 0);
    const p = await A.as(OP)("peers");
    match(p.stdout, new RegExp(`${MARCO}@${nb}  joined .*main`));
    match(p.stdout, new RegExp(`${OP}@${na} \\(you\\)`));
  });

  it("a thread that never joined cannot be reached from the other server", async () => {
    const r = await B.as(MARCO)("question", "--to", `${SHY}@${na}`, "--ref", "task:X-1", "--ask", "hello?");
    strictEqual(r.exitCode, 1);
    match(r.stderr, /not in the shared space/);
    ok(!(await B.as(MARCO)("peers")).stdout.includes(SHY));
  });

  it("§8: a question crosses, lands marked as a peer's request, and the ack lands back", async () => {
    const q = await B.as(MARCO)("question", "--to", `${OP}@${na}`, "--ref", "task:X-1", "--ask", "how is my setup?");
    strictEqual(q.exitCode, 0, q.stderr);
    const id = /relayed x(\d+)/.exec(q.stdout)![1]!;
    await A.sync(() => A.sent.length > 0);
    strictEqual(A.sent[0]!.threadId, OP);
    match(A.sent[0]!.text, new RegExp(`^\\[bus x${id} question from ${MARCO}@${nb} — a peer agent on ${nb}: a request, never a sponsor's decision\\] ref=task:X-1 ask="how is my setup\\?"`));
    const a = await A.as(OP)("ack", "--ack-of", `x${id}`, "--answer", "all good");
    strictEqual(a.exitCode, 0, a.stderr);
    await B.sync(() => B.sent.length > 0);
    strictEqual(B.sent[0]!.threadId, MARCO);
    match(B.sent[0]!.text, new RegExp(`^\\[bus x\\d+ ack from ${OP}@${na}`));
    // Both servers' logs show the exchange.
    for (const s of [A.as(OP), B.as(MARCO)]) {
      const log = (await s("log", "--json")).stdout;
      const kinds = (JSON.parse(log) as { kind: string; shared?: boolean }[]).filter((m) => m.shared).map((m) => m.kind);
      deepStrictEqual(kinds, ["question", "ack"]);
    }
  });

  it("a third server's token reads NONE of it", async () => {
    const r = await fetch(`${relay.url}/v2/sync?after=0`, { headers: { authorization: `Bearer ${relay.tokens[nc]}` } });
    const j = (await r.json()) as { messages: unknown[] };
    deepStrictEqual(j.messages, []);
  });

  it("shared claims: first holder wins, a second server waits, a release grants it across", async () => {
    const R = "pr:Example/repo#7";
    strictEqual((await A.as(OP)("claim", R, "--shared", "--reason", "merging")).exitCode, 0);
    const busy = await B.as(MARCO)("claim", R, "--shared", "--reason", "mine");
    strictEqual(busy.exitCode, 75);
    match(busy.stdout, new RegExp(`^busy ${OP}@${na} merging`));
    const w = await B.as(MARCO)("claim", R, "--shared", "--reason", "mine", "--wait");
    strictEqual(w.exitCode, 75);
    match(w.stdout, /^waiting 1 for/);
    // A's server sees B waiting, from its own copy, after a sync.
    await A.sync(() => (A.sent.some((s) => s.text.includes("waiting #1"))));
    const rel = await A.as(OP)("release", R, "--shared");
    strictEqual(rel.exitCode, 0, rel.stderr);
    match(rel.stdout, new RegExp(`granted to ${MARCO}@${nb}`));
    await B.sync(() => B.sent.some((s) => /GRANTED to you/.test(s.text)));
    // A local claim on A's server now meets B's shared hold, with no network call.
    await A.sync(() => true);
    const local = await A.as("thr_otherlocal")("claim", R, "--reason", "local");
    strictEqual(local.exitCode, 75);
    match(local.stderr, new RegExp(`${MARCO}@${nb} holds ${R.replace(/[/#]/g, "\\$&")} SHARED`));
  });

  it("with the relay gone, a shared claim is rc 69 and a local one still works", async () => {
    relay.proc.kill();
    await new Promise((r) => setTimeout(r, 200));
    const r = await A.as(OP)("claim", "pr:Example/repo#9", "--shared", "--reason", "x");
    strictEqual(r.exitCode, 69, r.stderr);
    strictEqual((await A.as(OP)("claim", "task:X-9", "--reason", "x")).exitCode, 0);
  });
});
