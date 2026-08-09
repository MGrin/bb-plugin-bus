// node --test --experimental-strip-types lib.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { fmt, parseSend, resolveRecipients } from "./lib.ts";

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
