// node --test --experimental-strip-types lib.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { PRIOR_CONTACT_SQL, firstContactNotice, fmt, parseSend, resolveRecipients, validateRoom } from "./lib.ts";

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
