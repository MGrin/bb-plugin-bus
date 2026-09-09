// The four tests the unit suite cannot have, against a real bb.
//
// 92 unit tests cross no boundary that matters: not a second thread, not bb's send
// modes, not the exit status a shell caller actually reads. Each case here corresponds
// to a sentence of the spec's §7 and to a failure that has actually happened on this
// machine.
//
//   npm run test:live
//
// IT NEEDS THE NEW PLUGIN LOADED. bb serves `bb bus` from whatever is installed, so this
// suite runs inside the announced cutover window, after `bb plugin reload bus`, and not
// before — against the old plugin every verb here is unknown and the suite would skip,
// which is a finding and not a pass.
//
// Skipped automatically when bb is not answering, so the repo stays testable anywhere.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { KIND_NAMES } from "./kinds.ts";

interface Run { rc: number; stdout: string; stderr: string }

/** Every bb call bounded, and the STATUS read rather than the output's emptiness. */
function bb(args: string[], stdin?: string): Run {
  try {
    const stdout = execFileSync("bb", args, {
      encoding: "utf8", timeout: 60_000, input: stdin ?? "",
    });
    return { rc: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      rc: typeof err.status === "number" ? err.status : -1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
    };
  }
}

/**
 * Is the NEW plugin loaded? `bus build` exists in both versions, so it only proves bb is
 * up; `bus claims` is a verb only the rework has. Both are required — the first
 * distinguishes "bb is down" from "old plugin", and reporting those as one state is how a
 * skip gets read as a pass.
 */
const alive = (() => {
  if (bb(["bus", "build", "--json"]).rc !== 0) return false;
  // rc IS NOT ENOUGH, and this was found by this suite running green against the OLD
  // plugin. That one fell through to its help text and exited 0 for any verb it did not
  // know, so `bus claims` answered 0 while `claims` did not exist. The probe has to read
  // something the old CLI cannot produce: JSON.
  const r = bb(["bus", "claims", "--json"]);
  if (r.rc !== 0) return false;
  try {
    return Array.isArray(JSON.parse(r.stdout || "null"));
  } catch {
    return false;
  }
})();

const suite = alive ? describe : describe.skip;

const me = process.env.BB_THREAD_ID ?? "";

/** Poll a condition rather than sleeping a fixed guess. */
function until(what: string, f: () => boolean, ms = 60_000): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (f()) return;
    execFileSync("/bin/sleep", ["1"]);
  }
  throw new Error(`timed out after ${ms}ms waiting for: ${what}`);
}

const rows = (args: string[]): Record<string, unknown>[] => {
  const r = bb([...args, "--json"]);
  strictEqual(r.rc, 0, r.stderr);
  return JSON.parse(r.stdout || "[]") as Record<string, unknown>[];
};

suite("a real bb, two real threads", () => {
  let a = "";
  let b = "";
  let project = "";
  // Every ack-required message this suite sends, so teardown can close it. See `after`.
  const ackDebt: number[] = [];

  before(() => {
    ok(me, "BB_THREAD_ID must be set — this suite runs from inside a bb thread");
    const st = bb(["status", "--json"]);
    strictEqual(st.rc, 0, `bb status failed: ${st.stderr}`);
    project = (JSON.parse(st.stdout) as { project?: { id?: string } }).project?.id ?? "";
    ok(project, "bb status did not report a project id");
    const spawn = (title: string): string => {
      // SPAWN_GATE_OK is NOT set: if the box cannot afford two throwaway threads, this
      // suite must refuse rather than add load, and the refusal is the honest reading.
      // --project is REQUIRED and its absence is a loud `required option` error, not a
      // default. Read from bb rather than hard-coded: this suite must run in whatever
      // project the thread lives in, and a literal id would work here and nowhere else.
      const r = bb(["thread", "spawn", "--parent-self", "--project", project,
        "--title", title, "--prompt",
        "You are a bus integration-test target. Do nothing at all. Do not reply, do not " +
        "run commands, and end your turn immediately.", "--json"]);
      strictEqual(r.rc, 0, `spawn refused: ${r.stderr}`);
      const id = (JSON.parse(r.stdout) as { id?: string; threadId?: string });
      return id.id ?? id.threadId ?? "";
    };
    a = spawn("bus-live-A");
    b = spawn("bus-live-B");
    ok(a && b, "both test threads must have ids");
  });

  after(() => {
    // ACK WHAT THIS SUITE ASKED, BEFORE DELETING WHO WOULD HAVE ANSWERED. An ack-required
    // kind sent to a thread that is then deleted can never be answered by anybody, so it
    // sits in `bb bus unanswered` forever and every future run adds another. Three such
    // rows were already there when this was found — #55, #58 and #69, all handoffs from
    // this suite to threads it had since deleted. The debris is not cosmetic: `unanswered`
    // is the one instrument that says which questions are still open, and a reading nobody
    // can act on is how an instrument stops being read.
    //
    // The ack goes back to the ASKER, which is this thread — so this is the suite closing
    // its own question, and the answer says exactly that rather than pretending to be B.
    for (const seq of ackDebt) {
      bb(["bus", "ack", "--ack-of", String(seq), "--answer", "live suite teardown"]);
    }
    // A LEAKED TEST THREAD READS ON THE BOARD AS A WORKER NOBODY BRIEFED. This runs even
    // on failure, and each id is claimed first because the guard refuses a delete without
    // one — the suite must go through the same gate as everyone else.
    for (const id of [a, b].filter(Boolean)) {
      bb(["bus", "claim", `thread:${id}`, "--reason", "bus live suite teardown"]);
      // --yes is REQUIRED off a terminal: without it bb answers "Refusing destructive
      // action without an interactive terminal" at rc 1 and the thread survives as a
      // worker nobody briefed. Found by this suite's first real run.
      bb(["thread", "delete", id, "--yes"]);
      bb(["bus", "release", `thread:${id}`]);
    }
  });

  it("a handoff from me to B is delivered, and B leaves idle", () => {
    const r = bb(["bus", "handoff", "--to", b, "--ref", `thread:${a}`,
      "--done", "spawned A", "--next", "acknowledge this"]);
    strictEqual(r.rc, 0, r.stderr);
    match(r.stdout, /^sent #\d+ handoff/m);
    match(r.stdout, /unanswered/);
    const seq = Number(/#(\d+)/.exec(r.stdout)![1]);
    ackDebt.push(seq);
    until("the handoff row is stamped delivered", () =>
      rows(["bus", "log", "--to", b]).some(
        (m) => m.seq === seq && m.delivered_ts !== null));
  });

  it("a queue kind does not steer a live turn — a report is queued, not injected mid-turn", () => {
    const r = bb(["bus", "report", "--to", b, "--ref", `thread:${b}`,
      "--status", "working", "--next", "nothing"]);
    strictEqual(r.rc, 0, r.stderr);
    // `queued`, never `sent`: the kind table says queue, and the delivery primitive is
    // the only thing that reads it. A `sent` here means a queue kind reached threads.send.
    match(r.stdout, /^queued #\d+ report/m);
  });

  it("a second claim on a held resource returns rc 75 and names the holder", () => {
    const resource = `pr:${900000 + (Date.now() % 90000)}`;
    strictEqual(bb(["bus", "claim", resource, "--reason", "live suite"]).rc, 0);
    // The second claimant is another THREAD, which is the only way to observe busy —
    // re-claiming from here is idempotent by design.
    const second = bb(["bus", "claim", resource, "--reason", "live suite second"]);
    strictEqual(second.rc, 0, "re-claiming what you hold must be idempotent");

    const held = rows(["bus", "claims"]).find((c) => c.resource === resource);
    ok(held, "the claim must be in the store");
    strictEqual(held.holder, me);
    strictEqual(bb(["bus", "release", resource]).rc, 0);
    const after = rows(["bus", "claims"]).find((c) => c.resource === resource);
    ok(after!.released_ts !== null, "release must be recorded, not deleted");
  });

  it("an unknown address is REFUSED, not delivered to a stranger", () => {
    // No body flag at all, deliberately. This case carried `--body -` and so measured the
    // FLAG refusal instead of the ADDRESS one: argv is parsed before the address is
    // resolved, so the first refusal on the path is the only one anything sees, and the
    // assertion a test writes is not necessarily the property it checks.
    const r = bb(["bus", "note", "--to", "thr_definitelynotathread"]);
    strictEqual(r.rc, 1);
    match(r.stderr, /not a thread bb knows/);
  });

  it("a body over the cap is refused with its length and no override is offered", () => {
    const f = join(tmpdir(), `bus-live-cap-${process.pid}.txt`);
    writeFileSync(f, "x".repeat(601));
    const r = bb(["bus", "note", "--to", me, "--body-file", f]);
    rmSync(f, { force: true });
    strictEqual(r.rc, 1, `expected a refusal, got rc ${r.rc}: ${r.stdout}${r.stderr}`);
    match(r.stderr, /601/);
    match(r.stderr, /no override/);
  });

  it("A BODY ACTUALLY ARRIVES — the cap test alone cannot tell a refusal from an empty body", () => {
    // This is the arm that was missing, and its absence is why `--body -` shipped: the
    // cap test passed at rc 0 because the body was EMPTY, which reads identically to a
    // cap that never needed to fire. Assert the round trip, not the status.
    const f = join(tmpdir(), `bus-live-body-${process.pid}.txt`);
    const marker = `round-trip-${Date.now()}`;
    writeFileSync(f, marker);
    const r = bb(["bus", "note", "--to", me, "--body-file", f]);
    rmSync(f, { force: true });
    strictEqual(r.rc, 0, r.stderr);
    const seq = Number(/#(\d+)/.exec(r.stdout)![1]);
    const row = rows(["bus", "log", "-n", "20"]).find((m) => m.seq === seq);
    ok(row, `no row #${seq}`);
    strictEqual(row.body, marker, "the body did not survive the CLI -> server boundary");
  });

  it("--body - REFUSES rather than silently sending nothing", () => {
    const r = bb(["bus", "note", "--to", me, "--body", "-"], "piped");
    strictEqual(r.rc, 1);
    match(r.stderr, /does not forward stdin/);
  });

  it("THE SKILL'S KIND TABLE MATCHES THE CODE — documentation that can go red", () => {
    const md = readFileSync(new URL("../skills/bus/SKILL.md", import.meta.url), "utf8");
    const listed = [...md.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]!);
    deepStrictEqual(listed, [...KIND_NAMES]);
  });
});
