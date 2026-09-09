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
import { COMMANDS, UNREAD_SELF, parseClaim, parseLog, parseSend, parseSugar } from "./src/cli.ts";
import { KINDS, KIND_NAMES, isKind, schemaLine } from "./src/kinds.ts";
import { renderEnvelope, validate, type Envelope } from "./src/envelope.ts";
import { MIGRATIONS, createStore, type ClaimRow, type Db, type MessageRow } from "./src/store.ts";
import { DEFAULT_TTL_MS, attemptClaim, heartbeat, parseTtl, release } from "./src/claims.ts";
import { deliver, receipt, type Outcome } from "./src/delivery.ts";

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

/** The body, from stdin or a file — NEVER from argv. `cli.ts` refuses the third source. */
function readBody(src: { kind: "stdin" } | { kind: "file"; path: string } | null): string | null {
  if (!src) return null;
  const raw = src.kind === "stdin" ? readFileSync(0, "utf8") : readFileSync(src.path, "utf8");
  const t = raw.trim();
  return t === "" ? null : t;
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createStore(db as unknown as Db);

  // A DELETED OR ARCHIVED THREAD CANNOT HOLD pr:685 FOREVER. The old plugin dropped
  // room membership here; there is no membership now, and the thing that outlives a dead
  // thread and blocks everybody else is a claim. `released_by = 'expiry'` so the ledger
  // shows this was not the holder's own decision.
  const dropThread = (threadId: string) => store.releaseClaimsHeldBy(threadId, nowIso());
  bb.events.on("thread.archived", ({ thread }) => { dropThread(thread.id); });
  bb.events.on("thread.deleted", ({ thread }) => { dropThread(thread.id); });

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

  const fmtClaim = (c: ClaimRow, now: Date): string => {
    const state = c.released_ts ? `released by ${c.released_by}`
      : now.getTime() >= Date.parse(c.expires_ts) ? `EXPIRED ${c.expires_ts}`
      : `held until ${c.expires_ts}`;
    return `${c.resource}  ${c.holder}  ${state}  (${c.reason})`;
  };

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

      if (!me && cmd !== "help") {
        return fail("bus: no thread context — run from inside a bb thread");
      }
      const mine = me!;

      // `read_ts` is set on every row addressed to me when I next call ANY verb. Taken
      // AFTER the command has produced its output, so `log --unread` shows what was
      // unread at entry and marks it in the same breath.
      const markRead = () => store.markReadFor(mine, nowIso());

      try {
        switch (cmd) {
          case "claims": {
            const now = new Date();
            const rows = store.listClaims({
              stale: argv.includes("--stale") || undefined,
              mine: argv.includes("--mine") ? mine : undefined,
            });
            markRead();
            if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(rows) };
            return { exitCode: 0, stdout: rows.length ? rows.map((c) => fmtClaim(c, now)).join("\n") : "no claims" };
          }

          case "claim": {
            const p = parseClaim(argv);
            if ("error" in p) return fail(p.error);
            const bad = validate({ kind: "claim", to: mine, ref: null,
              fields: { resource: p.resource, ttl: p.ttl, reason: p.reason }, body: null, ackOf: null });
            if (!bad.ok) return fail(bad.error);
            const ttl = parseTtl(p.ttl);
            if ("error" in ttl) return fail(ttl.error);
            const now = new Date();
            const r = attemptClaim({ existing: store.getClaim(p.resource), resource: p.resource,
              holder: mine, reason: p.reason, ttlMs: ttl.ms, now });
            if (r.kind === "busy") {
              // THE ONE WAKE A CLAIM CAUSES GOES TO THE HOLDER, not to the second
              // claimant. Spec §4 says the busy answer is an immediate message to the
              // second claimant — but that is the caller, who already has it on stdout at
              // rc 75. The HOLDER is the only party not looking, and telling them somebody
              // is waiting is the thing that moves the resource along. README says so.
              const e = validate({ kind: "claim", to: r.holder.holder, ref: null,
                fields: { resource: p.resource, ttl: p.ttl, reason: p.reason }, body: null, ackOf: null });
              if (e.ok) await post(mine, e.envelope);
              markRead();
              return { exitCode: 75,
                stdout: `busy ${r.holder.holder} ${r.holder.reason} expires ${r.holder.expires_ts}`,
                stderr: `bus: ${r.holder.holder} holds ${p.resource}. It was told you are waiting.` };
            }
            store.putClaim(r.row);
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
            const resource = argv[1];
            if (!resource) return fail("usage: bb bus heartbeat <resource>");
            const existing = store.getClaim(resource);
            // The original ttl, so a heartbeat extends by what was asked for rather than
            // silently resetting every claim to the default.
            const ttlMs = existing
              ? Date.parse(existing.expires_ts) - Date.parse(existing.claimed_ts)
              : DEFAULT_TTL_MS;
            const r = heartbeat({ existing, holder: mine, ttlMs, now: new Date() });
            markRead();
            if ("error" in r) return fail(r.error);
            store.putClaim(r.row);
            return { exitCode: 0, stdout: `held ${resource} until ${r.row.expires_ts}` };
          }

          case "release": {
            const resource = argv[1];
            if (!resource) return fail("usage: bb bus release <resource> [--force --reason '<why>']");
            const force = argv.includes("--force");
            const ri = argv.indexOf("--reason");
            const reason = ri >= 0 ? argv[ri + 1] ?? null : null;
            const r = release({ existing: store.getClaim(resource), caller: mine, force, reason, now: new Date() });
            if ("error" in r) { markRead(); return fail(r.error); }
            store.putClaim(r.row);
            if (r.notifyHolder) {
              const e = validate({ kind: "release", to: r.notifyHolder, ref: null,
                fields: { resource }, body: reason, ackOf: null });
              if (e.ok) await post(mine, e.envelope);
            }
            markRead();
            return { exitCode: 0,
              stdout: `released ${resource}` + (r.notifyHolder ? ` (forced; ${r.notifyHolder} was told)` : "") };
          }

          case "log": {
            const f = parseLog(argv);
            if ("error" in f) return fail(f.error);
            if (f.unread === UNREAD_SELF) f.unread = mine;
            const rows = store.log(f);
            markRead();
            if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(rows) };
            return { exitCode: 0, stdout: rows.length ? rows.map(fmtMessage).join("\n") : "nothing matches" };
          }

          case "unanswered": {
            const mi = argv.indexOf("--minutes");
            const minutes = mi >= 0 ? parseInt(argv[mi + 1] ?? "30", 10) || 30 : 30;
            const rows = store.unanswered(minutes, new Date());
            markRead();
            if (!rows.length) return { exitCode: 0, stdout: `nothing unanswered older than ${minutes}m` };
            return { exitCode: 0,
              stdout: rows.map((m) => `${fmtMessage(m)}\n    ack it: bb bus ack --ack-of ${m.seq} --answer '<one line>'`).join("\n") };
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
            let to = p.to;
            if (p.kind === "ack" && p.ackOf !== null) {
              const target = store.getMessage(p.ackOf);
              if (!target) return fail(`bus: no message #${p.ackOf} to ack`);
              if (to && to !== target.from_thread) {
                return fail(`bus: #${p.ackOf} came from ${target.from_thread}, not ${to} — an ack goes back to the asker`);
              }
              to = target.from_thread;
            }
            if (!to) return fail(`bus: ${p.kind} needs --to <thread-id>`);
            if (!(await knownThread(to))) {
              return fail(
                `bus: '${to}' is not a thread bb knows — refusing rather than delivering to a stranger.\n` +
                `  a typo used to report 'woke 1/1' and the wrong thread answered politely.`,
              );
            }

            let body: string | null;
            try { body = readBody(p.bodySource); }
            catch (e) { return fail(`bus: could not read the body: ${e instanceof Error ? e.message : String(e)}`); }

            const v = validate({ kind: p.kind, to, ref: p.ref, fields: p.fields, body, ackOf: p.ackOf });
            if (!v.ok) return fail(v.error);

            const { seq, outcome } = await post(mine, v.envelope);
            markRead();
            const r = receipt({ seq, kind: v.envelope.kind, to, outcome, ackRequired: v.envelope.ackRequired });
            return r.stderr
              ? { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
              : { exitCode: r.exitCode, stdout: r.stdout };
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
    "  claim <resource> --reason <r> [--ttl 30m] · heartbeat <r> · release <r> [--force --reason '<why>'] · claims [--stale] [--mine]",
    "  log [--kind K] [--ref R] [--from T] [--to T] [--since <ts>] [--unread] [-n N] · unanswered [--minutes N] · build",
    "",
    "  send --kind <kind> --to <id> [--ref <ref>] [--field k=v]… [--body - | --body-file <p>]",
    "  the body comes from stdin or a file, NEVER from argv — your shell would substitute it first.",
    "",
    "  the twelve kinds (ack = someone owes you an answer; imm = steers a live turn):",
    ...KIND_NAMES.map((k) => {
      const s = KINDS[k];
      const tag = `${s.ack ? "ack " : "    "}${s.wake === "immediate" ? "imm" : "que"}`;
      return `    ${tag}  ${schemaLine(k)}`;
    }),
  ].join("\n");
}
