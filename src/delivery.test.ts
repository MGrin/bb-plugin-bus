import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { deliver, isAwaitingUserInteraction, receipt } from "./delivery.ts";

const never = async () => { throw new Error("must not be called"); };
const fine = async () => {};
const throws409 = async () => {
  throw Object.assign(new Error("409 awaiting user interaction"),
    { status: 409, code: "awaiting_user_interaction" });
};

test("immediate uses send; queue NEVER touches send — it cannot steer a live turn", async () => {
  strictEqual((await deliver({ send: fine, queue: never }, "immediate")).kind, "sent");
  strictEqual((await deliver({ send: never, queue: fine }, "queue")).kind, "queued");
});

test("an immediate send to a thread awaiting a human falls back to the queue, and that is exit 0", async () => {
  const o = await deliver({ send: throws409, queue: fine }, "immediate");
  strictEqual(o.kind, "queued");
  strictEqual(receipt({ seq: 1, kind: "help", to: "thr_b", outcome: o, ackRequired: true }).exitCode, 0);
});

test("a hard failure is NOT a deferral — it exits 1 and the error rides along", async () => {
  const o = await deliver({ send: async () => { throw new Error("thread is gone"); }, queue: never }, "immediate");
  ok(o.kind === "failed");
  match(o.error, /gone/);
  const r = receipt({ seq: 1, kind: "help", to: "thr_b", outcome: o, ackRequired: true });
  strictEqual(r.exitCode, 1);
  match(String(r.stderr), /gone/);
});

test("blocked AND unqueueable is a failure, never a cheerful deferral", async () => {
  const o = await deliver({ send: throws409, queue: async () => { throw new Error("queue down"); } }, "immediate");
  ok(o.kind === "failed");
  match(o.error, /queue down/);
  match(o.error, /awaiting/i);
});

test("a queue-mode failure is a failure — there is no second fallback below the queue", async () => {
  const o = await deliver({ send: never, queue: async () => { throw new Error("db locked"); } }, "queue");
  ok(o.kind === "failed");
  match(o.error, /db locked/);
});

test("the 409 is identified POSITIVELY — anything unrecognised is a hard failure", () => {
  ok(isAwaitingUserInteraction({ status: 409, code: "awaiting_user_interaction" }));
  ok(isAwaitingUserInteraction(new Error("HTTP 409: awaiting user interaction")));
  ok(!isAwaitingUserInteraction(new Error("409 conflict")));
  ok(!isAwaitingUserInteraction(new Error("awaiting user interaction")));
  ok(!isAwaitingUserInteraction(null));
  ok(!isAwaitingUserInteraction(undefined));
});

test("the receipt names the seq and tells an ack sender what to wait for", () => {
  const r = receipt({ seq: 412, kind: "handoff", to: "thr_b", outcome: { kind: "sent" }, ackRequired: true });
  match(r.stdout, /#412/);
  match(r.stdout, /thr_b/);
  match(r.stdout, /unanswered/);
  strictEqual(r.exitCode, 0);
  strictEqual(r.stderr, null);
});

test("a non-ack kind's receipt does NOT mention unanswered — nothing is owed", () => {
  const r = receipt({ seq: 1, kind: "report", to: "thr_b", outcome: { kind: "queued" }, ackRequired: false });
  ok(!/unanswered/.test(r.stdout));
  match(r.stdout, /queued/);
});
