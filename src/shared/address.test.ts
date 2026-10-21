import { deepStrictEqual, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { parseAddress, showAddress } from "./address.ts";

test("a bare thread id stays local, exactly as before", () => {
  deepStrictEqual(parseAddress("thr_abc", "alpha"), { kind: "local", thread: "thr_abc" });
  // Even with the shared space off: a bare id never needs it.
  deepStrictEqual(parseAddress("thr_abc", null), { kind: "local", thread: "thr_abc" });
});

test("<thread>@<server> is a remote address", () => {
  deepStrictEqual(parseAddress("thr_abc@beta", "alpha"), { kind: "remote", thread: "thr_abc", server: "beta" });
});

test("@<this server> is local", () => {
  deepStrictEqual(parseAddress("thr_abc@alpha", "alpha"), { kind: "local", thread: "thr_abc" });
});

test("a remote address with the shared space off is refused, naming why", () => {
  const r = parseAddress("thr_abc@beta", null);
  ok("error" in r);
  match(r.error, /shared space is not configured/);
});

test("malformed remote addresses are refused", () => {
  for (const s of ["abc@beta", "thr_abc@", "@beta", "thr_abc@Beta!", "thr_a@b@c"]) {
    const r = parseAddress(s, "alpha");
    ok("error" in r, s);
  }
});

test("showAddress spells thread@server", () => {
  deepStrictEqual(showAddress("thr_x", "beta"), "thr_x@beta");
});
