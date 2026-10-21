// THE SHARED STORE (MX-1528): this server's copy of what crossed, in a SEPARATE FILE.
//
// `shared.db` sits beside the plugin's `data.db` and is ATTACHed to the same connection
// as schema `shared`. It is a separate file on purpose: crossed messages may carry
// secrets, and a backup that copies `data.db` (the maintainer's nightly dump into a git
// repo does) must not be able to reach them. A table inside `data.db` that a dump skips
// is one forgotten exclusion away from a secret in git history for ever; a file the dump
// never names is not.
//
// Nothing here is the authority. The relay owns who is joined, every crossed message and
// every shared claim; this is the copy that makes `bb bus log` work offline and lets a
// LOCAL claim check the shared ones without a network call.
import { dirname, join } from "node:path";
import type { Db, LogFilter } from "../store.ts";
import type { LeaveCause, Peer, RelayClaim, RelayMessage } from "./relay.ts";

/** A crossed message that failed delivery this many times is left for `log` to show. */
export const MAX_ATTEMPTS = 5;

export interface SharedRow {
  relay_id: number;
  kind: string;
  from_thread: string;
  from_server: string;
  to_thread: string;
  to_server: string;
  ref: string | null;
  fields: string;
  body: string | null;
  ack_required: number;
  ack_of: number | null;
  created_ts: string;
  delivered_ts: string | null;
  read_ts: string | null;
  attempts: number;
  last_error: string | null;
}

export interface JoinedRow { thread: string; description: string; joined_ts: string }

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS shared.messages (
     relay_id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL,
     from_thread TEXT NOT NULL, from_server TEXT NOT NULL,
     to_thread TEXT NOT NULL, to_server TEXT NOT NULL,
     ref TEXT, fields TEXT NOT NULL, body TEXT,
     ack_required INTEGER NOT NULL, ack_of INTEGER,
     created_ts TEXT NOT NULL, delivered_ts TEXT, read_ts TEXT,
     attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`,
  `CREATE INDEX IF NOT EXISTS shared.idx_shared_to ON messages(to_server, to_thread, read_ts)`,
  `CREATE TABLE IF NOT EXISTS shared.joined (thread TEXT PRIMARY KEY, description TEXT NOT NULL, joined_ts TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shared.peers (thread TEXT NOT NULL, server TEXT NOT NULL, description TEXT NOT NULL,
     joined TEXT NOT NULL, PRIMARY KEY (thread, server))`,
  `CREATE TABLE IF NOT EXISTS shared.claims (resource TEXT PRIMARY KEY, row TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shared.pending_leaves (thread TEXT PRIMARY KEY, cause TEXT NOT NULL, ts TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shared.meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

/** `shared.db` beside the main database file; in-memory when the main one is. */
export function sharedPathFor(db: Db): string {
  const rows = db.prepare(`SELECT name, file FROM pragma_database_list`).all() as { name: string; file: string }[];
  const main = rows.find((r) => r.name === "main")?.file ?? "";
  return main ? join(dirname(main), "shared.db") : ":memory:";
}

/** ATTACH (once per connection) and create the schema. Idempotent. */
export function attachShared(db: Db, path: string): void {
  const attached = (db.prepare(`SELECT name FROM pragma_database_list`).all() as { name: string }[])
    .some((r) => r.name === "shared");
  if (!attached) db.prepare(`ATTACH DATABASE ? AS shared`).run(path);
  if (path !== ":memory:") db.prepare(`PRAGMA shared.journal_mode = WAL`).get();
  for (const s of SCHEMA) db.prepare(s).run();
}

export interface SharedStore {
  /** INSERT OR IGNORE by relay id. `deliverable` false stores it as already given up on. */
  putMessage(m: RelayMessage, deliverable: boolean, deliveredTs?: string | null): boolean;
  getMessage(relayId: number): SharedRow | null;
  undelivered(myServer: string): SharedRow[];
  markDelivered(relayId: number, ts: string): void;
  markFailed(relayId: number, error: string): void;
  markReadFor(thread: string, myServer: string, ts: string): number;
  log(f: LogFilter, myServer: string): SharedRow[];
  unanswered(minutes: number, now: Date): SharedRow[];
  setPeers(p: Peer[]): void;
  peers(): Peer[];
  setClaims(c: RelayClaim[]): void;
  claims(): RelayClaim[];
  claim(resource: string): RelayClaim | null;
  upsertClaim(c: RelayClaim): void;
  dropClaim(resource: string): void;
  join(thread: string, description: string, ts: string): void;
  leave(thread: string): void;
  joined(thread: string): JoinedRow | null;
  joinedAll(): JoinedRow[];
  addPendingLeave(thread: string, cause: LeaveCause, ts: string): void;
  pendingLeaves(): { thread: string; cause: LeaveCause; ts: string }[];
  removePendingLeave(thread: string): void;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

/** `thr_x@srv` names exactly that; a bare `thr_x` names a thread on THIS server. */
function addr(spec: string, myServer: string): [string, string] {
  const at = spec.indexOf("@");
  return at < 0 ? [spec, myServer] : [spec.slice(0, at), spec.slice(at + 1)];
}

export function createSharedStore(db: Db): SharedStore {
  return {
    putMessage(m, deliverable, deliveredTs = null) {
      return db.prepare(
        `INSERT OR IGNORE INTO shared.messages
           (relay_id, kind, from_thread, from_server, to_thread, to_server, ref, fields, body,
            ack_required, ack_of, created_ts, delivered_ts, attempts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(m.id, m.kind, m.from_thread, m.from_server, m.to_thread, m.to_server, m.ref,
            JSON.stringify(m.fields ?? {}), m.body, m.ack_required ? 1 : 0, m.ack_of, m.created,
            deliveredTs, deliverable ? 0 : MAX_ATTEMPTS).changes === 1;
    },
    getMessage(id) {
      return (db.prepare(`SELECT * FROM shared.messages WHERE relay_id = ?`).get(id) as SharedRow) ?? null;
    },
    undelivered(myServer) {
      return db.prepare(`SELECT * FROM shared.messages WHERE to_server = ? AND delivered_ts IS NULL
                           AND attempts < ? ORDER BY relay_id`).all(myServer, MAX_ATTEMPTS) as SharedRow[];
    },
    markDelivered(id, ts) {
      db.prepare(`UPDATE shared.messages SET delivered_ts = ?, last_error = NULL WHERE relay_id = ?`).run(ts, id);
    },
    markFailed(id, error) {
      db.prepare(`UPDATE shared.messages SET attempts = attempts + 1, last_error = ? WHERE relay_id = ?`).run(error, id);
    },
    markReadFor(thread, myServer, ts) {
      return db.prepare(`UPDATE shared.messages SET read_ts = ? WHERE to_thread = ? AND to_server = ? AND read_ts IS NULL`)
        .run(ts, thread, myServer).changes;
    },
    log(f, myServer) {
      const where: string[] = [];
      const args: unknown[] = [];
      if (f.kind) { where.push(`kind = ?`); args.push(f.kind); }
      if (f.ref) { where.push(`ref = ?`); args.push(f.ref); }
      if (f.from) { where.push(`from_thread = ? AND from_server = ?`); args.push(...addr(f.from, myServer)); }
      if (f.to) { where.push(`to_thread = ? AND to_server = ?`); args.push(...addr(f.to, myServer)); }
      if (f.since) { where.push(`created_ts >= ?`); args.push(f.since); }
      if (f.unread) { where.push(`to_thread = ? AND to_server = ? AND read_ts IS NULL`); args.push(f.unread, myServer); }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return (db.prepare(`SELECT * FROM shared.messages ${clause} ORDER BY relay_id DESC LIMIT ?`)
        .all(...args, f.limit) as SharedRow[]).reverse();
    },
    unanswered(minutes, now) {
      const cutoff = new Date(now.getTime() - minutes * 60_000).toISOString();
      return db.prepare(
        `SELECT * FROM shared.messages m WHERE m.ack_required = 1 AND m.created_ts <= ?
            AND NOT EXISTS (SELECT 1 FROM shared.messages a WHERE a.kind = 'ack' AND a.ack_of = m.relay_id)
          ORDER BY m.created_ts, m.relay_id`).all(cutoff) as SharedRow[];
    },
    setPeers(p) {
      db.prepare(`DELETE FROM shared.peers`).run();
      const ins = db.prepare(`INSERT OR REPLACE INTO shared.peers (thread, server, description, joined) VALUES (?,?,?,?)`);
      for (const x of p) ins.run(x.thread, x.server, x.description, x.joined);
    },
    peers() {
      return db.prepare(`SELECT thread, server, description, joined FROM shared.peers ORDER BY server, joined`).all() as Peer[];
    },
    setClaims(c) {
      db.prepare(`DELETE FROM shared.claims`).run();
      const ins = db.prepare(`INSERT OR REPLACE INTO shared.claims (resource, row) VALUES (?, ?)`);
      for (const x of c) ins.run(x.resource, JSON.stringify(x));
    },
    claims() {
      return (db.prepare(`SELECT row FROM shared.claims ORDER BY resource`).all() as { row: string }[])
        .map((r) => JSON.parse(r.row) as RelayClaim);
    },
    claim(resource) {
      const r = db.prepare(`SELECT row FROM shared.claims WHERE resource = ?`).get(resource) as { row: string } | undefined;
      return r ? (JSON.parse(r.row) as RelayClaim) : null;
    },
    upsertClaim(c) {
      db.prepare(`INSERT OR REPLACE INTO shared.claims (resource, row) VALUES (?, ?)`).run(c.resource, JSON.stringify(c));
    },
    dropClaim(resource) {
      db.prepare(`DELETE FROM shared.claims WHERE resource = ?`).run(resource);
    },
    join(thread, description, ts) {
      db.prepare(`INSERT OR REPLACE INTO shared.joined (thread, description, joined_ts) VALUES (?,?,?)`).run(thread, description, ts);
    },
    leave(thread) {
      db.prepare(`DELETE FROM shared.joined WHERE thread = ?`).run(thread);
    },
    joined(thread) {
      return (db.prepare(`SELECT * FROM shared.joined WHERE thread = ?`).get(thread) as JoinedRow) ?? null;
    },
    joinedAll() {
      return db.prepare(`SELECT * FROM shared.joined ORDER BY joined_ts`).all() as JoinedRow[];
    },
    addPendingLeave(thread, cause, ts) {
      db.prepare(`INSERT OR REPLACE INTO shared.pending_leaves (thread, cause, ts) VALUES (?,?,?)`).run(thread, cause, ts);
    },
    pendingLeaves() {
      return db.prepare(`SELECT thread, cause, ts FROM shared.pending_leaves ORDER BY ts`).all() as
        { thread: string; cause: LeaveCause; ts: string }[];
    },
    removePendingLeave(thread) {
      db.prepare(`DELETE FROM shared.pending_leaves WHERE thread = ?`).run(thread);
    },
    getMeta(key) {
      return (db.prepare(`SELECT value FROM shared.meta WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null;
    },
    setMeta(key, value) {
      db.prepare(`INSERT OR REPLACE INTO shared.meta (key, value) VALUES (?, ?)`).run(key, value);
    },
  };
}
