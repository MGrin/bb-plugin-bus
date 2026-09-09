import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { BODY_CAP, renderEnvelope, validate, type Draft } from "./envelope.ts";

const draft = (over: Partial<Draft> = {}): Draft => ({
  kind: "report", to: "thr_abc", ref: "task:MX-838",
  fields: { status: "blocked", next: "merge #679" }, body: null, ackOf: null, ...over,
});

test("a complete report validates and carries the table's wake mode and ack flag", () => {
  const r = validate(draft());
  ok(r.ok);
  strictEqual(r.envelope.wake, "queue");
  strictEqual(r.envelope.ackRequired, false);
});

test("an unknown kind is refused and the refusal lists the twelve", () => {
  const r = validate(draft({ kind: "shout" }));
  ok(!r.ok);
  match(r.error, /shout/);
  match(r.error, /merge-ready/);
  match(r.error, /note/);
});

test("a missing required field is refused WITH the schema line, not a bare name", () => {
  const r = validate(draft({ fields: { status: "blocked" } }));
  ok(!r.ok);
  match(r.error, /next/);
  match(r.error, /report: ref, status \(working\|blocked\|done\), next/);
});

test("an UNKNOWN field is refused too — a typo'd key silently carries nothing", () => {
  const r = validate(draft({ fields: { status: "blocked", next: "x", nextt: "y" } }));
  ok(!r.ok);
  match(r.error, /nextt/);
});

test("a value outside a field's closed enum is refused and the set is printed", () => {
  const r = validate(draft({ fields: { status: "stuck", next: "x" } }));
  ok(!r.ok);
  match(r.error, /working\|blocked\|done/);
});

test("every ack-required kind comes back ackRequired and immediate", () => {
  const cases: [string, Record<string, string>][] = [
    ["handoff", { done: "a", next: "b" }],
    ["help", { blocked_on: "a" }],
    ["question", { ask: "a" }],
  ];
  for (const [kind, fields] of cases) {
    const r = validate(draft({ kind, fields }));
    ok(r.ok, kind);
    strictEqual(r.envelope.ackRequired, true, kind);
    strictEqual(r.envelope.wake, "immediate", kind);
  }
});

test("merge-ready refuses a ref that is not a pr:", () => {
  const bad = validate(draft({ kind: "merge-ready", ref: "task:MX-1", fields: { gate: "green" } }));
  ok(!bad.ok);
  match(bad.error, /pr:/);
  const good = validate(draft({ kind: "merge-ready", ref: "pr:685", fields: { gate: "green" } }));
  ok(good.ok);
});

test("a ref is required by every kind whose table row names one", () => {
  const r = validate(draft({ ref: null }));
  ok(!r.ok);
  match(r.error, /ref/);
});

test("note takes no fields and needs no ref — body only", () => {
  const r = validate(draft({ kind: "note", ref: null, fields: {}, body: "hello" }));
  ok(r.ok);
  strictEqual(r.envelope.wake, "queue");
});

test("a body at the cap passes and one character more is refused WITH THE LENGTH", () => {
  ok(validate(draft({ body: "x".repeat(BODY_CAP) })).ok);
  const r = validate(draft({ body: "x".repeat(BODY_CAP + 1) }));
  ok(!r.ok);
  match(r.error, new RegExp(String(BODY_CAP + 1)));
  match(r.error, new RegExp(String(BODY_CAP)));
});

test("the body cap has NO override — there is no token that lets a long body through", () => {
  const r = validate(draft({ body: "x".repeat(5000) }));
  ok(!r.ok);
  ok(!/OK=1/.test(r.error));
});

test("ack requires ack_of as a number and answer", () => {
  ok(validate(draft({ kind: "ack", ref: null, fields: { answer: "yes" }, ackOf: 412 })).ok);
  const r = validate(draft({ kind: "ack", ref: null, fields: { answer: "yes" }, ackOf: null }));
  ok(!r.ok);
  match(r.error, /ack_of/);
});

test("claim validates its resource against the RESOURCE vocabulary, not the ref one", () => {
  ok(validate(draft({ kind: "claim", ref: null,
    fields: { resource: "branch:main", ttl: "30m", reason: "MX-838" } })).ok);
  const r = validate(draft({ kind: "claim", ref: null,
    fields: { resource: "MX-838", ttl: "30m", reason: "x" } }));
  ok(!r.ok);
  match(r.error, /branch:/);
});

test("the injected line is one line of envelope, then the body", () => {
  const line = renderEnvelope({
    seq: 412, kind: "report", from_thread: "thr_x", ref: "task:MX-838",
    fields: JSON.stringify({ status: "blocked", next: "merge #679" }), body: null,
  });
  strictEqual(line, '[bus #412 report from thr_x] ref=task:MX-838 status=blocked next="merge #679"');
});

test("a value with no space is unquoted; one with a space is quoted", () => {
  const line = renderEnvelope({
    seq: 1, kind: "done", from_thread: "thr_x", ref: "pr:685",
    fields: JSON.stringify({ evidence: "sha 0cfa774" }), body: "shipped",
  });
  strictEqual(line, '[bus #1 done from thr_x] ref=pr:685 evidence="sha 0cfa774"\nshipped');
});

test("there is NO (Reply: …) footer — the reply verb is in the skill", () => {
  const line = renderEnvelope({
    seq: 1, kind: "note", from_thread: "thr_x", ref: null, fields: "{}", body: "hi",
  });
  ok(!/Reply:/.test(line));
});
