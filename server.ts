// bb-plugin-bus — peer session bus between bb threads.
//
// Successor of the paos bus, redesigned around bb primitives:
// - Identity is the bb thread id (visible, addressable — no random handles).
// - No listener process, no wake loop: an addressed message wakes the
//   recipient through bb.sdk.threads.send (queues on idle, steers a running
//   turn). A session can never be "deaf".
// - Presence derives from thread lifecycle: archived/deleted threads drop out
//   of every room automatically.
// - A room send without --to is ambient: stored for recv/log, wakes nobody.
import type { BbPluginApi } from "@bb/plugin-sdk";
// Argument parsing, recipient resolution and message formatting live in lib.ts
// so `node --test` can exercise them without bb, sqlite or a network.
import { type BusMessage, fmt, parseSend, resolveRecipients, validateRoom } from "./lib.ts";

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS rooms (
       name TEXT PRIMARY KEY,
       created_ts TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS members (
       room TEXT NOT NULL,
       thread_id TEXT NOT NULL,
       joined_ts TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (room, thread_id)
     )`,
    `CREATE TABLE IF NOT EXISTS messages (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       room TEXT NOT NULL,
       sender_thread TEXT NOT NULL,
       to_thread TEXT,
       text TEXT NOT NULL,
       created_ts TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS cursors (
       room TEXT NOT NULL,
       thread_id TEXT NOT NULL,
       last_seq INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (room, thread_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room, seq)`,
  ]);

  const dropThread = (threadId: string) => {
    db.prepare(`DELETE FROM members WHERE thread_id = ?`).run(threadId);
    db.prepare(`DELETE FROM cursors WHERE thread_id = ?`).run(threadId);
  };
  bb.events.on("thread.archived", ({ thread }) => dropThread(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => dropThread(thread.id));

  async function wake(
    recipient: string,
    room: string,
    sender: string,
    text: string,
  ): Promise<string | null> {
    try {
      await bb.sdk.threads.send({
        threadId: recipient,
        mode: "auto",
        senderThreadId: sender,
        input: [
          {
            type: "text",
            mentions: [],
            text:
              `[bus:${room}] message from thread ${sender}:\n${text}\n\n` +
              `(Reply: \`bb bus send ${room} --to ${sender} "<text>"\` · backlog: \`bb bus recv\`)`,
          },
        ],
      });
      return null;
    } catch (e) {
      return `${recipient}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  bb.cli.register({
    name: "bus",
    summary: "Peer session bus: rooms, presence, and messages between bb threads",
    commands: [
      { name: "join", summary: "Join (create if needed) a room", usage: "bb bus join <room>" },
      { name: "leave", summary: "Leave a room", usage: "bb bus leave <room>" },
      { name: "rooms", summary: "List rooms with member/message counts", usage: "bb bus rooms" },
      { name: "who", summary: "List members with live thread status", usage: "bb bus who [<room>]" },
      {
        name: "send",
        summary:
          "Send to a room. Ambient by default; --to <thread-id> or --to all wakes recipients with a delivered turn",
        usage: 'bb bus send <room> [--to <thread-id>|--to all] <text...>',
      },
      {
        name: "recv",
        summary: "Read unread messages in your rooms (advances your cursor)",
        usage: "bb bus recv [<room>]",
      },
      { name: "log", summary: "Show recent room history (cursor untouched)", usage: "bb bus log <room> [-n <count>]" },
    ],
    async run(argv, ctx) {
      const me = ctx.threadId ?? null;
      const cmd = argv[0] ?? "help";
      const fail = (msg: string) => ({ exitCode: 1, stderr: msg });
      if (!me && !["rooms", "log", "who", "help"].includes(cmd)) {
        return fail("bus: no thread context — run from inside a bb thread");
      }
      // One gate for the whole surface. `join` is where a flag in the room
      // slot did the real damage: it CREATED the bogus room, after which
      // `send` found it and stopped complaining. Guarding send alone would
      // leave that door open.
      if (argv[1] !== undefined && cmd !== "help") {
        const badRoom = validateRoom(argv[1]);
        if (badRoom) return fail(badRoom);
      }

      switch (cmd) {
        case "join": {
          const room = argv[1];
          if (!room) return fail("usage: bb bus join <room>");
          db.prepare(`INSERT OR IGNORE INTO rooms (name) VALUES (?)`).run(room);
          db.prepare(`INSERT OR IGNORE INTO members (room, thread_id) VALUES (?, ?)`).run(room, me);
          const max = db
            .prepare(`SELECT COALESCE(MAX(seq),0) AS s FROM messages WHERE room = ?`)
            .get(room) as { s: number };
          db.prepare(
            `INSERT OR REPLACE INTO cursors (room, thread_id, last_seq) VALUES (?, ?, ?)`,
          ).run(room, me, max.s);
          return { exitCode: 0, stdout: `joined ${room} as ${me}` };
        }
        case "leave": {
          const room = argv[1];
          if (!room) return fail("usage: bb bus leave <room>");
          db.prepare(`DELETE FROM members WHERE room = ? AND thread_id = ?`).run(room, me);
          db.prepare(`DELETE FROM cursors WHERE room = ? AND thread_id = ?`).run(room, me);
          return { exitCode: 0, stdout: `left ${room}` };
        }
        case "rooms": {
          const rows = db
            .prepare(
              `SELECT r.name,
                      (SELECT COUNT(*) FROM members m WHERE m.room = r.name) AS members,
                      (SELECT COUNT(*) FROM messages x WHERE x.room = r.name) AS msgs,
                      (SELECT MAX(created_ts) FROM messages x WHERE x.room = r.name) AS last
               FROM rooms r
               ORDER BY last IS NULL, last DESC`,
            )
            .all() as { name: string; members: number; msgs: number; last: string | null }[];
          if (!rows.length) return { exitCode: 0, stdout: "no rooms" };
          return {
            exitCode: 0,
            stdout: rows
              .map((r) => `${r.name}  members=${r.members} msgs=${r.msgs} last=${r.last ?? "-"}`)
              .join("\n"),
          };
        }
        case "who": {
          const room = argv[1];
          const rows = (
            room
              ? db.prepare(`SELECT room, thread_id FROM members WHERE room = ?`).all(room)
              : db.prepare(`SELECT room, thread_id FROM members ORDER BY room`).all()
          ) as { room: string; thread_id: string }[];
          if (!rows.length) return { exitCode: 0, stdout: "no members" };
          // One lookup per DISTINCT thread, fetched concurrently — a thread in
          // five rooms used to cost five sequential round-trips.
          const ids = [...new Set(rows.map((r) => r.thread_id))];
          const info = new Map(
            await Promise.all(
              ids.map(async (id): Promise<[string, { status: string; title: string }]> => {
                try {
                  const t = await bb.sdk.threads.get({ threadId: id });
                  return [id, { status: String(t.status ?? "?"), title: t.title ?? "" }];
                } catch {
                  return [id, { status: "gone", title: "" }];
                }
              }),
            ),
          );
          const lines = rows.map((r) => {
            const t = info.get(r.thread_id)!;
            return `[${r.room}] ${r.thread_id}  status=${t.status}  ${t.title}`;
          });
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        case "send": {
          const parsed = parseSend(argv);
          if (parsed.error) return fail(parsed.error);
          const room = parsed.room!;
          const to = parsed.to;
          const text = parsed.text;
          if (!db.prepare(`SELECT 1 FROM rooms WHERE name = ?`).get(room)) {
            return fail(`bus: no such room '${room}' — bb bus join ${room} first`);
          }
          db.prepare(
            `INSERT INTO messages (room, sender_thread, to_thread, text) VALUES (?, ?, ?, ?)`,
          ).run(room, me, to === "all" ? "@all" : to, text);
          if (!to) return { exitCode: 0, stdout: `sent (ambient) -> ${room}` };
          const members = (
            db.prepare(`SELECT thread_id FROM members WHERE room = ?`).all(room) as { thread_id: string }[]
          ).map((r) => r.thread_id);
          const recipients = resolveRecipients(to, members, me!);
          const errors: string[] = [];
          for (const r of recipients) {
            const err = await wake(r, room, me!, text);
            if (err) errors.push(err);
          }
          const okCount = recipients.length - errors.length;
          const summary = `sent -> ${room}, woke ${okCount}/${recipients.length}`;
          return errors.length
            ? { exitCode: 1, stdout: summary, stderr: `wake failures:\n${errors.join("\n")}` }
            : { exitCode: 0, stdout: summary };
        }
        case "recv": {
          const onlyRoom = argv[1];
          const myRooms = (
            db.prepare(`SELECT room FROM members WHERE thread_id = ?`).all(me) as { room: string }[]
          )
            .map((r) => r.room)
            .filter((r) => !onlyRoom || r === onlyRoom);
          if (!myRooms.length) return { exitCode: 0, stdout: "not in any rooms" };
          const out: string[] = [];
          for (const room of myRooms) {
            const cur = (db
              .prepare(`SELECT last_seq FROM cursors WHERE room = ? AND thread_id = ?`)
              .get(room, me) ?? { last_seq: 0 }) as { last_seq: number };
            const msgs = db
              .prepare(
                `SELECT seq, room, sender_thread, to_thread, text, created_ts
                 FROM messages WHERE room = ? AND seq > ? AND sender_thread != ?
                 ORDER BY seq LIMIT 50`,
              )
              .all(room, cur.last_seq, me) as BusMessage[];
            // Advance ONLY to the last message actually returned. Jumping to
            // MAX(seq) silently destroyed everything past the LIMIT: with >50
            // unread, messages 51+ were skipped forever and could never be
            // recovered by another recv.
            if (msgs.length) {
              db.prepare(
                `INSERT OR REPLACE INTO cursors (room, thread_id, last_seq) VALUES (?, ?, ?)`,
              ).run(room, me, msgs[msgs.length - 1]!.seq);
            }
            out.push(...msgs.map(fmt));
            const remaining = (
              db
                .prepare(
                  `SELECT COUNT(*) AS n FROM messages WHERE room = ? AND seq > ? AND sender_thread != ?`,
                )
                .get(room, msgs.length ? msgs[msgs.length - 1]!.seq : cur.last_seq, me) as { n: number }
            ).n;
            if (remaining > 0) out.push(`… ${remaining} more in ${room} — run recv again`);
          }
          return { exitCode: 0, stdout: out.length ? out.join("\n") : "no new messages" };
        }
        case "log": {
          const room = argv[1];
          if (!room) return fail("usage: bb bus log <room> [-n <count>]");
          const nIdx = argv.indexOf("-n");
          const n = nIdx >= 0 ? Math.min(parseInt(argv[nIdx + 1] ?? "20", 10) || 20, 200) : 20;
          const msgs = (
            db
              .prepare(
                `SELECT seq, room, sender_thread, to_thread, text, created_ts
                 FROM messages WHERE room = ? ORDER BY seq DESC LIMIT ?`,
              )
              .all(room, n) as BusMessage[]
          ).reverse();
          return { exitCode: 0, stdout: msgs.length ? msgs.map(fmt).join("\n") : "empty room" };
        }
        default:
          return {
            exitCode: 0,
            stdout: [
              "bb bus — peer session bus between bb threads",
              "  join <room> · leave <room> · rooms · who [<room>]",
              '  send <room> [--to <thread-id>|--to all] <text...>   (no --to = ambient, wakes nobody)',
              "  recv [<room>] · log <room> [-n N]",
            ].join("\n"),
          };
      }
    },
  });

  bb.log.info("bus plugin loaded");
}
