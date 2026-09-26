// MX-1280: a thread.archived / thread.deleted event releases a thread's claims only when
// bb's own record of that thread says archived / deleted. On 2026-09-25T04:56:24Z the
// event fired for two LIVE threads and released their claims early; nothing on our side
// said why, so the release now confirms before it acts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { createStore, type Db } from "./store.ts";

const HOLDER = "thr_holder000";
const FUTURE = "2999-01-01T00:00:00.000Z";

async function withClaim(record: Record<string, unknown> | Error) {
  const { bb, harness } = createFakePluginHost({
    sdk: {
      threads: {
        get: async () => {
          if (record instanceof Error) throw record;
          return { id: HOLDER, archivedAt: null, deletedAt: null, ...record };
        },
      },
    },
  });
  await plugin(bb);
  const store = createStore(bb.storage.database() as unknown as Db);
  store.putClaim({
    resource: "pr:1", holder: HOLDER, reason: "t", claimed_ts: "2026-09-25T04:50:00.000Z",
    heartbeat_ts: "2026-09-25T04:50:00.000Z", expires_ts: FUTURE,
    released_ts: null, released_by: null, stale: 0,
  });
  return { harness, store };
}

const thread = { id: HOLDER };

test("THE INCIDENT: thread.archived for a thread bb says is live keeps its claims", async () => {
  const { harness, store } = await withClaim({ archivedAt: null });
  await harness.emitThreadEvent("thread.archived", { thread } as never);
  assert.equal(store.getClaim("pr:1")?.released_ts, null);
});

test("thread.archived for a thread bb says is archived releases, labelled by the event", async () => {
  const { harness, store } = await withClaim({ archivedAt: 1 });
  await harness.emitThreadEvent("thread.archived", { thread } as never);
  assert.equal(store.getClaim("pr:1")?.released_by, "thread-archived");
});

test("thread.deleted for a thread bb says is live keeps its claims", async () => {
  const { harness, store } = await withClaim({ deletedAt: null });
  await harness.emitThreadEvent("thread.deleted", { thread } as never);
  assert.equal(store.getClaim("pr:1")?.released_ts, null);
});

test("thread.deleted for a thread bb says is deleted releases, labelled by the event", async () => {
  const { harness, store } = await withClaim({ deletedAt: 1 });
  await harness.emitThreadEvent("thread.deleted", { thread } as never);
  assert.equal(store.getClaim("pr:1")?.released_by, "thread-deleted");
});

// An archive is not a delete: the check reads the field that matches the event.
test("thread.deleted for a thread that is only archived keeps its claims", async () => {
  const { harness, store } = await withClaim({ archivedAt: 1, deletedAt: null });
  await harness.emitThreadEvent("thread.deleted", { thread } as never);
  assert.equal(store.getClaim("pr:1")?.released_ts, null);
});

// bb removes a deleted thread outright, so its re-read is a 404: that CONFIRMS the delete.
test("thread.deleted whose re-read is a 404 releases, labelled by the event", async () => {
  const { harness, store } = await withClaim(new Error("HTTP 404: Thread not found"));
  await harness.emitThreadEvent("thread.deleted", { thread } as never);
  assert.equal(store.getClaim("pr:1")?.released_by, "thread-deleted");
});

// Blindness keeps the claim: it still dies at its TTL, an early release does not undo.
test("a failed re-read keeps the claims", async () => {
  const { harness, store } = await withClaim(new Error("bb did not respond"));
  await harness.emitThreadEvent("thread.archived", { thread } as never);
  assert.equal(store.getClaim("pr:1")?.released_ts, null);
});
