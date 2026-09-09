// THE SUITE LIST IS A LIST, AND A LIST GOES STALE.
//
// package.json's `test` script names each unit test file explicitly rather than globbing,
// because a glob would sweep in live.integration.test.ts — which spawns real bb threads
// and must never run in `npm test`. That trade buys a hazard: a new src/*.test.ts is
// silently NOT RUN, and an unrun test is indistinguishable from a passing one on every
// readout there is, including CI's green check.
//
// So the list is checked against the directory. This is the only test here that is about
// the repo rather than about the bus.
import { deepStrictEqual, ok } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url);

test("every unit test file is named in package.json's test script", () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts.test!;
  const onDisk = readdirSync(new URL("src", root))
    .filter((f) => f.endsWith(".test.ts") && !f.includes(".integration."))
    .sort();
  const named = [...script.matchAll(/src\/([\w.-]+\.test\.ts)/g)].map((m) => m[1]!).sort();
  deepStrictEqual(named, onDisk,
    "package.json's test script and src/ disagree — a test file nobody runs is a test nobody has");
});

test("the live suite is NOT in the fast script, and IS in test:live", () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
    scripts: Record<string, string>;
  };
  ok(!pkg.scripts.test!.includes("integration"),
    "the live suite spawns real bb threads; it must never run in npm test");
  ok(pkg.scripts["test:live"]!.includes("live.integration.test.ts"));
});
