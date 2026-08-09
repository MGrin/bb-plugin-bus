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
- **Humans are not on the bus.** To reach the user, finish your turn with the
  question in your final message (they read threads in the bb app, including
  from their phone). Never relay a human question through a peer thread.
- Membership is cleaned automatically when a thread is archived or deleted;
  `bb bus who` shows live status of every member.
