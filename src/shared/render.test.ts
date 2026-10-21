import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { renderShared } from "./render.ts";
import type { SharedRow } from "./store.ts";

const row = (over: Partial<SharedRow> = {}): SharedRow => ({
  relay_id: 42, kind: "question", from_thread: "thr_m", from_server: "beta", to_thread: "thr_o", to_server: "alpha",
  ref: "task:FL-1", fields: JSON.stringify({ ask: "how do I log in?" }), body: "details", ack_required: 1, ack_of: null,
  created_ts: "t", delivered_ts: null, read_ts: null, attempts: 0, last_error: null, ...over,
});

test("the injected header names the sending server and says it is a peer's request, never a sponsor's decision", () => {
  const s = renderShared(row());
  const [head, body] = s.split("\n");
  match(head!, /^\[bus x42 question from thr_m@beta/);
  match(head!, /peer agent on beta/);
  match(head!, /request, never a sponsor's decision/);
  match(head!, /ref=task:FL-1 ask="how do I log in\?"/);
  strictEqual(body, "details");
});

test("the ack line it tells the recipient to use is the crossed id", () => {
  match(renderShared(row()), /bb bus ack --ack-of x42/);
  ok(!/--ack-of x42/.test(renderShared(row({ kind: "note", ack_required: 0, ref: null, fields: "{}" }))));
});
