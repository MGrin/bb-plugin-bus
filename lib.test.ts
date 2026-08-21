// node --test --experimental-strip-types lib.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  PRIOR_CONTACT_SQL,
  type WakeOutcome,
  deliverWake,
  firstContactNotice,
  fmt,
  isAwaitingUserInteraction,
  parseSend,
  resolveRecipients,
  summariseDirectedSend,
  validateRoom,
  wakeText,
} from "./lib.ts";

test("a room name starting with '-' is refused, whichever flag was mistyped", () => {
  // `bb bus join --room ops` used to create a room literally called `--room`,
  // and every later `send --room ops` found it and posted there, exit 0.
  for (const bad of ["--room", "-r", "--to", "--channel"]) {
    assert.match(validateRoom(bad) ?? "", /POSITIONAL/);
  }
  assert.equal(validateRoom("ops"), null);
  assert.equal(validateRoom("vat-audit-2026"), null);
  // Only the LEADING dash is the tell; dashes inside a name are ordinary.
  assert.equal(validateRoom("a-b--c"), null);
});

test("send refuses --room instead of posting to a room called '--room'", () => {
  const a = parseSend(["send", "--room", "ops", "deploy", "is", "green"]);
  assert.match(a.error ?? "", /POSITIONAL/);
  // And it must not report the mistyped flag as a usable room.
  assert.equal(a.text, "");
});

test("the room check runs before the empty-body check", () => {
  // Otherwise `bb bus send --room ops` (no body) blames the body and the
  // caller retries with more text into the same bogus room.
  assert.match(parseSend(["send", "--room"]).error ?? "", /POSITIONAL/);
});

test("ambient send: no --to means store quietly", () => {
  const a = parseSend(["send", "ops", "deploy", "is", "green"]);
  assert.equal(a.room, "ops");
  assert.equal(a.to, null);
  assert.equal(a.text, "deploy is green");
  assert.equal(a.error, null);
});

test("--to is picked out wherever it sits, and the rest is prose", () => {
  const before = parseSend(["send", "ops", "--to", "thr_abc", "ship", "it"]);
  const after = parseSend(["send", "ops", "ship", "it", "--to", "thr_abc"]);
  assert.equal(before.to, "thr_abc");
  assert.equal(after.to, "thr_abc");
  assert.equal(before.text, "ship it");
  assert.equal(after.text, "ship it");
});

test("a dangling --to is an error, never a silent downgrade to ambient", () => {
  // The caller asked to WAKE someone. Quietly not waking them is the exact
  // failure this bus exists to prevent.
  const a = parseSend(["send", "ops", "--to"]);
  assert.match(a.error ?? "", /--to needs a thread id/);
  assert.equal(a.to, null);
});

test("empty body is refused rather than sent", () => {
  assert.match(parseSend(["send", "ops"]).error ?? "", /empty message body/);
  assert.match(parseSend(["send", "ops", "   "]).error ?? "", /empty message body/);
  assert.match(parseSend(["send", "ops", "--to", "thr_a"]).error ?? "", /empty message body/);
});

test("missing room gives usage, not a crash", () => {
  assert.match(parseSend(["send"]).error ?? "", /usage: bb bus send/);
});

test("a body STARTING with a flag-shaped token is refused, not stored with the junk", () => {
  // `bb bus send ops --message "hi"` stored the text "--message hi" and
  // delivered it. Right room, right readers, stray flag welded on. 76 messages
  // across three live rooms carried one of these before the guard existed.
  for (const bad of ["--message", "--body", "--text"]) {
    const a = parseSend(["send", "ops", bad, "the", "real", "text"]);
    assert.match(a.error ?? "", /looks like a mistyped flag/);
    assert.equal(a.text, "");
  }
});

test("`--` ends flag parsing, so a body may legitimately start with a flag", () => {
  const a = parseSend(["send", "ops", "--", "--force", "is", "what", "broke", "it"]);
  assert.equal(a.error, null);
  assert.equal(a.text, "--force is what broke it");
  // ...and --to after `--` is body text, not a wake.
  const b = parseSend(["send", "ops", "--", "pass", "--to", "review"]);
  assert.equal(b.to, null);
  assert.equal(b.text, "pass --to review");
});

test("a real --to before `--` still wakes, and `--` is not itself body text", () => {
  const a = parseSend(["send", "ops", "--to", "thr_abc", "--", "--force", "landed"]);
  assert.equal(a.to, "thr_abc");
  assert.equal(a.text, "--force landed");
});

test("prose that merely looks dashy is not mistaken for a flag", () => {
  // A markdown rule and a negative number are not mistyped flags.
  assert.equal(parseSend(["send", "ops", "---", "divider"]).error, null);
  assert.equal(parseSend(["send", "ops", "-42", "degrees"]).error, null);
});

test("flag-shaped words in the body stay in the body", () => {
  const a = parseSend(["send", "ops", "use", "--force", "on", "the", "rebase"]);
  assert.equal(a.text, "use --force on the rebase");
  assert.equal(a.to, null);
});

test("--to all wakes every OTHER member, never the sender", () => {
  const members = ["thr_me", "thr_a", "thr_b"];
  assert.deepEqual(resolveRecipients("all", members, "thr_me"), ["thr_a", "thr_b"]);
  // A thread that wakes itself never goes idle.
  assert.ok(!resolveRecipients("all", members, "thr_me").includes("thr_me"));
});

test("--to all in an empty room wakes nobody and does not throw", () => {
  assert.deepEqual(resolveRecipients("all", ["thr_me"], "thr_me"), []);
});

test("ambient resolves to no recipients at all", () => {
  assert.deepEqual(resolveRecipients(null, ["thr_a", "thr_b"], "thr_me"), []);
});

test("fmt shows the arrow only when a message was addressed", () => {
  const base = { seq: 7, room: "ops", created_ts: "2026-08-10 05:20", sender_thread: "thr_a", text: "hi" };
  assert.equal(fmt({ ...base, to_thread: null }), "#7 [ops] 2026-08-10 05:20 thr_a: hi");
  assert.equal(fmt({ ...base, to_thread: "thr_b" }), "#7 [ops] 2026-08-10 05:20 thr_a -> thr_b: hi");
});

// ---------------------------------------------------------------------------
// MX-213 — a wrong --to gets a clean success receipt.
// ---------------------------------------------------------------------------

test("first contact: an explicit id with no prior traffic in the room is flagged", () => {
  const n = firstContactNotice("thr_r9e33xniyf", "machine-config", "none");
  assert.match(n ?? "", /thr_r9e33xniyf/);
  assert.match(n ?? "", /machine-config/);
  // It is a WARNING, not a refusal: the receipt must still say the send happened,
  // or a reader will resend and double-deliver.
  assert.match(n ?? "", /sent anyway/i);
});

test("first contact stays quiet on ordinary traffic — the whole point of the signal", () => {
  // Warning on non-MEMBERSHIP was measured and killed: it fires on 62.8% of all
  // directed sends (1645 of 4423 had a member recipient, bus store 2026-08-20).
  // A recipient that has ALREADY talked in this room is the 97.8% case and must
  // produce a receipt byte-identical to today's.
  assert.equal(firstContactNotice("thr_abc", "ops", "prior"), null);
});

test("first contact says nothing when the history cannot be read (three-state)", () => {
  // A warning system that fires when BLIND is worse than one that stays quiet:
  // it is unfalsifiable, so it gets trained away exactly like the 62% one would.
  assert.equal(firstContactNotice("thr_abc", "ops", "unknown"), null);
});

test("first contact does not apply to ambient or broadcast sends", () => {
  // Ambient wakes nobody, so there is no address to be wrong about; `--to all`
  // resolves against MEMBERSHIP, which is an explicit join rather than an id
  // typed by hand. Neither shape is in the 4423 the measurement covers.
  for (const c of ["none", "prior", "unknown"] as const) {
    assert.equal(firstContactNotice(null, "ops", c), null);
    assert.equal(firstContactNotice("all", "ops", c), null);
  }
});

// The predicate itself, against a real sqlite. `firstContactNotice` is only as
// good as what it is told, and the thing that decides "prior" is SQL — which no
// amount of testing the pure function can reach.
const withBus = (rows: [string, string, string | null][]): Database.Database => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE messages (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL,
     sender_thread TEXT NOT NULL, to_thread TEXT, text TEXT NOT NULL DEFAULT '',
     created_ts TEXT NOT NULL DEFAULT (datetime('now')))`);
  const ins = db.prepare(`INSERT INTO messages (room, sender_thread, to_thread) VALUES (?,?,?)`);
  for (const r of rows) ins.run(...r);
  return db;
};
const contact = (
  db: Database.Database,
  room: string,
  id: string,
  seq = Number.MAX_SAFE_INTEGER,
): "prior" | "none" =>
  (db.prepare(PRIOR_CONTACT_SQL).get(room, seq, id, id) as { prior: number }).prior ? "prior" : "none";

test("prior contact counts BOTH directions, and only in the same room", () => {
  const db = withBus([
    ["ops", "thr_spoke", null],            // spoke into ops, ambient
    ["ops", "thr_lead", "thr_heard"],      // was addressed in ops
    ["other", "thr_elsewhere", null],      // a different room entirely
    ["ops", "thr_lead", "@all"],           // broadcast marker, not an id
  ]);
  assert.equal(contact(db, "ops", "thr_spoke"), "prior");
  assert.equal(contact(db, "ops", "thr_heard"), "prior");
  // The MX-203 shape: live thread, replies politely, zero prior traffic HERE.
  assert.equal(contact(db, "ops", "thr_stranger"), "none");
  // Room isolation — otherwise a busy peer in one room silences the check in all.
  assert.equal(contact(db, "ops", "thr_elsewhere"), "none");
  // '@all' is a marker in the to_thread column, never an address.
  assert.equal(contact(db, "ops", "@all"), "prior"); // present as a literal row
  assert.equal(contact(db, "other", "@all"), "none");
});

test("on a realistic room only the stranger is flagged, not the fleet", () => {
  // THE EXPENSIVE DIRECTION. Any mutation that makes this fire on ordinary
  // traffic — dropping the NOT, ignoring the room, checking membership instead —
  // turns 1 warning into most of them, and the channel is dead within a day.
  // Shaped after machine-config: an orchestrator briefing workers that never
  // join, then one misaddressed send to a thread with no history (msg #4828).
  const traffic: [string, string, string | null][] = [];
  const sends: [string, string][] = [];
  for (const w of ["thr_w1", "thr_w2", "thr_w3"]) {
    for (let i = 0; i < 6; i++) {
      sends.push(["fleet", w]);            // orchestrator -> worker
      traffic.push(["fleet", "thr_lead", w]);
      traffic.push(["fleet", w, "thr_lead"]); // worker replies
    }
  }
  const db = withBus([]);
  const ins = db.prepare(`INSERT INTO messages (room, sender_thread, to_thread) VALUES (?,?,?)`);
  let warned = 0;
  // Replay exactly as the server does: insert, then judge the row by its own seq.
  // A send must never count as its own prior contact — if it did, `warned` here
  // would be 0 and the check would be dead while every test still passed.
  const judge = (room: string, from: string, to: string | null): void => {
    const seq = Number(ins.run(room, from, to).lastInsertRowid);
    if (to && firstContactNotice(to, room, contact(db, room, to, seq))) warned++;
  };
  for (const [room, from, to] of traffic) judge(room, from, to);
  const before = warned;
  judge("fleet", "thr_lead", "thr_typo");
  // 36 sends to three established workers: exactly 3 first briefs, then silence.
  assert.equal(before, 3, "established peers must stop warning after their first brief");
  assert.equal(warned, 4, "the stranger must warn");
  assert.ok(warned / (traffic.length + 1) < 0.15, "warn rate must stay rare enough to read");
});

// ---------------------------------------------------------------------------
// MX-228 — a directed send to a thread that is awaiting a human
// ---------------------------------------------------------------------------

/** The error bb actually throws, reproduced from the live 409 on 2026-08-21. */
const blockedError = () =>
  Object.assign(
    new Error(
      "HTTP 409: Thread is awaiting user interaction. Resolve the pending interaction before sending another prompt.",
    ),
    { name: "BbHttpError", status: 409, code: "awaiting_user_interaction" },
  );

test("the blocked-on-a-human refusal is recognised from its structured fields", () => {
  assert.equal(isAwaitingUserInteraction(blockedError()), true);
  // Structured alone is enough: a transport that drops the message still classifies.
  assert.equal(
    isAwaitingUserInteraction({ status: 409, code: "awaiting_user_interaction" }),
    true,
  );
});

test("the message string is an independent second route to the same verdict", () => {
  // A re-wrapped or serialised error loses `status`/`code` but keeps the text.
  assert.equal(
    isAwaitingUserInteraction(
      new Error("HTTP 409: Thread is awaiting user interaction. Resolve the pending interaction."),
    ),
    true,
  );
  assert.equal(isAwaitingUserInteraction("HTTP 409: Thread is awaiting user interaction"), true);
});

test("anything not positively identified is NOT a deferral", () => {
  // The asymmetry is the point. Calling a hard failure a deferral returns exit 0
  // over a message with no delivery path; calling a 409 a failure merely
  // reproduces the old behaviour.
  for (const other of [
    new Error("HTTP 404: Thread not found"),
    new Error("HTTP 409: Thread is archived"),
    Object.assign(new Error("HTTP 409: nope"), { status: 409, code: "already_active" }),
    new Error("awaiting user interaction"), // the phrase without the status
    new Error("fetch failed"),
    null,
    undefined,
    {},
  ]) {
    assert.equal(isAwaitingUserInteraction(other), false, String(other));
  }
});

test("a blocked recipient is DEFERRED to bb's queue, not reported as a failure", async () => {
  const calls: string[] = [];
  const out = await deliverWake(
    {
      send: async () => {
        calls.push("send");
        throw blockedError();
      },
      defer: async () => {
        calls.push("defer");
      },
    },
    "thr_blocked",
  );
  assert.deepEqual(out, { kind: "deferred", recipient: "thr_blocked" });
  // The send is ATTEMPTED first, every time. Pre-checking `hasPendingInteraction`
  // would add a round trip and a race — the interaction can resolve between the
  // check and the send — for an answer the send itself already gives.
  assert.deepEqual(calls, ["send", "defer"]);
});

test("a reachable recipient is never queued", async () => {
  const calls: string[] = [];
  const out = await deliverWake(
    { send: async () => void calls.push("send"), defer: async () => void calls.push("defer") },
    "thr_awake",
  );
  assert.deepEqual(out, { kind: "woke", recipient: "thr_awake" });
  assert.deepEqual(calls, ["send"]);
});

test("a non-409 failure is not queued and stays a failure", async () => {
  const calls: string[] = [];
  const out = await deliverWake(
    {
      send: async () => {
        throw new Error("HTTP 404: Thread not found");
      },
      defer: async () => void calls.push("defer"),
    },
    "thr_gone",
  );
  assert.equal(out.kind, "failed");
  assert.match((out as { error: string }).error, /404/);
  assert.deepEqual(calls, [], "a dead thread must not accumulate queued messages");
});

test("blocked AND unqueueable is a FAILURE, and names both causes", async () => {
  // The one lie worse than the original bug would be exit 0 here.
  const out = await deliverWake(
    {
      send: async () => {
        throw blockedError();
      },
      defer: async () => {
        throw new Error("HTTP 503: queue unavailable");
      },
    },
    "thr_x",
  );
  assert.equal(out.kind, "failed");
  const err = (out as { error: string }).error;
  assert.match(err, /queueing it failed/);
  assert.match(err, /503/);
  assert.match(err, /awaiting user interaction/i, "the original cause must survive");
});

test("a deferral exits 0 — this is the whole fix", () => {
  // Two scheduled automations shelled a directed send, one under `set -euo
  // pipefail` and one raising on any non-zero. Three refusals each and bb
  // auto-paused them both, announced nowhere.
  const r = summariseDirectedSend("ops", [{ kind: "deferred", recipient: "thr_op" }]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stderr, null, "a deferral must not write to stderr either");
  assert.match(r.stdout, /QUEUED 1/);
  assert.match(r.stdout, /awaiting a human/);
  assert.match(r.stdout, /bb thread queue list thr_op/);
});

test("a deferral is distinguishable from a delivery in the receipt, not just the exit code", () => {
  const woke = summariseDirectedSend("ops", [{ kind: "woke", recipient: "thr_a" }]);
  const held = summariseDirectedSend("ops", [{ kind: "deferred", recipient: "thr_a" }]);
  assert.equal(woke.exitCode, held.exitCode, "both are exit 0 — the text must carry the difference");
  assert.equal(woke.stdout, "sent -> ops, woke 1/1");
  assert.notEqual(woke.stdout, held.stdout);
  assert.match(held.stdout, /woke 0\/1, QUEUED 1/);
});

test("a real failure still exits 1, unchanged", () => {
  const r = summariseDirectedSend("ops", [
    { kind: "failed", recipient: "thr_gone", error: "HTTP 404: Thread not found" },
  ]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr ?? "", /wake failures:\nthr_gone: HTTP 404/);
  assert.match(r.stdout, /woke 0\/1/);
});

test("mixed outcomes exit 1 and still report the deferral", () => {
  // The deferral is true whatever else went wrong, and the sender still needs it.
  const r = summariseDirectedSend("ops", [
    { kind: "woke", recipient: "thr_a" },
    { kind: "deferred", recipient: "thr_b" },
    { kind: "failed", recipient: "thr_c", error: "HTTP 404: Thread not found" },
  ] satisfies WakeOutcome[]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /woke 1\/3, QUEUED 1/);
  assert.match(r.stdout, /thr_b is awaiting a human/);
  assert.match(r.stderr ?? "", /thr_c: HTTP 404/);
});

test("a replayed message tells the recipient it was held, and when it was sent", () => {
  // Ticket item 2. A deferred message arrives looking freshly sent, so a status
  // report reads as current when it is hours old.
  const fresh = wakeText({ room: "ops", sender: "thr_a", text: "PR #12 is merged" });
  const held = wakeText({
    room: "ops",
    sender: "thr_a",
    text: "PR #12 is merged",
    deferredSentAt: "2026-08-21 09:12:03",
  });
  assert.match(fresh, /^\[bus:ops\] message from thread thr_a:\nPR #12 is merged/);
  assert.doesNotMatch(fresh, /awaiting/);
  assert.match(held, /sent 2026-08-21 09:12:03 while you were awaiting a human/);
  assert.match(held, /PR #12 is merged/);
  // Both keep the reply footer — a held message is still answerable.
  for (const t of [fresh, held]) assert.match(t, /bb bus send ops --to thr_a/);
});
