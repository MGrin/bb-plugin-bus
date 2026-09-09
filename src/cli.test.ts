import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, parseClaim, parseLog, parseSend, parseSugar } from "./cli.ts";
import { KIND_NAMES } from "./kinds.ts";

test("THE SUGAR VERBS ARE GENERATED — every kind has a verb and none is hand-written", () => {
  const names = COMMANDS.map((c) => c.name);
  for (const k of KIND_NAMES) ok(names.includes(k), `no verb for ${k}`);
  for (const v of ["send", "log", "unanswered", "claims", "heartbeat", "build"]) {
    ok(names.includes(v), `no verb ${v}`);
  }
});

test("a sugar verb's usage line is derived from its schema line", () => {
  const u = COMMANDS.find((c) => c.name === "report")!.usage;
  match(u, /--status/);
  match(u, /--next/);
  match(u, /--ref/);
});

test("a field with an underscore becomes a dashed flag in the usage line", () => {
  match(COMMANDS.find((c) => c.name === "help")!.usage, /--blocked-on/);
  match(COMMANDS.find((c) => c.name === "ack")!.usage, /--ack-of/);
});

test("the deleted verbs are gone: join, leave, rooms, who, recv", () => {
  const names = COMMANDS.map((c) => c.name);
  for (const dead of ["join", "leave", "rooms", "who", "recv"]) {
    ok(!names.includes(dead), `${dead} still exists`);
  }
});

test("send parses kind, to, ref and repeated --field k=v", () => {
  const p = parseSend(["send", "--kind", "report", "--to", "thr_b", "--ref", "task:MX-1",
    "--field", "status=blocked", "--field", "next=merge #679"]);
  strictEqual(p.error, null);
  strictEqual(p.kind, "report");
  strictEqual(p.to, "thr_b");
  deepStrictEqual(p.fields, { status: "blocked", next: "merge #679" });
});

test("a value containing = keeps everything after the FIRST one", () => {
  const p = parseSend(["send", "--kind", "note", "--to", "thr_b", "--field", "x=a=b"]);
  deepStrictEqual(p.fields, { x: "a=b" });
});

test("A BODY ON ARGV IS REFUSED — the 2026-08-15 double-quote incident is closed by the CLI", () => {
  const p = parseSend(["send", "--kind", "note", "--to", "thr_b", "hello there"]);
  match(String(p.error), /--body-file/);
  match(String(p.error), /2026-08-15/);
  // The remedy must show the QUOTED heredoc: an unquoted one still substitutes, and
  // that is the half of the incident a bare "use a file" would leave open.
  match(String(p.error), /<<'MSG'/);
});

test("--body - IS REFUSED BY NAME — bb does not forward stdin to a plugin CLI", () => {
  // It shipped for an hour and stored an EMPTY body at rc 0, telling the sender it
  // worked. Removing it silently would leave every existing caller sending nothing, so
  // it refuses and says why.
  for (const v of ["-", "hi"]) {
    const e = String(parseSend(["send", "--kind", "note", "--to", "thr_b", "--body", v]).error);
    match(e, /does not forward stdin/);
    match(e, /--body-file/);
  }
});

test("--body-file names a path and is the ONLY body source", () => {
  const p = parseSend(["send", "--kind", "note", "--to", "thr_b", "--body-file", "/tmp/x"]);
  deepStrictEqual(p.bodySource, { kind: "file", path: "/tmp/x" });
});

test("--field without an = is refused, naming the k=v shape", () => {
  match(String(parseSend(["send", "--kind", "note", "--to", "thr_b", "--field", "status"]).error), /k=v/);
});

test("a missing --to is refused: there is no ambient send any more", () => {
  match(String(parseSend(["send", "--kind", "note"]).error), /--to/);
});

test("a missing --kind is refused", () => {
  match(String(parseSend(["send", "--to", "thr_b"]).error), /--kind/);
});

test("a flag with no value is refused rather than degrading to a missing one", () => {
  match(String(parseSend(["send", "--kind", "note", "--to"]).error), /--to/);
});

test("sugar: bb bus report --to X --ref R --status S --next N is the same envelope as send", () => {
  const sugar = parseSugar("report", ["report", "--to", "thr_b", "--ref", "task:MX-1",
    "--status", "blocked", "--next", "merge #679"]);
  const full = parseSend(["send", "--kind", "report", "--to", "thr_b", "--ref", "task:MX-1",
    "--field", "status=blocked", "--field", "next=merge #679"]);
  strictEqual(sugar.error, null);
  deepStrictEqual({ ...sugar }, { ...full });
});

test("sugar refuses a flag that is not one of its kind's fields", () => {
  match(String(parseSugar("report", ["report", "--to", "thr_b", "--ref", "task:MX-1",
    "--status", "blocked", "--next", "n", "--gate", "green"]).error), /gate/);
});

test("sugar maps a dashed flag back to its underscored field name", () => {
  const p = parseSugar("help", ["help", "--to", "thr_b", "--ref", "task:MX-1", "--blocked-on", "#679"]);
  strictEqual(p.error, null);
  deepStrictEqual(p.fields, { blocked_on: "#679" });
});

test("ack takes --ack-of as a number and may omit --to", () => {
  const p = parseSugar("ack", ["ack", "--ack-of", "412", "--answer", "yes"]);
  strictEqual(p.error, null);
  strictEqual(p.ackOf, 412);
  strictEqual(p.to, null);
});

test("--ack-of that is not a number is refused", () => {
  match(String(parseSugar("ack", ["ack", "--ack-of", "soon", "--answer", "y"]).error), /number/);
});

test("log filters parse, and -n is capped", () => {
  const f = parseLog(["log", "--kind", "report", "--ref", "task:MX-1", "-n", "5000"]);
  ok(!("error" in f));
  strictEqual(f.kind, "report");
  strictEqual(f.limit, 200);
});

test("log with no flag is a bare recent listing, not an error", () => {
  const f = parseLog(["log"]);
  ok(!("error" in f));
  strictEqual(f.limit, 20);
});

test("log --unread needs no other flag and carries no value", () => {
  const f = parseLog(["log", "--unread"]);
  ok(!("error" in f));
  strictEqual(f.unread, "SELF");
});

test("log --json is a BARE flag — treating every flag as valued broke it", () => {
  // `bb bus log --json` refused with "--json needs a value"; found by the live suite,
  // which reads --json to parse rows.
  const f = parseLog(["log", "--json"]);
  ok(!("error" in f), "error" in f ? f.error : "");
  const g = parseLog(["log", "--to", "thr_b", "--json", "-n", "5"]);
  ok(!("error" in g), "error" in g ? g.error : "");
  strictEqual((g as { limit: number }).limit, 5);
});

test("claim defaults the ttl to 30m and requires a reason", () => {
  const c = parseClaim(["claim", "pr:685", "--reason", "MX-838"]);
  ok(!("error" in c));
  strictEqual(c.ttl, "30m");
  strictEqual(c.resource, "pr:685");
  match(String((parseClaim(["claim", "pr:685"]) as { error: string }).error), /--reason/);
});

test("claim with no resource is refused", () => {
  match(String((parseClaim(["claim"]) as { error: string }).error), /resource/);
});
