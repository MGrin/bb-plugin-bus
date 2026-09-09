// argv parsing and the command list, BOTH derived from the kind table.
//
// The old CLI had three copies of its argument list — the parser, the `commands:` array
// bb prints, and the `default:` help block — and they drifted. Here there is one loop
// over KIND_NAMES, so a kind added to src/kinds.ts gets its verb, its usage line, its
// validation and its refusal text from that one row.
import { KINDS, KIND_NAMES, schemaLine, type Kind } from "./kinds.ts";
import type { LogFilter } from "./store.ts";

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
}

const FIXED: readonly Command[] = [
  { name: "send", summary: "Send a typed message",
    usage: "bb bus send --kind <kind> --to <thread-id> [--ref <ref>] [--field k=v]… [--body - | --body-file <p>]" },
  { name: "claim", summary: "Take a resource exclusively",
    usage: "bb bus claim <resource> --reason <r> [--ttl 30m]" },
  { name: "heartbeat", summary: "Extend your claim by its ttl",
    usage: "bb bus heartbeat <resource>" },
  { name: "release", summary: "Release a resource you hold",
    usage: "bb bus release <resource> [--force --reason '<why>']" },
  { name: "claims", summary: "List claims",
    usage: "bb bus claims [--stale] [--mine]" },
  { name: "log", summary: "Query history (the only read of it)",
    usage: "bb bus log [--kind K] [--ref R] [--from T] [--to T] [--since <ts>] [--unread] [-n N]" },
  { name: "unanswered", summary: "Ack-required rows with no ack",
    usage: "bb bus unanswered [--minutes N]" },
  { name: "build", summary: "Which commit this RUNNING process was loaded from",
    usage: "bb bus build [--json]" },
];

/** `blocked_on` is a field name; `--blocked-on` is how it is typed. One conversion. */
export const flagOf = (field: string): string => `--${field.replace(/_/g, "-")}`;
const fieldOf = (flag: string): string => flag.replace(/^--/, "").replace(/-/g, "_");

// One sugar verb per kind, its usage GENERATED from that kind's own field list.
// `claim` and `release` already have verbs in FIXED — those verbs write the `claim`
// and `release` message rows, so a second spelling would be two ways to do one thing.
const SUGAR: readonly Command[] = KIND_NAMES
  .filter((k) => k !== "claim" && k !== "release")
  .map((k) => ({
    name: k,
    summary: `Send a ${k} (sugar over send; same validation) — ${schemaLine(k)}`,
    usage: `bb bus ${k} --to <thread-id>` +
      KINDS[k].fields.map((f) => ` ${flagOf(f)} <${f}>`).join("") +
      ` [--body -]`,
  }));

export const COMMANDS: readonly Command[] = [...FIXED, ...SUGAR];

/** A file, and only a file — see STDIN_DOES_NOT_REACH_THE_PLUGIN. */
export type BodySource = { kind: "file"; path: string };

export interface ParsedSend {
  kind: string;
  to: string | null;
  ref: string | null;
  fields: Record<string, string>;
  bodySource: BodySource | null;
  ackOf: number | null;
  error: string | null;
}

/**
 * A BODY NEVER COMES FROM ARGV, and this is the sentence that closes the incident.
 *
 * Measured twice on 2026-08-15: a message containing a workflow command launched a real
 * workflow run, and one containing `git checkout main` moved the sender's worktree and
 * arrived with the command's OUTPUT pasted into it. bb cannot defend against it — by the
 * time it reads argv the substitution has already happened — so the only fix is a CLI
 * that has no argv slot to put a body in.
 */
const NO_ARGV_BODY =
  "bus: a message body never comes from argv — your shell substitutes backticks and " +
  "$(...) before bb sees it, which is how a bus message ran `git checkout main` on " +
  "2026-08-15.\n" +
  "  write it to a file with a QUOTED heredoc, then pass the path:\n" +
  "    cat > /tmp/msg <<'MSG'\n" +
  "    …\n" +
  "    MSG\n" +
  "    bb bus <verb> … --body-file /tmp/msg";

/**
 * `--body -` IS REFUSED BY NAME, and this is a defect it shipped with for one hour.
 *
 * bb NEVER FORWARDS STDIN TO A PLUGIN CLI. `PluginCliContext` is exactly
 * {cwd, threadId, projectId, signal}, and the plugin runs inside the bb SERVER, not in
 * the process the human piped into — so `readFileSync(0)` read the server's fd 0 and got
 * nothing. Measured 2026-09-09: `printf 'hello' | bb bus note --to me --body -` returned
 * rc=0, printed `queued #5 note`, and stored a row with NO BODY.
 *
 * That is the worst shape available: every sender is told it worked. A missing feature is
 * survivable, a silent empty one is not — so the flag does not merely stop working, it
 * refuses by name and says why. Removing it without a refusal would leave every existing
 * caller silently sending nothing.
 */
const STDIN_DOES_NOT_REACH_THE_PLUGIN =
  "bus: --body - does not work and never did: bb does not forward stdin to a plugin CLI.\n" +
  "  The plugin runs inside the bb SERVER, so it reads the server's stdin, not yours —\n" +
  "  measured 2026-09-09, a piped body stored an EMPTY row at rc 0.\n" +
  "  Use a file, which the plugin can read because it is on this machine:\n" +
  "    cat > /tmp/msg <<'MSG'\n" +
  "    …\n" +
  "    MSG\n" +
  "    bb bus <verb> … --body-file /tmp/msg";

const blank = (): ParsedSend => ({
  kind: "", to: null, ref: null, fields: {}, bodySource: null, ackOf: null, error: null,
});

/** Pull `--flag value` pairs; anything positional after the verb is the argv-body error. */
function walk(
  argv: readonly string[],
  take: (flag: string, value: string) => string | null,
): string | null {
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    if (!w.startsWith("--") && !(w === "-n")) return NO_ARGV_BODY;
    const next = argv[i + 1];
    if (next === undefined) return `bus: ${w} needs a value`;
    i++;
    const e = take(w, next);
    if (e) return e;
  }
  return null;
}

function setBody(p: ParsedSend, flag: string, v: string): string | null {
  if (flag === "--body") return STDIN_DOES_NOT_REACH_THE_PLUGIN;
  p.bodySource = { kind: "file", path: v };
  return null;
}

export function parseSend(argv: readonly string[]): ParsedSend {
  const p = blank();
  p.error = walk(argv, (flag, v) => {
    switch (flag) {
      case "--kind": p.kind = v; return null;
      case "--to": p.to = v; return null;
      case "--ref": p.ref = v; return null;
      case "--ack-of": {
        const n = Number(v);
        if (!Number.isInteger(n)) return `bus: --ack-of must be a number, got '${v}'`;
        p.ackOf = n;
        return null;
      }
      case "--field": {
        const eq = v.indexOf("=");
        if (eq <= 0) return `bus: --field takes k=v, got '${v}'`;
        p.fields[v.slice(0, eq)] = v.slice(eq + 1);
        return null;
      }
      case "--body": case "--body-file": return setBody(p, flag, v);
      default: return `bus: send has no flag '${flag}'`;
    }
  });
  if (p.error) return p;
  if (!p.kind) p.error = "bus: send needs --kind <kind>";
  else if (!p.to) p.error = "bus: send needs --to <thread-id> — there is no ambient send";
  return p;
}

/**
 * The sugar verbs. They produce the SAME `ParsedSend` as `send`, and the test asserts
 * the two parses are deep-equal — which is what keeps sugar from becoming a second
 * validator that accepts something the real one would not.
 */
export function parseSugar(verb: string, argv: readonly string[]): ParsedSend {
  const kind = verb as Kind;
  const spec = KINDS[kind];
  const allowed = new Set(spec.fields.map(flagOf));
  const p = blank();
  p.kind = verb;
  p.error = walk(argv, (flag, v) => {
    if (flag === "--to") { p.to = v; return null; }
    if (flag === "--ref") { p.ref = v; return null; }
    if (flag === "--body" || flag === "--body-file") return setBody(p, flag, v);
    if (!allowed.has(flag)) {
      return `bus: ${verb} has no flag '${flag}'.\n  schema: ${schemaLine(kind)}`;
    }
    if (flag === "--ack-of") {
      const n = Number(v);
      if (!Number.isInteger(n)) return `bus: --ack-of must be a number, got '${v}'`;
      p.ackOf = n;
      return null;
    }
    p.fields[fieldOf(flag)] = v;
    return null;
  });
  // No --to check here: `ack` derives its recipient from the row it acks, and every
  // other kind is caught by envelope validation, which owns that rule already.
  return p;
}

/** `--unread` carries no value; the caller substitutes its own thread id for SELF. */
export const UNREAD_SELF = "SELF";

export function parseLog(argv: readonly string[]): LogFilter | { error: string } {
  const f: LogFilter = { limit: 20 };
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    // The BARE flags. Treating every flag as taking a value made `bb bus log --json`
    // refuse with "--json needs a value" — found by the live suite, which reads --json.
    if (w === "--unread") { f.unread = UNREAD_SELF; continue; }
    if (w === "--json") continue;
    const v = argv[i + 1];
    if (v === undefined) return { error: `bus: ${w} needs a value` };
    i++;
    switch (w) {
      case "--kind": f.kind = v; break;
      case "--ref": f.ref = v; break;
      case "--from": f.from = v; break;
      case "--to": f.to = v; break;
      case "--since": f.since = v; break;
      // Capped at 200: an unbounded page over a machine-lifetime stream is a way to
      // fill a turn's context with history nobody asked for.
      case "-n": f.limit = Math.min(parseInt(v, 10) || 20, 200); break;
      default: return { error: `bus: log has no flag '${w}'` };
    }
  }
  return f;
}

export function parseClaim(
  argv: readonly string[],
): { resource: string; ttl: string; reason: string } | { error: string } {
  const resource = argv[1];
  if (!resource || resource.startsWith("-")) {
    return { error: "usage: bb bus claim <resource> --reason <r> [--ttl 30m]" };
  }
  let ttl = "30m";
  let reason = "";
  for (let i = 2; i < argv.length; i++) {
    const w = argv[i]!;
    const v = argv[i + 1];
    if (v === undefined) return { error: `bus: ${w} needs a value` };
    i++;
    if (w === "--ttl") ttl = v;
    else if (w === "--reason") reason = v;
    else return { error: `bus: claim has no flag '${w}'` };
  }
  if (!reason) {
    return { error: "bus: claim needs --reason <task key or one line> — a claim nobody can attribute is not auditable" };
  }
  return { resource, ttl, reason };
}
