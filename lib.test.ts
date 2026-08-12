// node --test --experimental-strip-types lib.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { fmt, parseSend, resolveRecipients, validateRoom } from "./lib.ts";

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
