import { match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { validateRef, validateResource } from "./refs.ts";

test("a well-formed ref of every prefix is accepted", () => {
  for (const r of ["task:MX-838", "pr:685", "path:setup/lib/x.py", "thread:thr_abc123", "store:memory"]) {
    strictEqual(validateRef(r), null, r);
  }
});

test("an unprefixed ref is refused and the message lists the prefixes", () => {
  const e = validateRef("MX-838");
  match(String(e), /task:/);
  match(String(e), /pr:/);
  match(String(e), /store:/);
});

test("an unknown prefix is refused rather than passed through", () => {
  match(String(validateRef("issue:12")), /issue:/);
});

test("an empty value after the prefix is refused — 'task:' names nothing", () => {
  match(String(validateRef("task:")), /empty/);
});

test("store: takes only the three stores", () => {
  strictEqual(validateResource("store:memory"), null);
  strictEqual(validateResource("store:tasks"), null);
  strictEqual(validateResource("store:bus"), null);
  match(String(validateResource("store:disk")), /memory\|tasks\|bus/);
});

test("resource has its own vocabulary: branch: is a resource, not a ref", () => {
  strictEqual(validateResource("branch:main"), null);
  match(String(validateRef("branch:main")), /branch:/);
});

test("pr: must be a number — pr:main is the shape that reached a stranger", () => {
  strictEqual(validateResource("pr:685"), null);
  match(String(validateResource("pr:main")), /number/);
});
