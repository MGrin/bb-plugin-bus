import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { RelayRefused, RelayUnreachable, createRelayClient } from "./relay.ts";

type Call = { method: string; url: string; auth: string | null; body: unknown };

function fake(answer: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const c: Call = { method: init?.method ?? "GET", url: String(url), auth: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return { f, calls };
}
const json = (status: number, v: unknown) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

test("every call carries the bearer token and goes under <url>/v2, with no double slash", async () => {
  const { f, calls } = fake(() => json(200, { peers: [] }));
  const c = createRelayClient({ url: "https://relay.example/bus/", token: "T0K", fetch: f });
  deepStrictEqual(await c.peers(), []);
  strictEqual(calls[0]!.url, "https://relay.example/bus/v2/peers");
  strictEqual(calls[0]!.auth, "Bearer T0K");
});

test("join posts the thread and its own description", async () => {
  const peer = { thread: "thr_a", server: "alpha", description: "ops", joined: "t" };
  const { f, calls } = fake(() => json(200, { peer }));
  const c = createRelayClient({ url: "http://r", token: "t", fetch: f });
  deepStrictEqual(await c.join("thr_a", "ops"), peer);
  deepStrictEqual(calls[0]!.body, { thread: "thr_a", description: "ops" });
  strictEqual(calls[0]!.method, "POST");
});

test("sync passes the cursor", async () => {
  const { f, calls } = fake(() => json(200, { relay: "r1", now: "t", messages: [], peers: [], claims: [] }));
  const c = createRelayClient({ url: "http://r", token: "t", fetch: f });
  const s = await c.sync(41);
  strictEqual(s.relay, "r1");
  strictEqual(calls[0]!.url, "http://r/v2/sync?after=41");
});

test("a 4xx is a REFUSAL carrying the relay's own words and status", async () => {
  const { f } = fake(() => json(404, { error: "thr_b@beta is not in the shared space" }));
  const c = createRelayClient({ url: "http://r", token: "t", fetch: f });
  await rejects(c.peers(), (e: unknown) => {
    ok(e instanceof RelayRefused);
    strictEqual(e.status, 404);
    strictEqual(e.message, "thr_b@beta is not in the shared space");
    return true;
  });
});

test("a network failure, a 5xx and a non-JSON body are UNREACHABLE, never a refusal", async () => {
  for (const answer of [
    () => { throw new TypeError("fetch failed"); },
    () => json(502, { error: "bad gateway" }),
    () => new Response("<html>sign in</html>", { status: 200 }),
  ]) {
    const { f } = fake(answer as () => Response);
    const c = createRelayClient({ url: "http://r", token: "t", fetch: f });
    await rejects(c.peers(), (e: unknown) => e instanceof RelayUnreachable);
  }
});

test("a 401 is a refusal that names the token, so a bad setting is not read as an outage", async () => {
  const { f } = fake(() => json(401, { error: "unauthorized" }));
  const c = createRelayClient({ url: "http://r", token: "t", fetch: f });
  await rejects(c.peers(), (e: unknown) => e instanceof RelayRefused && /token/.test(e.message));
});

test("a call that hangs past the timeout is UNREACHABLE", async () => {
  const f = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  const c = createRelayClient({ url: "http://r", token: "t", fetch: f, timeoutMs: 20 });
  await rejects(c.peers(), (e: unknown) => e instanceof RelayUnreachable);
});
