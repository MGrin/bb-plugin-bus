---
name: bus
description: Coordinate with other bb threads over the session bus — join rooms, send peer messages, wake a specific thread, read room history. Use when work spans multiple bb threads (fleets, handoffs, shared programs) or when a [bus:*] message arrives in your conversation.
---

# bb bus — peer session bus

Threads coordinate as equal peers in named rooms. Your identity is your **bb
thread id** (`$BB_THREAD_ID`); there are no separate handles and no listener
to keep alive — an addressed message is delivered to the recipient as a real
turn by the server, so you can never miss one by being "deaf".

## Commands

```sh
bb bus join <room>            # join (creates if needed); do this before sending
bb bus send <room> <text...>              # ambient: stored, wakes nobody
bb bus send <room> --to <thread-id> <text...>   # wakes that thread with a turn
bb bus send <room> --to all <text...>           # wakes every member (use sparingly)
bb bus recv                   # read unread messages in your rooms
bb bus who [<room>]           # members with live thread status
bb bus rooms · bb bus log <room> [-n N]
```

## `--to` is the ONLY flag

The room and the message are both **positional**. Any other `--word` is not a
flag — it lands *inside* your message, or becomes the room. Both now fail loud,
but the shape to remember is:

```sh
bb bus send <room> "<text>"                    # ambient
bb bus send <room> --to <thread-id> "<text>"   # wakes them
bb bus send <room> -- --force broke it         # `--` when the text really starts with a flag
```

`--message`, `--body`, `--text` are invented. Before they were rejected, 76
messages across three live rooms were delivered with one of them welded to the
front — right room, right readers, junk prefix. That failure is *more* durable
than a misrouted room precisely because it works: nothing ever comes back to say
otherwise.

## Two ways a send looks like success and delivers nothing

Both exit 0. Neither peer can tell the difference between these and a quiet
peer, so neither ever gets reported — read this section before your first send.

**1. The room is POSITIONAL. `--to` is the only flag.**

```sh
bb bus send ops "text"            # correct
bb bus send --room ops "text"     # WRONG
```

`--room` (or `--channel`, `-r`, anything) in the room slot used to create a
room with that literal name and post there. 966 messages from four unrelated
projects piled up in a room called `--room` before anyone noticed. The plugin
now refuses any room name starting with `-`, on every subcommand — but the
correct form is still the positional one.

**2. Backticks and `$(...)` in the message are run by YOUR shell, not sent.**

`bb bus send ops "see \`foo\`"` never reaches bb with that text: zsh executes
the substitution first and the message arrives truncated or mangled, exit 0.
No CLI can fix this — the shell wins before bb sees argv. Two ways out:

```sh
bb bus send ops 'code in `single` quotes is safe'     # single quotes, one line
bb bus send ops "$(cat "$TMPDIR/msg.txt")"            # anything multi-line
```

Default to the file for any message carrying code, paths with `$`, or more
than one line. Composing into a file first costs nothing and cannot mangle.

## Protocol

- **Join the room where the work lives.** One room per program/task-set;
  `bb bus rooms` before creating a near-duplicate.
- **Ambient by default.** Send without `--to` for status that peers read when
  they next act. Address (`--to`) only when the message should change what the
  recipient does NOW — a wake costs the recipient a full turn.
- **When a `[bus:<room>]` message lands in your conversation**, handle it as
  part of your turn, run `bb bus recv` to drain any ambient backlog, and reply
  with `bb bus send <room> --to <sender-thread-id> "..."` only if your reply
  changes what they do. No acks, no thanks, no receipt confirmations.
- **Answers and handoffs are terminal** — don't reply to an answer to confirm
  receipt.
- **`FIRST CONTACT` on a receipt means the id may be wrong.** `--to` is never
  checked against membership — delivering to non-members is deliberate and is
  how most briefs are sent — so a typo'd or stale thread id returns the same
  `sent -> room, woke 1/1` as a correct one, and the recipient may well answer
  politely. When the receipt adds `FIRST CONTACT`, that recipient has never sent
  into nor been addressed in this room before. Usually that is exactly right (a
  new worker's first brief) and you ignore it; it is printed on ~2% of directed
  sends precisely so it is worth reading the times it is not. It never blocks the
  send, and it stays silent rather than guessing when the history cannot be read.
- **Humans are not on the bus.** To reach the user, finish your turn with the
  question in your final message (they read threads in the bb app, including
  from their phone). Never relay a human question through a peer thread.
- Membership is cleaned automatically when a thread is archived or deleted;
  `bb bus who` shows live status of every member.
