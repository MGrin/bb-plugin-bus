import { match, notStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { prKey, validateRef, validateResource } from "./refs.ts";

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

test("thread: is CLAIMABLE — a thread delete is one of the four acts the protocol covers", () => {
  // This was the omission: `thread:` was a ref and not a resource, so `bb bus claim
  // thread:thr_x` refused, and the live suite's teardown had been claiming into a refusal
  // on every run without noticing because it ignores the rc. It becomes load-bearing when
  // cc-guard's bus_claim_required lands — that rule REFUSES a thread delete without a
  // claim, and an unclaimable resource would make the verb unusable.
  strictEqual(validateResource("thread:thr_abc123"), null);
  match(String(validateResource("thread:")), /names nothing/);
});

test("pr: must be a number — pr:main is the shape that reached a stranger", () => {
  strictEqual(validateResource("pr:685"), null);
  match(String(validateResource("pr:main")), /number/);
});

// MX-1312: a PR in another repo is claimable, and every spelling of one PR is ONE key.
test("pr:<owner>/<repo>#<n> is a claimable resource and a ref", () => {
  strictEqual(validateResource("pr:MGrin/bb-plugin-bus#27"), null);
  strictEqual(validateRef("pr:MGrin/bb-plugin-bus#27"), null);
});

test("a pr: that is neither a number nor owner/repo#n is still refused", () => {
  for (const bad of ["pr:bb-plugin-bus-27", "pr:MGrin/bb-plugin-bus", "pr:MGrin/bb-plugin-bus#",
                     "pr:bb-plugin-bus#27", "pr:MGrin/bb-plugin-bus#27x", "pr:a/b/c#1"]) {
    match(String(validateResource(bad)), /number .*or <owner>\/<repo>#<n>/, bad);
  }
});

test("prKey: a dotfiles PR in either spelling is the bare key", () => {
  strictEqual(prKey("pr:685"), "pr:685");
  strictEqual(prKey("pr:MGrin/dotfiles#685"), "pr:685");
  strictEqual(prKey("pr:mgrin/DOTFILES#685"), "pr:685");
});

test("prKey: another repo keeps its repo, lower-cased, and differs from a same-number dotfiles PR", () => {
  strictEqual(prKey("pr:MGrin/bb-plugin-bus#27"), "pr:mgrin/bb-plugin-bus#27");
  strictEqual(prKey("pr:mgrin/BB-PLUGIN-BUS#27"), "pr:mgrin/bb-plugin-bus#27");
  notStrictEqual(prKey("pr:MGrin/bb-plugin-bus#27"), prKey("pr:27"));
});
