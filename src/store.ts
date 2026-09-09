// The store: two tables, and every statement over them in one place. Spec §1.
//
// No rooms, no members, no cursors. Rooms carried 2% of 22,532 messages and 446 of
// the 472 ambient ones reached nobody — the `ref` field and the `kind` filter give the
// selectivity rooms were meant to provide, and they work on a stream nobody has to
// have joined.
import type { Envelope } from "./envelope.ts";

/** The narrow slice of `better-sqlite3` this module needs — enough to fake in a test. */
export interface Db {
  prepare(sql: string): {
    run(...a: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...a: unknown[]): unknown;
    all(...a: unknown[]): unknown[];
  };
}

export interface MessageRow {
  seq: number;
  kind: string;
  from_thread: string;
  to_addr: string;
  ref: string | null;
  fields: string;
  body: string | null;
  ack_required: number;
  ack_of: number | null;
  created_ts: string;
  delivered_ts: string | null;
  read_ts: string | null;
}

export interface ClaimRow {
  resource: string;
  holder: string;
  reason: string;
  claimed_ts: string;
  heartbeat_ts: string;
  expires_ts: string;
  released_ts: string | null;
  released_by: string | null;
  stale: number;
}

export interface LogFilter {
  kind?: string;
  ref?: string;
  from?: string;
  to?: string;
  since?: string;
  /** A thread id: rows addressed to it with no `read_ts`. */
  unread?: string;
  limit: number;
}

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS messages (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     from_thread TEXT NOT NULL,
     to_addr TEXT NOT NULL,
     ref TEXT,
     fields TEXT NOT NULL,
     body TEXT,
     ack_required INTEGER NOT NULL,
     ack_of INTEGER,
     created_ts TEXT NOT NULL,
     delivered_ts TEXT,
     read_ts TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS claims (
     resource TEXT PRIMARY KEY,
     holder TEXT NOT NULL,
     reason TEXT NOT NULL,
     claimed_ts TEXT NOT NULL,
     heartbeat_ts TEXT NOT NULL,
     expires_ts TEXT NOT NULL,
     released_ts TEXT,
     released_by TEXT,
     stale INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_to_unread ON messages(to_addr, read_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_ref ON messages(ref)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_ack_of ON messages(ack_of)`,
] as const;

/**
 * Ack-required rows older than the cutoff with NO ack row pointing at them.
 *
 * The `NOT EXISTS` is the whole point. A LEFT JOIN with a COUNT reports 0 both for a
 * row that HAS been answered and for one nothing ever looked at, and separating those
 * two is the entire reason this query exists — the corpus held 1,646 of the second kind
 * and no way to name them.
 */
const UNANSWERED_SQL = `
  SELECT * FROM messages m
   WHERE m.ack_required = 1
     AND m.created_ts <= ?
     AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.kind = 'ack' AND a.ack_of = m.seq)
   ORDER BY m.created_ts ASC, m.seq ASC`;

export interface Store {
  insertMessage(from: string, e: Envelope, now: string): number;
  getMessage(seq: number): MessageRow | null;
  markDelivered(seq: number, now: string): void;
  markReadFor(thread: string, now: string): number;
  log(f: LogFilter): MessageRow[];
  unanswered(minutes: number, now: Date): MessageRow[];
  getClaim(resource: string): ClaimRow | null;
  putClaim(c: ClaimRow): void;
  listClaims(f: { stale?: boolean; mine?: string }): ClaimRow[];
  releaseClaimsHeldBy(thread: string, now: string): number;
}

export function createStore(db: Db): Store {
  return {
    insertMessage(from, e, now) {
      const r = db
        .prepare(
          `INSERT INTO messages
             (kind, from_thread, to_addr, ref, fields, body, ack_required, ack_of, created_ts)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(e.kind, from, e.to, e.ref, JSON.stringify(e.fields), e.body,
             e.ackRequired ? 1 : 0, e.ackOf, now);
      return Number(r.lastInsertRowid);
    },

    getMessage(seq) {
      return (db.prepare(`SELECT * FROM messages WHERE seq = ?`).get(seq) as MessageRow) ?? null;
    },

    markDelivered(seq, now) {
      db.prepare(`UPDATE messages SET delivered_ts = ? WHERE seq = ?`).run(now, seq);
    },

    // Returns how many rows it touched, so a caller can say whether anything was waiting.
    markReadFor(thread, now) {
      return db
        .prepare(`UPDATE messages SET read_ts = ? WHERE to_addr = ? AND read_ts IS NULL`)
        .run(now, thread).changes;
    },

    log(f) {
      const where: string[] = [];
      const args: unknown[] = [];
      const add = (sql: string, v: unknown) => { where.push(sql); args.push(v); };
      if (f.kind) add(`kind = ?`, f.kind);
      if (f.ref) add(`ref = ?`, f.ref);
      if (f.from) add(`from_thread = ?`, f.from);
      if (f.to) add(`to_addr = ?`, f.to);
      if (f.since) add(`created_ts >= ?`, f.since);
      if (f.unread) { where.push(`to_addr = ? AND read_ts IS NULL`); args.push(f.unread); }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      // DESC + LIMIT then reverse: the limit must keep the NEWEST rows, and the output
      // must read oldest-first. Doing it the other way silently shows the oldest N.
      return (db
        .prepare(`SELECT * FROM messages ${clause} ORDER BY seq DESC LIMIT ?`)
        .all(...args, f.limit) as MessageRow[]).reverse();
    },

    // The arithmetic is in TypeScript, never in SQL's datetime('now'): a test that
    // cannot move the clock cannot test an expiry, and it would have to wait 30 minutes.
    unanswered(minutes, now) {
      const cutoff = new Date(now.getTime() - minutes * 60_000).toISOString();
      return db.prepare(UNANSWERED_SQL).all(cutoff) as MessageRow[];
    },

    getClaim(resource) {
      return (db.prepare(`SELECT * FROM claims WHERE resource = ?`).get(resource) as ClaimRow) ?? null;
    },

    // REPLACE, not INSERT: taking over an expired claim writes the same primary key, and
    // the loss of the old holder is recorded on the `claim` message row, not here.
    putClaim(c) {
      db.prepare(
        `INSERT OR REPLACE INTO claims
           (resource, holder, reason, claimed_ts, heartbeat_ts, expires_ts, released_ts, released_by, stale)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(c.resource, c.holder, c.reason, c.claimed_ts, c.heartbeat_ts, c.expires_ts,
            c.released_ts, c.released_by, c.stale);
    },

    listClaims(f) {
      const where: string[] = [];
      const args: unknown[] = [];
      if (f.stale) where.push(`stale = 1`);
      if (f.mine) { where.push(`holder = ?`); args.push(f.mine); }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return db.prepare(`SELECT * FROM claims ${clause} ORDER BY resource`).all(...args) as ClaimRow[];
    },

    // A deleted or archived thread cannot hold pr:685 forever. Called from the two
    // thread lifecycle events; `released_by` says `expiry` so the ledger shows it was
    // not the holder's own decision.
    releaseClaimsHeldBy(thread, now) {
      return db
        .prepare(
          `UPDATE claims SET released_ts = ?, released_by = 'expiry'
            WHERE holder = ? AND released_ts IS NULL`,
        )
        .run(now, thread).changes;
    },
  };
}
