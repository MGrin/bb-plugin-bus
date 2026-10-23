// bb-plugin-bus — a typed peer bus between bb threads.
//
// WIRING ONLY. Every rule lives in src/: the kind table (kinds.ts) is the single source
// for required fields, ack and wake mode; validation is envelope.ts; the schema and its
// statements are store.ts; the claim state machine is claims.ts; the two SDK calls are
// chosen by delivery.ts; argv is cli.ts. This file reads stdin, calls bb, and decides
// nothing — which is what makes all of it reachable by `node --test` without bb.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { COMMANDS, UNREAD_SELF, parseClaim, parseJoin, parseLog, parseSend, parseSugar } from "./src/cli.ts";
import { KINDS, KIND_NAMES, isKind, schemaLine } from "./src/kinds.ts";
import { renderEnvelope, validate, type Envelope } from "./src/envelope.ts";
import { MIGRATIONS, createStore, type ClaimRow, type Db, type LifecycleCause, type MessageRow } from "./src/store.ts";
import { claimKey } from "./src/paths.ts";
import { DEFAULT_TTL_MS, GRANT_PICKUP_MS, attemptClaim, heartbeat, holderAlreadyTold, joinWaitList, parseTtl, release, renewalRefused, settle,
  type WaiterRow } from "./src/claims.ts";
import { deliver, receipt, type Outcome } from "./src/delivery.ts";
import { parseAddress } from "./src/shared/address.ts";
import { RelayUnreachable, createRelayClient, type RelayClaim, type RelayClient } from "./src/shared/relay.ts";
import { attachShared, createSharedStore, sharedPathFor, type SharedRow } from "./src/shared/store.ts";
import { SYNC_INTERVAL_MS, syncOnce } from "./src/shared/sync.ts";
import { fmtShared, renderShared } from "./src/shared/render.ts";

/** rc 75: somebody holds it. rc 69: the relay could not be asked — a different answer (MX-1528). */
const RC_BUSY = 75;
/** `lease` could not ask the relay (MX-1536): blind, never a cached answer. */
const RC_BLIND = 2;
/** Past every message id, so a sync returns claims and consumes no message. */
const LEASE_AFTER = Number.MAX_SAFE_INTEGER;
const RC_UNREACHABLE = 69;

/**
 * Which commit is this PROCESS running?
 *
 * bb bundles a `path:` plugin FROM SOURCE at reload, so a revision read here — at module
 * load, the same moment — is by construction the code now executing. Nothing else can say:
 * `bb plugin list` prints `running` and the source path but no revision, `bb plugin source`
 * has none to record for a path: source, and dist/ is NOT the loaded artifact (its mtime was
 * measured lying by 15 minutes). So a checkout can sit clean on main, every drift check
 * green, while the process runs something older.
 *
 * Synchronous on purpose: the value must be fixed before anything can observe it, and it is
 * one git call per load. Failure yields rev: null rather than a guess — a tarball install has
 * no git dir, and that must stay distinguishable from a real mismatch so a checker reports
 * UNKNOWN rather than OK. `dirty` rides along because a bundle built from an edited tree
 * matches NO commit, and comparing revisions alone would call that a match.
 */
const BUILD_STAMP: { rev: string | null; dirty: boolean | null; sourceDir: string; loadedAt: string; why: string | null } = (() => {
  const sourceDir = import.meta.dirname;
  const loadedAt = new Date().toISOString();
  try {
    const git = (args: string[]): string =>
      execFileSync("git", ["-C", sourceDir, ...args], { encoding: "utf8", timeout: 5000 }).trim();
    return { rev: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]).length > 0, sourceDir, loadedAt, why: null };
  } catch (e) {
    return { rev: null, dirty: null, sourceDir, loadedAt, why: e instanceof Error ? e.message : String(e) };
  }
})();

const nowIso = () => new Date().toISOString();

/**
 * The body, from a FILE — never from argv, and never from stdin, which bb does not
 * forward to a plugin CLI (see cli.ts's STDIN_DOES_NOT_REACH_THE_PLUGIN).
 *
 * THROWS rather than returning null on an unreadable file. A body the caller ASKED for
 * and did not get must not become a message sent without one: that is the shape that
 * shipped for an hour and told every sender it had worked.
 */
function readBody(src: { kind: "file"; path: string } | null): string {
  if (!src) return "";
  const raw = readFileSync(src.path, "utf8");
  const t = raw.trim();
  if (t === "") {
    throw new Error(`--body-file ${src.path} is empty — a body that is nothing is not a body`);
  }
  return t;
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createStore(db as unknown as Db);

  // ── THE SHARED SPACE (MX-1528) ──────────────────────────────────────────────────
  //
  // Off until all three settings are set, and then only for threads that JOIN. Its copy of
  // what crossed lives in shared.db, a separate file attached to this connection, so a
  // backup that copies data.db cannot carry a crossed secret (see src/shared/store.ts).
  const settings = bb.settings.define({
    server: { type: "string", label: "Server name",
      description: "This bb server's name in the shared space (the relay knows its token by it). Empty keeps the bus local." },
    relayUrl: { type: "string", label: "Relay URL",
      description: "Base URL of the shared-space relay, without /v2." },
    token: { type: "string", label: "Relay token", secret: true,
      description: "This server's bearer token for the relay." },
  });
  attachShared(db as unknown as Db, sharedPathFor(db as unknown as Db));
  const shared = createSharedStore(db as unknown as Db);
  const NOT_CONFIGURED = `bus: the shared space is not configured on this server. Set it once: ` +
    `bb plugin config ${bb.pluginId} set server <name>, … set relayUrl <url>, … set token <token>`;

  async function sharedCfg(): Promise<{ server: string; url: string; client: RelayClient } | null> {
    const v = await settings.get();
    const server = v.server?.trim();
    const url = v.relayUrl?.trim();
    const token = v.token?.trim();
    if (!server || !url || !token) return null;
    return { server, url, client: createRelayClient({ url, token }) };
  }

  /** A crossed message into a local thread, by its kind's own wake mode. No sender thread: it is not on this server. */
  async function deliverCrossed(row: SharedRow): Promise<{ ok: true } | { ok: false; error: string }> {
    const input = [{ type: "text" as const, mentions: [], text: renderShared(row) }];
    const o = await deliver({
      send: async () => { await bb.sdk.threads.send({ threadId: row.to_thread, mode: "auto", input }); },
      queue: async () => { await bb.sdk.threads.queuedMessages.create({ threadId: row.to_thread, input }); },
    }, isKind(row.kind) ? KINDS[row.kind].wake : "queue");
    return o.kind === "failed" ? { ok: false, error: o.error } : { ok: true };
  }

  // THE ONE POLLER, and it exists only because nothing may connect INTO a Mac (spec §5).
  // With the shared space off it reads its settings every tick and does nothing else.
  bb.background.service("shared-sync", {
    async start(signal) {
      let down: string | null = null;
      while (!signal.aborted) {
        const cfg = await sharedCfg().catch(() => null);
        if (cfg) {
          try {
            await syncOnce({ client: cfg.client, store: shared, myServer: cfg.server, now: () => new Date(),
              deliver: deliverCrossed, warn: (w) => bb.log.warn(`bus shared: ${w}`) });
            if (down) bb.log.info(`bus shared: the relay at ${cfg.url} answers again`);
            down = null;
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            // Said once per distinct failure, not every ten seconds.
            if (down !== why) bb.log.warn(`bus shared: sync failed: ${why}`);
            down = why;
          }
        }
        await new Promise<void>((res) => {
          const t = setTimeout(res, SYNC_INTERVAL_MS);
          signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
        });
      }
    },
  });

  // A DELETED OR ARCHIVED THREAD CANNOT HOLD pr:685 FOREVER. The old plugin dropped
  // room membership here; there is no membership now, and the thing that outlives a dead
  // thread and blocks everybody else is a claim. `released_by` names the event (MX-1280),
  // so a live thread that loses its claims can see which lifecycle event took them.
  //
  // AND ONLY WHEN bb CONFIRMS IT (MX-1280). On 2026-09-25T04:56:24Z this handler released
  // the claims of two threads that were live, unarchived and mid-turn: bb.db holds no
  // archive or delete for either, so the event fired for a thread that had not changed.
  // The emitter is bb's and not ours to read, so the release now re-reads the thread and
  // acts only when its record says archived or deleted. When the read fails the claims
  // are KEPT: a kept claim still dies at its TTL, while an early release is the silent
  // double-take this ledger exists to prevent.
  const releaseIfGone = async (id: string, cause: LifecycleCause) => {
    let gone: boolean;
    try {
      const t = await bb.sdk.threads.get({ threadId: id });
      gone = cause === "thread-archived" ? t.archivedAt != null : t.deletedAt != null;
    } catch (err) {
      // bb REMOVES a deleted thread (bb.db keeps no deleted_at rows), so after a delete the
      // re-read is `HTTP 404: Thread not found` -- which is the confirmation, not a failure.
      if (/\b404\b|not found/i.test(String(err))) {
        gone = true;
      } else {
        bb.log.warn(`${cause} for ${id}: could not re-read the thread, so its claims are kept until their TTL (${String(err)})`);
        return;
      }
    }
    if (!gone) {
      bb.log.warn(`${cause} for ${id}, but bb says the thread is not ${cause.slice(7)}: its claims are kept (MX-1280)`);
      return;
    }
    // A gone thread waits for nothing either (MX-1390): its wait-list rows go with it, and
    // whatever it held passes to the head of that resource's list.
    store.dropWaitersOf(id);
    store.releaseClaimsHeldBy(id, nowIso(), cause);
    // A joined thread leaves the shared space with it; the relay releases its shared claims.
    // Queued, so a relay that is away now still hears it on the next sync.
    if (shared.joined(id)) {
      shared.leave(id);
      shared.addPendingLeave(id, cause, nowIso());
    }
    await sweep(null);
  };
  bb.events.on("thread.archived", ({ thread }) => releaseIfGone(thread.id, "thread-archived"));
  bb.events.on("thread.deleted", ({ thread }) => releaseIfGone(thread.id, "thread-deleted"));

  // ── THE WAIT LIST (MX-1390) ──────────────────────────────────────────────────────
  //
  // `settle` is pure; this is where its answer is written and delivered. Every claim verb
  // sweeps FIRST, so an expired claim with a waiter is the waiter's before anybody else
  // can look at it — that, and not a check inside attemptClaim, is what stops a claimant
  // jumping the list.
  //
  // THE ONE TIMER IN THIS PLUGIN. "Nothing here waits" is about delivery — a session that
  // cannot go deaf. An expiry nobody touches would otherwise strand the head of the list
  // until some unrelated thread happened to run `bb bus claims`, which is polling again by
  // another name. So the server arms ONE timeout, for the earliest expiry among claims
  // somebody waits on, and re-arms after every sweep. With an empty list it arms nothing.
  type Granted = NonNullable<ReturnType<typeof settle>>;
  const mins = (ms: number) => `${Math.round(ms / 60_000)}m`;

  const announceGrant = async (from: string | null, g: Granted) => {
    const w = g.grant;
    // A timer grant has no caller; it is sent as from the holder whose claim lapsed, or
    // else from the waiter itself. A waiter whose OWN claim settled it already has stdout.
    const sender = from ?? g.tookFrom ?? w.waiter;
    if (from !== w.waiter) {
      const body = `You hold ${w.spelled} until ${g.row.expires_ts}, a ${mins(GRANT_PICKUP_MS)} pickup. ` +
        `Take it for your ${mins(w.ttl_ms)}: bb bus claim ${w.spelled} --reason '${w.reason}' --ttl ${mins(w.ttl_ms)}. ` +
        `Not needed any more: bb bus release ${w.spelled}`;
      const e = validate({ kind: "claim", to: w.waiter, ref: null,
        fields: { resource: w.spelled, ttl: mins(GRANT_PICKUP_MS), reason: `GRANTED to you from the wait list (${w.reason})` },
        body, ackOf: null });
      if (e.ok) await post(sender, e.envelope);
    }
    if (g.tookFrom && g.tookFrom !== w.waiter) {
      const e = validate({ kind: "claim", to: g.tookFrom, ref: null,
        fields: { resource: w.spelled, ttl: mins(GRANT_PICKUP_MS), reason: `your claim expired; granted to ${w.waiter} from the wait list` },
        body: null, ackOf: null });
      if (e.ok) await post(w.waiter, e.envelope);
    }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    let next = Infinity;
    for (const r of store.waitedResources()) {
      const c = store.getClaim(r);
      // A waited resource is always held after a sweep; the earliest of the two times a
      // row can change hands — its claim's expiry, or a waiter's own --max-wait — wins.
      if (c && c.released_ts === null) next = Math.min(next, Date.parse(c.expires_ts));
      for (const w of store.waiters(r)) next = Math.min(next, Date.parse(w.expires_ts));
    }
    if (next === Infinity) return;
    const delay = Math.min(Math.max(next - Date.now(), 0) + 250, 2 ** 31 - 1);
    timer = setTimeout(() => { void sweep(null).catch((e) => bb.log.warn(`bus wait-list sweep: ${String(e)}`)); }, delay);
    (timer as { unref?: () => void }).unref?.();
  };

  /** Settle every waited resource, write the grants, re-arm, THEN deliver. Returns grants. */
  async function sweep(from: string | null): Promise<Granted[]> {
    const now = new Date();
    store.pruneWaiters(now.toISOString());
    const grants: Granted[] = [];
    for (const r of store.waitedResources()) {
      const g = settle({ existing: store.getClaim(r), waiters: store.waiters(r), now });
      if (!g) continue;
      // Both writes before any await: delivery yields, and another verb must not see the
      // slot free between them.
      store.putClaim(g.row);
      store.removeWaiter(r, g.grant.waiter);
      grants.push(g);
    }
    arm();
    for (const g of grants) await announceGrant(from, g);
    return grants;
  }
  arm();

  const fmtWaiter = (w: WaiterRow, i: number): string =>
    `    waiting ${i + 1}. ${w.waiter} since ${w.joined_ts}  gives up ${w.expires_ts}  (${w.reason})`;

  /**
   * ADDRESS VALIDATION, and it is a refusal rather than a warning.
   *
   * The old bus delivered `--to <id>` unconditionally and reported `woke 1/1` for a
   * typo — that is how message #4828 reached a thread that had never joined anything,
   * which replied politely while the sender learned nothing for three minutes. An
   * unknown address is now refused before anything is written.
   */
  async function knownThread(id: string): Promise<boolean> {
    try {
      await bb.sdk.threads.get({ threadId: id });
      return true;
    } catch {
      return false;
    }
  }

  /** Write the row, deliver it by the kind's own wake mode, stamp delivered_ts. */
  async function post(from: string, e: Envelope): Promise<{ seq: number; outcome: Outcome }> {
    const seq = store.insertMessage(from, e, nowIso());
    const row = store.getMessage(seq)!;
    const input = [{ type: "text" as const, mentions: [], text: renderEnvelope(row) }];
    const outcome = await deliver(
      {
        send: async () => {
          await bb.sdk.threads.send({ threadId: e.to, mode: "auto", senderThreadId: from, input });
        },
        queue: async () => {
          await bb.sdk.threads.queuedMessages.create({ threadId: e.to, senderThreadId: from, input });
        },
      },
      e.wake,
    );
    // delivered_ts is set when bb ACCEPTED it. bb exposes queuedMessages.list, but a row
    // leaving that list is indistinguishable from a delete, so "consumed" is not
    // observable — this is spec §3's own fallback, and the README says so.
    if (outcome.kind !== "failed") store.markDelivered(seq, nowIso());
    return { seq, outcome };
  }

  const fmtMessage = (m: MessageRow): string =>
    `#${m.seq} ${m.created_ts} ${m.from_thread} -> ${m.to_addr} ` +
    renderEnvelope(m).replace(/^\[bus #\d+ /, "[").replace(/ from thr_\w+\]/, "]");

  // The spelling a holder TYPED, for anything a human or a string-matcher reads (MX-977).
  const shown = (c: ClaimRow): string => c.spelled ?? c.resource;

  const fmtClaim = (c: ClaimRow, now: Date): string => {
    const state = c.released_ts ? `released by ${c.released_by}`
      : now.getTime() >= Date.parse(c.expires_ts) ? `EXPIRED ${c.expires_ts}`
      : `held until ${c.expires_ts}`;
    const key = shown(c) !== c.resource ? ` = ${c.resource}` : "";
    return `${shown(c)}${key}  ${c.holder}  ${state}  (${c.reason})`;
  };

  const fmtSharedClaim = (c: RelayClaim, now: Date): string => {
    const state = now.getTime() >= Date.parse(c.expires) ? `EXPIRED ${c.expires}` : `held until ${c.expires}`;
    const key = c.spelled !== c.resource ? ` = ${c.resource}` : "";
    return [`${c.spelled}${key}  ${c.holder_thread}@${c.holder_server}  ${state}  (${c.reason})  [shared]`,
      ...c.waiters.map((w, i) => `    waiting ${i + 1}. ${w.thread}@${w.server} since ${w.joined}  gives up ${w.expires}  (${w.reason})`),
    ].join("\n");
  };
  const liveShared = (c: RelayClaim | null, now: Date): c is RelayClaim => c !== null && now.getTime() < Date.parse(c.expires);
  const say = (e: unknown) => (e instanceof Error ? e.message : String(e));
  /** A relay failure as a CLI answer: unreachable is rc 69, a refusal is rc 1, each in the relay's words. */
  const relayFail = (e: unknown, what: string) => e instanceof RelayUnreachable
    ? { exitCode: RC_UNREACHABLE, stderr: `bus: ${say(e)} — ${what}` }
    : { exitCode: 1, stderr: `bus: the relay refused: ${say(e)}` };

  bb.cli.register({
    name: "bus",
    summary: "Typed peer bus between bb threads: twelve kinds, claims, one stream",
    commands: COMMANDS.map((c) => ({ name: c.name, summary: c.summary, usage: c.usage })),

    async run(argv, ctx) {
      const me = ctx.threadId ?? null;
      const cmd = argv[0] ?? "help";
      const fail = (msg: string) => ({ exitCode: 1, stderr: msg });

      // BEFORE the thread-context gate, deliberately: "what is running" must stay
      // answerable from anywhere, including outside a thread and when this is broken.
      if (cmd === "build") {
        if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(BUILD_STAMP) };
        const dirty = BUILD_STAMP.dirty === null ? "" : BUILD_STAMP.dirty ? " +dirty" : "";
        const why = BUILD_STAMP.why ? `  (${BUILD_STAMP.why})` : "";
        return { exitCode: 0,
          stdout: `loaded ${BUILD_STAMP.rev ?? "unknown"}${dirty} from ${BUILD_STAMP.sourceDir} at ${BUILD_STAMP.loadedAt}${why}` };
      }

      // `peers` also answers outside a thread: an install script checks the relay with it.
      if (cmd === "peers") {
        const cfg = await sharedCfg();
        if (!cfg) return fail(NOT_CONFIGURED);
        try {
          const ps = await cfg.client.peers();
          shared.setPeers(ps);
          if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(ps) };
          return { exitCode: 0, stdout: ps.length
            ? ps.map((x) => `${x.thread}@${x.server}${x.thread === me && x.server === cfg.server ? " (you)" : ""}  joined ${x.joined}  ${x.description}`).join("\n")
            : "nobody has joined the shared space" };
        } catch (e) {
          const cached = shared.peers();
          const r = relayFail(e, `this is this server's last copy, from ${shared.getMeta("synced_at") ?? "never"}`);
          return { ...r, stdout: cached.map((x) => `${x.thread}@${x.server}  joined ${x.joined}  ${x.description}`).join("\n") };
        }
      }

      // `lease` (MX-1536): a fresh, authoritative, NON-RENEWING read of one shared claim. Before the
      // thread gate and with no markRead: it writes nothing here. It asks the relay's sync with an
      // `after` past every message id, so no message is returned, delivered or consumed, and it never
      // touches the sync cursor or shared.db. It never falls back to the cache: rc 2 means BLIND.
      if (cmd === "lease") {
        const blind = (why: string) => ({ exitCode: RC_BLIND, stderr: `bus: lease is blind — ${why}` });
        const largs = argv.slice(1).filter((a) => !a.startsWith("--"));
        if (!argv.includes("--shared") || !largs[0]) return fail("usage: bb bus lease <resource> --shared [--json]");
        const lk = claimKey(largs[0], ctx.cwd ?? null);
        if ("error" in lk) return fail(lk.error);
        if (largs[0].startsWith("path:")) return fail("bus: a path: claim cannot be shared, so there is no shared lease to read.");
        const cfg = await sharedCfg();
        if (!cfg) return blind("the shared space is not configured on this server");
        let res;
        try { res = await cfg.client.sync(LEASE_AFTER); } catch (e) { return blind(say(e)); }
        const nowMs = Date.parse(res?.now ?? "");
        if (typeof res?.relay !== "string" || !Array.isArray(res.claims) || Number.isNaN(nowMs)) {
          return blind(`the relay at ${cfg.url} answered, but not with a sync receipt`);
        }
        const claim = res.claims.find((c) => c.resource === lk.key) ?? null;
        // An unexpired view is the holder; one past the relay's own clock is listed but no longer held.
        const held = claim !== null && nowMs < Date.parse(claim.expires);
        return { exitCode: 0, stdout: JSON.stringify({ schema: "bb-bus.lease.v1", relay: res.relay, relay_now: res.now,
          fetched_at: nowIso(), server: cfg.server, resource: largs[0], key: lk.key, held, claim }) };
      }

      if (!me && cmd !== "help") {
        return fail("bus: no thread context — run from inside a bb thread");
      }
      const mine = me!;

      // `read_ts` is set on every row addressed to me when I next call ANY verb. Taken
      // AFTER the command has produced its output, so `log --unread` shows what was
      // unread at entry and marks it in the same breath.
      // The shared space's name for this server; null while it is not configured, and then
      // nothing below reads or writes a crossed row.
      const my = (await sharedCfg().catch(() => null))?.server ?? null;
      const markRead = () => {
        store.markReadFor(mine, nowIso());
        if (my) shared.markReadFor(mine, my, nowIso());
      };

      try {
        switch (cmd) {
          case "claims": {
            await sweep(mine);
            const now = new Date();
            const rows = store.listClaims({
              stale: argv.includes("--stale") || undefined,
              mine: argv.includes("--mine") ? mine : undefined,
            });
            // Shared claims, from this server's copy (no network): every server sees who holds one.
            const sc = argv.includes("--stale") ? [] : shared.claims()
              .filter((c) => !argv.includes("--mine") || (c.holder_thread === mine && c.holder_server === my));
            markRead();
            // JSON keeps `resource` = the TYPED spelling, which is what readers match on
            // (`mx gate`); the key it was held under is `key`.
            if (argv.includes("--json")) {
              return { exitCode: 0, stdout: JSON.stringify([...rows.map(({ spelled, ...c }) =>
                ({ ...c, resource: spelled ?? c.resource, key: c.resource,
                   waiters: store.waiters(c.resource).map(({ resource: _r, ...w }) => w) })),
                ...sc.map((c) => ({ resource: c.spelled, key: c.resource, holder: c.holder_thread, server: c.holder_server,
                   shared: true, reason: c.reason, claimed_ts: c.claimed, expires_ts: c.expires, released_ts: null,
                   released_by: null, waiters: c.waiters }))]) };
            }
            const lines = [...rows.map((c) => [fmtClaim(c, now), ...store.waiters(c.resource).map(fmtWaiter)].join("\n")),
              ...sc.map((c) => fmtSharedClaim(c, now))];
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "no claims" };
          }

          case "claim": {
            const p = parseClaim(argv);
            if ("error" in p) return fail(p.error);
            const bad = validate({ kind: "claim", to: mine, ref: null,
              fields: { resource: p.resource, ttl: p.ttl, reason: p.reason }, body: null, ackOf: null });
            if (!bad.ok) return fail(bad.error);
            const ttl = parseTtl(p.ttl);
            if ("error" in ttl) return fail(ttl.error);
            const k = claimKey(p.resource, ctx.cwd ?? null);
            if ("error" in k) return fail(k.error);
            const maxWait = parseTtl(p.maxWait);
            if ("error" in maxWait) return fail(`--max-wait: ${maxWait.error}`);
            await sweep(mine);
            const now = new Date();
            if (p.shared) {
              if (p.resource.startsWith("path:")) {
                return fail(`bus: a path: claim cannot be shared — the same path means different things on different servers. Claim it without --shared.`);
              }
              const cfg = await sharedCfg();
              if (!cfg) return fail(NOT_CONFIGURED);
              if (!shared.joined(mine)) return fail(`bus: ${mine} has not joined the shared space, so it cannot hold a shared claim. bb bus join --description '<one line>'`);
              // A LOCAL holder on this server blocks a shared claim on the same name (spec §5).
              const local = store.getClaim(k.key);
              if (local && local.released_ts === null && now.getTime() < Date.parse(local.expires_ts) && local.holder !== mine) {
                markRead();
                return { exitCode: RC_BUSY, stdout: `busy ${local.holder} ${local.reason} expires ${local.expires_ts}`,
                  stderr: `bus: ${local.holder} holds ${shown(local)} LOCALLY on this server; a shared claim on it waits until that is released.` };
              }
              let r;
              try {
                r = await cfg.client.claim({ thread: mine, resource: k.key, spelled: p.resource, reason: p.reason,
                  ttl_ms: ttl.ms, wait: p.wait, max_wait_ms: maxWait.ms });
              } catch (e) {
                markRead();
                return relayFail(e, "a shared claim never falls back to a local one, so NOTHING is held");
              }
              markRead();
              const h = `${r.claim.holder_thread}@${r.claim.holder_server}`;
              if (r.result === "held") {
                shared.upsertClaim(r.claim);
                return { exitCode: 0, stdout: `held ${p.resource} (shared) until ${r.claim.expires}` +
                  (r.took_from ? `\n  taken from ${r.took_from.thread}@${r.took_from.server}, whose claim had expired — it was told.` : "") };
              }
              if (r.result === "waiting") {
                return { exitCode: RC_BUSY, stdout: `waiting ${r.position} for ${h} ${r.claim.reason} expires ${r.claim.expires}`,
                  stderr: `bus: you are #${r.position} on the shared wait list for ${r.claim.spelled}, dropped at ${r.waiter.expires}. ` +
                    `When it is yours a [bus … claim] message says GRANTED — then re-run this claim. Leave the list: bb bus release ${p.resource} --shared` };
              }
              if (r.result === "contended") return { exitCode: RC_BUSY, stdout: `contended ${p.resource}`, stderr: `bus: ${r.error}` };
              return { exitCode: RC_BUSY, stdout: `busy ${h} ${r.claim.reason} expires ${r.claim.expires}`,
                stderr: `bus: ${h} holds ${r.claim.spelled} in the shared space. It was told you are waiting. To queue for it in order: add --wait.` };
            }
            // A SHARED holder blocks a local claim on the same name, read from this server's
            // copy of the shared claims — so a local claim still makes no network call.
            const sh = shared.claim(k.key);
            if (liveShared(sh, now) && sh.holder_thread !== mine) {
              markRead();
              return { exitCode: RC_BUSY, stdout: `busy ${sh.holder_thread}@${sh.holder_server} ${sh.reason} expires ${sh.expires}`,
                stderr: `bus: ${sh.holder_thread}@${sh.holder_server} holds ${sh.spelled} SHARED (this server's copy of the shared claims, ` +
                  `as of ${shared.getMeta("synced_at") ?? "never"}). A local claim cannot take it.` };
            }
            // A re-claim of what you hold IS a renewal; refused while anyone waits (MX-1394).
            const no = renewalRefused({ existing: store.getClaim(k.key), waiters: store.waiters(k.key),
              caller: mine, confirming: true, now });
            if (no) { markRead(); return { exitCode: 75, stdout: `contended ${p.resource}`, stderr: no }; }
            const r = attemptClaim({ existing: store.getClaim(k.key), resource: k.key,
              holder: mine, reason: p.reason, ttlMs: ttl.ms, now });
            if (r.kind === "busy" && p.wait) {
              const j = joinWaitList({ waiters: store.waiters(k.key), resource: k.key, spelled: p.resource,
                waiter: mine, reason: p.reason, ttlMs: ttl.ms, maxWaitMs: maxWait.ms, now });
              if (j.joined) {
                store.addWaiter(j.row);
                arm();
                // The holder is told ONCE, on joining — a re-run of the same --wait keeps
                // its place and wakes nobody (mem_cf8vtxd3xz4: a polled claim spams them).
                const e = validate({ kind: "claim", to: r.holder.holder, ref: null,
                  fields: { resource: p.resource, ttl: p.ttl, reason: `waiting #${j.position}: ${p.reason}` }, body: null, ackOf: null });
                if (e.ok) await post(mine, e.envelope);
              }
              markRead();
              // STILL rc 75: you do not hold it. `claim --wait && run` must not run.
              return { exitCode: 75,
                stdout: `waiting ${j.position} for ${r.holder.holder} ${r.holder.reason} expires ${r.holder.expires_ts}`,
                stderr: `bus: you are #${j.position} on the wait list for ${shown(r.holder)} since ${j.row.joined_ts}, ` +
                  `dropped at ${j.row.expires_ts}. When it is yours a [bus … claim] message says GRANTED — ` +
                  `then re-run this claim to take your full ttl. Leave the list: bb bus release ${p.resource}` };
            }
            if (r.kind === "busy") {
              // THE ONE WAKE A CLAIM CAUSES GOES TO THE HOLDER, not to the second
              // claimant. Spec §4 says the busy answer is an immediate message to the
              // second claimant — but that is the caller, who already has it on stdout at
              // rc 75. The HOLDER is the only party not looking, and telling them somebody
              // is waiting is the thing that moves the resource along. README says so.
              // ONCE per holder claim (MX-1400): a polled plain claim woke it every time.
              const told = holderAlreadyTold({ holder: r.holder,
                sent: store.log({ kind: "claim", from: mine, to: r.holder.holder, since: r.holder.claimed_ts, limit: 500 }),
                keyOf: (s) => { const x = claimKey(s, ctx.cwd ?? null); return "error" in x ? null : x.key; } });
              const e = validate({ kind: "claim", to: r.holder.holder, ref: null,
                fields: { resource: p.resource, ttl: p.ttl, reason: p.reason }, body: null, ackOf: null });
              if (e.ok && !told) await post(mine, e.envelope);
              markRead();
              return { exitCode: 75,
                stdout: `busy ${r.holder.holder} ${r.holder.reason} expires ${r.holder.expires_ts}`,
                stderr: `bus: ${r.holder.holder} holds ${shown(r.holder)}` +
                  (shown(r.holder) !== p.resource ? ` — the same file as ${p.resource} (${k.key})` : "") +
                  `. It was told you are waiting.` +
                  (store.waiters(k.key).length ? ` ${store.waiters(k.key).length} already on its wait list.` : "") +
                  ` To queue for it in order: add --wait.` };
            }
            store.putClaim({ ...r.row, spelled: p.resource });
            store.removeWaiter(k.key, mine);
            arm();
            if (r.tookFrom) {
              // The loss is DELIVERED, not merely logged — a stale takeover that only a
              // ledger records is a takeover the displaced holder acts against.
              const e = validate({ kind: "claim", to: r.tookFrom, ref: null,
                fields: { resource: p.resource, ttl: p.ttl, reason: p.reason }, body: null, ackOf: null });
              if (e.ok) await post(mine, e.envelope);
            }
            markRead();
            return { exitCode: 0,
              stdout: `held ${p.resource} until ${r.row.expires_ts}` +
                (r.tookFrom ? `\n  taken from ${r.tookFrom}, whose claim had expired — it was told.` : "") };
          }

          case "heartbeat": {
            const hargs = argv.filter((a) => a !== "--shared" && a !== "--json");
            const resource = hargs[1];
            if (!resource) return fail("usage: bb bus heartbeat <resource> [--shared]");
            const hk = claimKey(resource, ctx.cwd ?? null);
            if ("error" in hk) return fail(hk.error);
            if (argv.includes("--shared")) {
              const cfg = await sharedCfg();
              if (!cfg) return fail(NOT_CONFIGURED);
              let r;
              try { r = await cfg.client.heartbeat(mine, hk.key); } catch (e) { markRead(); return relayFail(e, "the shared claim was NOT extended"); }
              markRead();
              const asJson = argv.includes("--json");
              const receipt = (result: string, error: string | null) => JSON.stringify(
                { schema: "bb-bus.heartbeat.v1", result, claim: r.claim, error });
              if (r.result === "held") {
                shared.upsertClaim(r.claim);
                return { exitCode: 0, stdout: asJson ? receipt("held", null) : `held ${resource} (shared) until ${r.claim.expires}` };
              }
              const why = "error" in r ? r.error : r.result;
              return { exitCode: RC_BUSY, ...(asJson ? { stdout: receipt(r.result, why) } : {}), stderr: `bus: ${why}` };
            }
            await sweep(mine);
            const existing = store.getClaim(hk.key);
            // The original ttl, so a heartbeat extends by what was asked for rather than
            // silently resetting every claim to the default.
            const ttlMs = existing
              ? Date.parse(existing.expires_ts) - Date.parse(existing.claimed_ts)
              : DEFAULT_TTL_MS;
            const no = renewalRefused({ existing, waiters: store.waiters(hk.key), caller: mine,
              confirming: false, now: new Date() });
            if (no) { markRead(); return { exitCode: 75, stderr: no }; }
            const r = heartbeat({ existing, holder: mine, ttlMs, now: new Date() });
            markRead();
            if ("error" in r) return fail(r.error);
            store.putClaim(r.row);
            return { exitCode: 0, stdout: `held ${resource} until ${r.row.expires_ts}` };
          }

          case "release": {
            const rargs = argv.filter((a) => a !== "--shared");
            const resource = rargs[1];
            if (!resource) return fail("usage: bb bus release <resource> [--force --reason '<why>'] [--shared]");
            const force = argv.includes("--force");
            const ri = argv.indexOf("--reason");
            const reason = ri >= 0 ? argv[ri + 1] ?? null : null;
            const rk = claimKey(resource, ctx.cwd ?? null);
            if ("error" in rk) return fail(rk.error);
            if (argv.includes("--shared")) {
              const cfg = await sharedCfg();
              if (!cfg) return fail(NOT_CONFIGURED);
              let r;
              try { r = await cfg.client.release({ thread: mine, resource: rk.key, force, reason }); } catch (e) { markRead(); return relayFail(e, "NOTHING was released"); }
              markRead();
              if (r.result === "left-wait-list") return { exitCode: 0, stdout: `left the shared wait list for ${resource}` };
              shared.dropClaim(rk.key);
              return { exitCode: 0, stdout: `released ${resource} (shared)` +
                (r.notified ? ` (forced; ${r.notified.thread}@${r.notified.server} was told)` : "") +
                (r.granted ? `\n  granted to ${r.granted.thread}@${r.granted.server}, first on its wait list — it was told.` : "") };
            }
            // Leaving the wait list is a release of your PLACE (MX-1390).
            if (!force && store.waiters(rk.key).some((w) => w.waiter === mine) &&
                store.getClaim(rk.key)?.holder !== mine) {
              store.removeWaiter(rk.key, mine);
              arm();
              markRead();
              return { exitCode: 0, stdout: `left the wait list for ${resource}` };
            }
            await sweep(mine);
            const r = release({ existing: store.getClaim(rk.key), caller: mine, force, reason, now: new Date() });
            if ("error" in r) {
              markRead();
              const sh = shared.claim(rk.key);
              return fail(r.error + (sh && sh.holder_thread === mine ? `\n  you hold it SHARED: bb bus release ${resource} --shared` : ""));
            }
            store.putClaim(r.row);
            if (r.notifyHolder) {
              const e = validate({ kind: "release", to: r.notifyHolder, ref: null,
                fields: { resource }, body: reason, ackOf: null });
              if (e.ok) await post(mine, e.envelope);
            }
            const granted = (await sweep(mine)).find((g) => g.row.resource === rk.key);
            markRead();
            return { exitCode: 0,
              stdout: `released ${resource}` + (r.notifyHolder ? ` (forced; ${r.notifyHolder} was told)` : "") +
                (granted ? `\n  granted to ${granted.grant.waiter}, first on its wait list — it was told.` : "") };
          }

          case "log": {
            const f = parseLog(argv);
            if ("error" in f) return fail(f.error);
            if (f.unread === UNREAD_SELF) f.unread = mine;
            const rows = store.log(f);
            // Crossed rows, marked x<id> and thread@server, merged in time order (MX-1528).
            const srows = my ? shared.log(f, my) : [];
            markRead();
            type Item = { ts: string; local?: MessageRow; crossed?: SharedRow };
            const items: Item[] = [...rows.map((r) => ({ ts: r.created_ts, local: r })),
              ...srows.map((r) => ({ ts: r.created_ts, crossed: r }))]
              .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).slice(-f.limit);
            if (argv.includes("--json")) {
              return { exitCode: 0, stdout: JSON.stringify(items.map((i) => i.local ?? {
                ...i.crossed!, seq: `x${i.crossed!.relay_id}`, from_thread: `${i.crossed!.from_thread}@${i.crossed!.from_server}`,
                to_addr: `${i.crossed!.to_thread}@${i.crossed!.to_server}`, shared: true })) };
            }
            return { exitCode: 0, stdout: items.length
              ? items.map((i) => (i.local ? fmtMessage(i.local) : fmtShared(i.crossed!))).join("\n") : "nothing matches" };
          }

          case "unanswered": {
            const mi = argv.indexOf("--minutes");
            const minutes = mi >= 0 ? parseInt(argv[mi + 1] ?? "30", 10) || 30 : 30;
            const rows = store.unanswered(minutes, new Date());
            const srows = my ? shared.unanswered(minutes, new Date()) : [];
            markRead();
            if (!rows.length && !srows.length) return { exitCode: 0, stdout: `nothing unanswered older than ${minutes}m` };
            return { exitCode: 0,
              stdout: [...rows.map((m) => `${fmtMessage(m)}\n    ack it: bb bus ack --ack-of ${m.seq} --answer '<one line>'`),
                ...srows.map((m) => `${fmtShared(m)}\n    ` + (m.to_server === my
                  ? `ack it: bb bus ack --ack-of x${m.relay_id} --answer '<one line>'`
                  : `awaiting ${m.to_thread}@${m.to_server}`))].join("\n") };
          }

          case "join": {
            const j = parseJoin(argv);
            if ("error" in j) return fail(j.error);
            const cfg = await sharedCfg();
            if (!cfg) return fail(NOT_CONFIGURED);
            let peer;
            try { peer = await cfg.client.join(mine, j.description); } catch (e) { return relayFail(e, "you have NOT joined"); }
            shared.join(mine, j.description, peer.joined);
            markRead();
            return { exitCode: 0, stdout: `joined the shared space as ${mine}@${cfg.server}: "${j.description}"\n` +
              `  every server now sees this thread. What you send across is your call alone: nothing personal, no memories.\n` +
              `  leave with: bb bus leave` };
          }

          case "leave": {
            if (argv.length > 1) return fail("usage: bb bus leave");
            const cfg = await sharedCfg();
            if (!cfg) return fail(NOT_CONFIGURED);
            let r;
            try { r = await cfg.client.leave(mine, "left"); } catch (e) { return relayFail(e, "you are STILL in the shared space"); }
            shared.leave(mine);
            markRead();
            return { exitCode: 0, stdout: r.left
              ? `left the shared space; ${r.released} shared claim(s) released`
              : `you were not in the shared space` };
          }

          case "send": case "help": default: {
            const sugar = isKind(cmd);
            if (cmd !== "send" && !sugar) {
              // AN UNKNOWN VERB REFUSES. The old plugin fell through to its help and
              // exited 0 for anything it did not recognise, which is on record as a way
              // a wrong command reads as a working one (docs/bb-cli-failure-shapes.md).
              // A liveness probe written against that behaviour cannot tell an installed
              // plugin from a typo, and this suite's own probe was fooled by it.
              if (cmd === "help" || cmd === "--help") {
                return { exitCode: 0, stdout: helpText() };
              }
              return fail(`bus: no such verb '${cmd}'.\n${helpText()}`);
            }
            const p = sugar ? parseSugar(cmd, argv) : parseSend(argv);
            if (p.error) return fail(p.error);

            // `ack` derives its recipient from the row it acks: the sender of a question
            // is the only correct answer, and making a human retype it is how an ack goes
            // to the wrong thread and the question stays open.
            let tos = p.to;
            if (p.kind === "ack" && p.ackOf !== null && p.ackOfShared) {
              // A CROSSED row is acked back across, to the thread@server that asked it.
              const target = shared.getMessage(p.ackOf);
              if (!target) return fail(`bus: no crossed message x${p.ackOf} on this server`);
              if (!my || target.to_server !== my) {
                return fail(`bus: x${p.ackOf} was sent FROM this server; only its recipient acks it`);
              }
              const asker = `${target.from_thread}@${target.from_server}`;
              if (tos.length > 1 || (tos[0] && tos[0] !== asker)) {
                return fail(`bus: x${p.ackOf} came from ${asker} — an ack goes back to the asker`);
              }
              tos = [asker];
            } else if (p.kind === "ack" && p.ackOf !== null) {
              const target = store.getMessage(p.ackOf);
              if (!target) return fail(`bus: no message #${p.ackOf} to ack`);
              if (tos.length > 1) {
                return fail(`bus: an ack goes back to ONE asker — #${p.ackOf} came from ${target.from_thread}`);
              }
              if (tos[0] && tos[0] !== target.from_thread) {
                return fail(`bus: #${p.ackOf} came from ${target.from_thread}, not ${tos[0]} — an ack goes back to the asker`);
              }
              tos = [target.from_thread];
            }
            if (tos.length === 0) return fail(`bus: ${p.kind} needs --to <thread-id>`);

            // EVERY ADDRESS IS CHECKED BEFORE ANYTHING IS STORED. Validating inside the
            // fan-out loop would deliver to the recipients before the bad one and refuse
            // after — a partial send reported as a failure, which is the worst of the
            // three outcomes because the sender cannot tell what arrived. MX-852.
            const seen = new Set<string>();
            const recipients: string[] = [];
            // thread@server recipients in the shared space; a bare id keeps its local path.
            const remote = new Map<string, { thread: string; server: string }>();
            const cfg = tos.some((t) => t.includes("@")) ? await sharedCfg() : null;
            for (const t of tos) {
              // A repeat is dropped rather than refused: `--to A --to A` plainly means one
              // message to A, and two identical envelopes would each demand their own ack.
              if (seen.has(t)) continue;
              seen.add(t);
              if (t.includes("@")) {
                const a = parseAddress(t, cfg?.server ?? null);
                if ("error" in a) return fail(`${a.error}\n  NOTHING was sent: every --to is checked before any is delivered.`);
                if (a.kind === "remote") {
                  remote.set(t, a);
                  recipients.push(t);
                  continue;
                }
                // `thr_x@<this server>` is local: it continues below as the bare id.
                if (seen.has(a.thread)) continue;
                seen.add(a.thread);
                if (!(await knownThread(a.thread))) {
                  return fail(`bus: '${a.thread}' is not a thread bb knows — refusing. NOTHING was sent.`);
                }
                recipients.push(a.thread);
                continue;
              }
              if (!(await knownThread(t))) {
                return fail(
                  `bus: '${t}' is not a thread bb knows — refusing rather than delivering to a stranger.\n` +
                  `  a typo used to report 'woke 1/1' and the wrong thread answered politely.\n` +
                  `  NOTHING was sent: every --to is checked before any is delivered.`,
                );
              }
              recipients.push(t);
            }
            // EVERY REMOTE ADDRESS IS CHECKED BEFORE ANYTHING IS SENT, the same rule as local
            // ones (MX-852): the sender must have joined, and each recipient must be joined.
            if (remote.size) {
              if (!shared.joined(mine)) {
                return fail(`bus: ${mine} has not joined the shared space, so it cannot send across. ` +
                  `bb bus join --description '<one line>' — and decide for yourself whether this needs to cross.\n  NOTHING was sent.`);
              }
              let peers;
              try { peers = await cfg!.client.peers(); } catch (e) { return relayFail(e, "NOTHING was sent"); }
              shared.setPeers(peers);
              for (const [t, a] of remote) {
                if (!peers.some((x) => x.thread === a.thread && x.server === a.server)) {
                  return fail(`bus: '${t}' is not in the shared space — refused, never queued for later. ` +
                    `bb bus peers lists who has joined.\n  NOTHING was sent: every --to is checked before any is delivered.`);
                }
              }
            }

            let body: string | null = null;
            try {
              body = p.bodySource ? readBody(p.bodySource) : null;
            } catch (e) {
              return fail(`bus: could not read the body: ${e instanceof Error ? e.message : String(e)}`);
            }

            // Validate the envelope ONCE, against the first recipient. Every field the
            // schema checks is recipient-independent, so validating per recipient would
            // report the same refusal N times.
            const first = validate({ kind: p.kind, to: recipients[0]!, ref: p.ref, fields: p.fields, body, ackOf: p.ackOf });
            if (!first.ok) return fail(first.error);

            // ONE ENVELOPE PER RECIPIENT — the store's `to_addr` is a scalar, so a message
            // to four threads is four rows, four deliveries and four acks owed. That is
            // what the sender meant and what `bb bus unanswered` must be able to count.
            const parts: ReturnType<typeof receipt>[] = [];
            for (const t of recipients) {
              const v = t === recipients[0] ? first : validate({ kind: p.kind, to: t, ref: p.ref, fields: p.fields, body, ackOf: p.ackOf });
              if (!v.ok) return fail(v.error);
              const a = remote.get(t);
              if (a) {
                try {
                  const m = await cfg!.client.send({ from_thread: mine, to_thread: a.thread, to_server: a.server,
                    kind: v.envelope.kind, ref: v.envelope.ref, fields: v.envelope.fields, body: v.envelope.body,
                    ack_of: p.ackOfShared ? v.envelope.ackOf : null });
                  shared.putMessage(m, false, m.created);
                  parts.push({ stdout: `relayed x${m.id} ${m.kind} -> ${t}` +
                    (m.ack_required ? `\n  awaiting an ack — bb bus unanswered lists it if none comes.` : ""), stderr: null, exitCode: 0 });
                } catch (e) {
                  const r = relayFail(e, "this one was NOT sent");
                  parts.push({ stdout: `not delivered: ${v.envelope.kind} -> ${t}`, stderr: r.stderr, exitCode: r.exitCode as 0 | 1 });
                }
                continue;
              }
              const { seq, outcome } = await post(mine, v.envelope);
              parts.push(receipt({ seq, kind: v.envelope.kind, to: t, outcome, ackRequired: v.envelope.ackRequired }));
            }
            markRead();
            // The receipt names EVERY recipient. A one-line receipt for a four-way send is
            // how three dropped recipients read as success in the first place.
            const stdout = parts.map((r) => r.stdout).join("\n");
            const stderr = parts.map((r) => r.stderr).filter(Boolean).join("\n");
            const exitCode = parts.some((r) => (r.exitCode as number) === RC_UNREACHABLE) ? RC_UNREACHABLE
              : parts.some((r) => r.exitCode !== 0) ? 1 : 0;
            return stderr ? { exitCode, stdout, stderr } : { exitCode, stdout };
          }
        }
      } catch (e) {
        return fail(`bus: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  bb.log.info("bus plugin loaded");
}

/** Generated from the kind table, like everything else the CLI prints. */
function helpText(): string {
  return [
    "bb bus — typed peer bus between bb threads. One stream, no rooms.",
    "",
    "  claim <resource> --reason <r> [--ttl 30m] [--wait [--max-wait 2h]] [--shared] · heartbeat <r> [--shared] [--json] · lease <r> --shared --json · release <r> [--force --reason '<why>'] [--shared] · claims [--stale] [--mine]",
    "  log [--kind K] [--ref R] [--from T] [--to T] [--since <ts>] [--unread] [-n N] · unanswered [--minutes N] · build",
    "  shared space across servers: join --description '<one line>' · leave · peers · --to <thread-id>@<server> · --ack-of x<n>",
    "",
    "  send --kind <kind> --to <id>[@<server>] [--ref <ref>] [--field k=v]… [--body-file <p>]",
    "  the body comes from a file, NEVER from argv — your shell would substitute it first.",
    "",
    "  the twelve kinds (ack = someone owes you an answer; imm = steers a live turn):",
    ...KIND_NAMES.map((k) => {
      const s = KINDS[k];
      const tag = `${s.ack ? "ack " : "    "}${s.wake === "immediate" ? "imm" : "que"}`;
      return `    ${tag}  ${schemaLine(k)}`;
    }),
  ].join("\n");
}
