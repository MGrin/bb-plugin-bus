// Pure argument and message logic, split out of server.ts so `node --test` can
// reach it. Everything here decides WHAT to send and to whom; server.ts keeps
// the sqlite and the SDK calls.

export interface SendArgs {
  room: string | null;
  /** null = ambient (stored quietly), "all" = every other member, else a thread id. */
  to: string | null;
  text: string;
  error: string | null;
}

/**
 * Parse `bb bus send <room> [--to <id>|--to all] <text...>`.
 *
 * The flag can sit anywhere after the room, because that is how people type it,
 * and everything that is not the flag or its value is message body — including
 * words that look like flags. A bus message is prose, not a command line.
 */
export function parseSend(argv: string[]): SendArgs {
  const usage = "usage: bb bus send <room> [--to <thread-id>|--to all] <text...>";
  const room = argv[1] ?? null;
  if (!room) return { room: null, to: null, text: "", error: usage };

  let to: string | null = null;
  const rest: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--to") {
      const value = argv[++i];
      // `--to` with nothing after it must not silently degrade into an ambient
      // send: the caller asked to WAKE someone, and quietly not waking them is
      // the failure this bus exists to avoid.
      if (value === undefined) return { room, to: null, text: "", error: "bus: --to needs a thread id or 'all'" };
      to = value;
    } else {
      rest.push(argv[i]!);
    }
  }
  const text = rest.join(" ").trim();
  if (!text) return { room, to, text: "", error: "bus: empty message body refused" };
  return { room, to, text, error: null };
}

/**
 * Who gets woken. `--to all` means every OTHER member — waking yourself is a
 * loop, and a thread that wakes itself never goes idle.
 */
export function resolveRecipients(to: string | null, members: string[], me: string): string[] {
  if (!to) return [];
  if (to === "all") return members.filter((m) => m !== me);
  return [to];
}

export interface BusMessage {
  seq: number;
  room: string;
  created_ts: string;
  sender_thread: string;
  to_thread: string | null;
  text: string;
}

/** One line per message; the arrow only appears when the message was addressed. */
export const fmt = (m: BusMessage): string =>
  `#${m.seq} [${m.room}] ${m.created_ts} ${m.sender_thread}` +
  (m.to_thread ? ` -> ${m.to_thread}` : "") +
  `: ${m.text}`;
