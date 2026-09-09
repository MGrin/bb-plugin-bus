import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { KINDS, KIND_NAMES, isKind, schemaLine, type Kind } from "./kinds.ts";

test("the vocabulary is exactly the twelve kinds of the spec, in table order", () => {
  deepStrictEqual([...KIND_NAMES], [
    "claim", "release", "handoff", "help", "merge-ready", "question",
    "report", "done", "decision", "finding", "ack", "note",
  ]);
  strictEqual(Object.keys(KINDS).length, 12);
});

test("required fields match the spec table, kind by kind", () => {
  const want: Record<Kind, string[]> = {
    claim: ["resource", "ttl", "reason"],
    release: ["resource"],
    handoff: ["ref", "done", "next"],
    help: ["ref", "blocked_on"],
    "merge-ready": ["ref", "gate"],
    question: ["ref", "ask"],
    report: ["ref", "status", "next"],
    done: ["ref", "evidence"],
    decision: ["ref", "ruling", "by"],
    finding: ["ref", "what", "filed"],
    ack: ["ack_of", "answer"],
    note: [],
  };
  for (const k of KIND_NAMES) deepStrictEqual([...KINDS[k].fields], want[k], k);
});

test("ack-required is exactly handoff, help, merge-ready, question", () => {
  const acks = KIND_NAMES.filter((k) => KINDS[k].ack);
  deepStrictEqual(acks, ["handoff", "help", "merge-ready", "question"]);
});

test("immediate wake is exactly claim and the four ack kinds; everything else queues", () => {
  deepStrictEqual(KIND_NAMES.filter((k) => KINDS[k].wake === "immediate"),
    ["claim", "handoff", "help", "merge-ready", "question"]);
  deepStrictEqual(KIND_NAMES.filter((k) => KINDS[k].wake === "queue"),
    ["release", "report", "done", "decision", "finding", "ack", "note"]);
});

test("report.status is a closed enum", () => {
  deepStrictEqual([...KINDS.report.enums!.status], ["working", "blocked", "done"]);
});

test("merge-ready's ref must be a pr:", () => {
  strictEqual(KINDS["merge-ready"].refPrefix, "pr:");
});

test("isKind refuses anything outside the twelve", () => {
  ok(isKind("handoff"));
  ok(!isKind("Handoff"));
  ok(!isKind("merge_ready"));
  ok(!isKind(""));
});

test("schemaLine names the kind and every required field, so a refusal can quote it", () => {
  strictEqual(schemaLine("report"), "report: ref, status (working|blocked|done), next");
  strictEqual(schemaLine("note"), "note: no fields (body only)");
});
