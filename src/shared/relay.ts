// THE RELAY CLIENT (MX-1528). The one place this plugin touches the network.
//
// Two failure classes, and the difference is the whole point of keeping them apart:
//   RelayRefused     — the relay ANSWERED and said no (4xx): a thread not joined, a claim
//                      held, a bad token. The caller reports the relay's own words.
//   RelayUnreachable — nobody answered usefully: network, timeout, 5xx, or a body that is
//                      not the relay's JSON (a sign-in page from a proxy is the likely one).
// A shared claim that cannot ask must never read as one that was refused, so the CLI maps
// these to different exit codes (69 and 75).

export interface Peer { thread: string; server: string; description: string; joined: string }

export interface RelayMessage {
  id: number;
  kind: string;
  from_thread: string;
  from_server: string;
  to_thread: string;
  to_server: string;
  ref: string | null;
  fields: Record<string, string>;
  body: string | null;
  ack_required: boolean;
  ack_of: number | null;
  created: string;
}

export interface RelayWaiter { thread: string; server: string; reason: string; joined: string; expires: string }

export interface RelayClaim {
  resource: string;
  spelled: string;
  holder_thread: string;
  holder_server: string;
  reason: string;
  claimed: string;
  expires: string;
  pickup: number;
  waiters: RelayWaiter[];
}

export interface SyncResult {
  relay: string;
  now: string;
  messages: RelayMessage[];
  peers: Peer[];
  claims: RelayClaim[];
}

export interface OutgoingMessage {
  from_thread: string;
  to_thread: string;
  to_server: string;
  kind: string;
  ref: string | null;
  fields: Record<string, string>;
  body: string | null;
  ack_of: number | null;
}

export type ClaimResult =
  | { result: "held"; claim: RelayClaim; took_from?: { thread: string; server: string } | null }
  | { result: "busy"; claim: RelayClaim }
  | { result: "waiting"; claim: RelayClaim; position: number; waiter: RelayWaiter }
  | { result: "contended"; claim: RelayClaim; error: string };

export type ReleaseResult =
  | { result: "released"; notified: { thread: string; server: string } | null; granted: { thread: string; server: string } | null }
  | { result: "left-wait-list" };

export type LeaveCause = "left" | "thread-archived" | "thread-deleted";

export interface RelayClient {
  join(thread: string, description: string): Promise<Peer>;
  leave(thread: string, cause: LeaveCause): Promise<{ left: boolean; released: number }>;
  peers(): Promise<Peer[]>;
  send(m: OutgoingMessage): Promise<RelayMessage>;
  sync(after: number): Promise<SyncResult>;
  claim(a: { thread: string; resource: string; spelled: string; reason: string; ttl_ms: number;
    wait: boolean; max_wait_ms: number }): Promise<ClaimResult>;
  heartbeat(thread: string, resource: string): Promise<ClaimResult>;
  release(a: { thread: string; resource: string; force: boolean; reason: string | null }): Promise<ReleaseResult>;
}

export class RelayUnreachable extends Error {
  constructor(message: string) { super(message); this.name = "RelayUnreachable"; }
}
export class RelayRefused extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = "RelayRefused"; this.status = status; }
}

export const DEFAULT_TIMEOUT_MS = 10_000;

export function createRelayClient(cfg: { url: string; token: string; fetch?: typeof fetch; timeoutMs?: number }): RelayClient {
  const base = cfg.url.replace(/\/+$/, "");
  const f = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    let text: string;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${cfg.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      throw new RelayUnreachable(`could not reach the relay at ${base}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RelayUnreachable(`the relay at ${base} answered HTTP ${res.status} with something that is not its JSON`);
    }
    if (res.status >= 500) {
      throw new RelayUnreachable(`the relay at ${base} failed: HTTP ${res.status} ${errorOf(parsed)}`);
    }
    if (res.status === 401) {
      throw new RelayRefused(401, `the relay at ${base} refused this server's token (HTTP 401) — check the plugin's token setting`);
    }
    if (res.status >= 400) throw new RelayRefused(res.status, errorOf(parsed) || `HTTP ${res.status}`);
    return parsed as T;
  }

  return {
    async join(thread, description) {
      return (await call<{ peer: Peer }>("POST", "/v2/peers", { thread, description })).peer;
    },
    leave: (thread, cause) => call("POST", "/v2/peers/leave", { thread, cause }),
    async peers() {
      return (await call<{ peers: Peer[] }>("GET", "/v2/peers")).peers;
    },
    async send(m) {
      return (await call<{ message: RelayMessage }>("POST", "/v2/messages", m)).message;
    },
    sync: (after) => call("GET", `/v2/sync?after=${after}`),
    claim: (a) => call("POST", "/v2/claims", a),
    heartbeat: (thread, resource) => call("POST", "/v2/claims/heartbeat", { thread, resource }),
    release: (a) => call("POST", "/v2/claims/release", a),
  };
}

function errorOf(v: unknown): string {
  return v && typeof v === "object" && typeof (v as { error?: unknown }).error === "string"
    ? (v as { error: string }).error : "";
}
