// scripts/install-shared.sh is the one command a new server runs (MX-1528). Two things in
// it can drift silently: its bb floor against package.json's engines, and its syntax.
import { strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url);
const script = new URL("scripts/install-shared.sh", root);

test("the install script's bb floor equals package.json engines.bb", () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { engines: { bb: string } };
  const floor = /^MIN_BB=(\S+)/m.exec(readFileSync(script, "utf8"))![1]!;
  strictEqual(`>=${floor.replace(/\.0$/, "")}`, pkg.engines.bb);
});

test("the install script parses (bash -n) and refuses without its two arguments", () => {
  execFileSync("bash", ["-n", script.pathname]);
  let rc = 0;
  try { execFileSync("bash", [script.pathname], { stdio: "pipe" }); } catch (e) { rc = (e as { status: number }).status; }
  strictEqual(rc, 1);
});
