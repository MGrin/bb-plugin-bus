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
import type { BbPluginApi } from "@get-bb/plugin-sdk";
// Argument parsing, recipient resolution and message formatting live in lib.ts
// so `node --test` can exercise them without bb, sqlite or a network.
import { execFileSync } from "node:child_process";
import {
  type BusMessage,
  PRIOR_CONTACT_SQL,
  type PriorContact,
  type WakeOutcome,
  deliverWake,
  firstContactNotice,
  fmt,
  parseSend,
  resolveRecipients,
  summariseDirectedSend,
  validateRoom,
  wakeText,
} from "./lib.ts";

/**
 * Which commit is this PROCESS running? (MX-139/MX-141)
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

  /**
   * Wake one recipient — or, when it is blocked on a human, hand the message to
   * bb's own queue so bb delivers it on unblock (MX-228). The decision lives in
   * `deliverWake` so `node --test` can exercise every branch of it; this
   * function is only the two SDK calls it chooses between.
   *
   * `queuedMessages.create` is deliberately NOT guarded against a pending
   * interaction, and a blocked thread reads `status: "active"`, so bb's
   * `queued-message-auto-send` sweep — which only visits IDLE threads — cannot
   * fire it early. It drains once the human has answered and the turn has ended.
   */
  async function wake(
    recipient: string,
    room: string,
    sender: string,
    text: string,
    sentAt: string,
  ): Promise<WakeOutcome> {
    const input = (deferredSentAt?: string) => [
      {
        type: "text" as const,
        mentions: [],
        text: wakeText({ room, sender, text, ...(deferredSentAt ? { deferredSentAt } : {}) }),
      },
    ];
    return deliverWake(
      {
        send: async () => {
          await bb.sdk.threads.send({
            threadId: recipient,
            mode: "auto",
            senderThreadId: sender,
            input: input(),
          });
        },
        defer: async () => {
          await bb.sdk.threads.queuedMessages.create({
            threadId: recipient,
            senderThreadId: sender,
            input: input(sentAt),
          });
        },
      },
      recipient,
    );
  }

  /**
   * Has `threadId` ever been part of `room`'s conversation before message `seq`?
   * (MX-213 — see firstContactNotice in lib.ts for why this signal and not another.)
   *
   * THREE-STATE, and the third one is the point. If the history cannot be read
   * the answer is "unknown" and the caller stays SILENT — never a warning, and
   * never a cheerful "prior" either. A warning that fires when the instrument is
   * blind is unfalsifiable noise; a check that reports OK when blind is the
   * `launchctl` failure this repo already documents. Neither is acceptable, so
   * the blind state is named and carried.
   */
  const priorContact = (room: string, threadId: string, seq: number): PriorContact => {
    try {
      const row = db.prepare(PRIOR_CONTACT_SQL).get(room, seq, threadId, threadId) as
        | { prior: number }
        | undefined;
      if (!row || typeof row.prior !== "number") return "unknown";
      return row.prior ? "prior" : "none";
    } catch {
      return "unknown";
    }
  };

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
        usage: 'bb bus send <room> [--to <thread-id>|--to all] [--] <text...>',
      },
      {
        name: "recv",
        summary: "Read unread messages in your rooms (advances your cursor)",
        usage: "bb bus recv [<room>]",
      },
      { name: "log", summary: "Show recent room history (cursor untouched)", usage: "bb bus log <room> [-n <count>]" },
      {
        name: "build",
        summary: "Which commit this RUNNING process was loaded from (not the checkout)",
        usage: "bb bus build [--json]",
      },
    ],
    async run(argv, ctx) {
      const me = ctx.threadId ?? null;
      const cmd = argv[0] ?? "help";
      const fail = (msg: string) => ({ exitCode: 1, stderr: msg });
      // BEFORE the thread-context gate below, deliberately: "what is running" must stay
      // answerable from anywhere, including outside a thread and when the plugin is broken.
      if (cmd === "build") {
        if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(BUILD_STAMP) };
        const dirty = BUILD_STAMP.dirty === null ? "" : BUILD_STAMP.dirty ? " +dirty" : "";
        const why = BUILD_STAMP.why ? `  (${BUILD_STAMP.why})` : "";
        return {
          exitCode: 0,
          stdout: `loaded ${BUILD_STAMP.rev ?? "unknown"}${dirty} from ${BUILD_STAMP.sourceDir} at ${BUILD_STAMP.loadedAt}${why}`,
        };
      }

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
          const written = db
            .prepare(`INSERT INTO messages (room, sender_thread, to_thread, text) VALUES (?, ?, ?, ?)`)
            .run(room, me, to === "all" ? "@all" : to, text);
          const members = (
            db.prepare(`SELECT thread_id FROM members WHERE room = ?`).all(room) as { thread_id: string }[]
          ).map((r) => r.thread_id);
          // AN AMBIENT SEND NOW SAYS WHO IT DID NOT WAKE (MX-148).
          //
          // `sent (ambient) -> room` is a true and completely uninterpretable receipt: it
          // returns cleanly, the room's message count rises — which is the check AGENTS.md
          // prescribes for the `--room` typo, and it passes here — and the message really
          // is in the room. What it does not say is that nobody was woken, so an
          // orchestrator that broadcast "the slot is FREE, take it" to three idle workers
          // stalled its own queue with a free box and three ready PRs (2026-08-19).
          //
          // The count is knowable at send time and is the one fact that would have made it
          // visible, so it is printed. IDLE is what matters rather than membership: an
          // ACTIVE thread reaches the room on its own turn, an idle one never does.
          //
          // The status lookup is capped. This is the hot path of every ambient send, and
          // this machine is regularly at load 50+ with bb dropping writes (MX-138/MX-146);
          // a broadcast to a large room must not turn into a burst of API calls. Above the
          // cap the honest answer is the membership count, which needs no calls at all.
          if (!to) {
            const others = members.filter((m) => m !== me);
            if (others.length === 0) return { exitCode: 0, stdout: `sent (ambient) -> ${room} — no other members` };
            const IDLE_PROBE_CAP = 8;
            let detail = `${others.length} other member(s) NOT woken`;
            if (others.length <= IDLE_PROBE_CAP) {
              const states = await Promise.all(
                others.map(async (id) => {
                  try {
                    return String((await bb.sdk.threads.get({ threadId: id })).status ?? "?");
                  } catch {
                    return "gone";
                  }
                }),
              );
              const idle = states.filter((x) => x === "idle").length;
              detail = `${others.length} other member(s) NOT woken, ${idle} of them IDLE`;
            }
            return {
              exitCode: 0,
              stdout:
                `sent (ambient) -> ${room} — stored for recv/log, woke NOBODY. ${detail}. ` +
                `An idle thread will not see this until it looks; if the message contains an ` +
                `INSTRUCTION, resend with --to <thread-id>.`,
            };
          }
          const recipients = resolveRecipients(to, members, me!);
          // Stamped from the row rather than the clock so a replayed message
          // names the time `bb bus log` shows for it.
          const sentAt = (
            (db.prepare(`SELECT created_ts FROM messages WHERE seq = ?`).get(written.lastInsertRowid) ?? {
              created_ts: "",
            }) as { created_ts: string }
          ).created_ts;
          const outcomes: WakeOutcome[] = [];
          for (const r of recipients) {
            outcomes.push(await wake(r, room, me!, text, sentAt));
          }
          // A DIRECTED SEND TO A STRANGER NOW SAYS SO (MX-213). `woke 1/1` is true of a
          // correct address and of a typo'd one alike — that is how #4828 reached a thread
          // that has never joined anything, which answered politely, and the sender learned
          // nothing. The notice rides on the SAME receipt because that is the one thing the
          // sender is guaranteed to look at. It is never a refusal: the send already
          // happened by this line, and first contact is how every new worker gets briefed.
          const notice = firstContactNotice(
            to,
            room,
            priorContact(room, to!, Number(written.lastInsertRowid)),
          );
          const receipt = summariseDirectedSend(room, outcomes);
          const stdout = receipt.stdout + (notice ? `\n${notice}` : "");
          return receipt.stderr
            ? { exitCode: receipt.exitCode, stdout, stderr: receipt.stderr }
            : { exitCode: receipt.exitCode, stdout };
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
              '  send <room> [--to <thread-id>|--to all] [--] <text...>   (no --to = ambient, wakes nobody)',
              '     --to is the ONLY flag; room and message are positional. `--` = rest is literal text.',
              "  recv [<room>] · log <room> [-n N]",
            ].join("\n"),
          };
      }
    },
  });

  bb.log.info("bus plugin loaded");
}
