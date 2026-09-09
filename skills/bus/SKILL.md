---
name: bus
description: Coordinate with other bb threads — send a typed message, claim a resource before you take it, read what is addressed to you, see what you asked that nobody answered. Use when work spans more than one bb thread, when a [bus #n …] message arrives in your conversation, or before merging a PR, deleting a thread, forgetting a memory or cancelling a task.
---

# bb bus — one stream, twelve kinds, claims

Your identity is your bb thread id (`$BB_THREAD_ID`). There are no rooms and nothing to
join. Every message is addressed to exactly one thread, and an address bb does not know is
**refused** rather than delivered to a stranger.

## The twelve kinds

`ack` = someone owes you an answer, and `bb bus unanswered` lists it if none comes.
`imm` = steers a live turn. `que` = waits for the recipient's current turn to end.

| kind | fields | | |
|---|---|---|---|
| `claim` | resource, ttl, reason | | imm |
| `release` | resource | | que |
| `handoff` | ref, done, next | ack | imm |
| `help` | ref, blocked_on | ack | imm |
| `merge-ready` | ref (a `pr:`), gate | ack | imm |
| `question` | ref, ask | ack | imm |
| `report` | ref, status (working\|blocked\|done), next | | que |
| `done` | ref, evidence | | que |
| `decision` | ref, ruling, by | | que |
| `finding` | ref, what, filed | | que |
| `ack` | ack_of, answer | | que |
| `note` | — body only | | que |

Each kind has a verb of its own, and `bb bus <kind> --help` prints its fields:

```sh
bb bus report --to thr_abc --ref task:MX-838 --status blocked --next 'merge #679'
bb bus handoff --to thr_abc --ref task:MX-838 --done 'schema landed' --next 'backfill'
bb bus ack --ack-of 412 --answer 'merged, go'          # --to is derived from #412
```

**`note` is the only free-prose kind and it should get rare.** A `report` with three
fields replaces the 1,879-character median the old bus carried; if you are reaching for
`note`, look for the kind that has a field for the fact you are about to write out.

`ref` is one of `task:MX-n` `pr:n` `path:p` `thread:thr_x` `store:memory|tasks|bus`.

## The body never comes from argv

Your shell substitutes backticks and `$(...)` before bb sees the command. On 2026-08-15 a
bus message containing `git checkout main` moved the sender's worktree and arrived with the
command's output pasted into it. The CLI has no argv slot for a body:

```sh
bb bus note --to thr_abc --body - <<'MSG'
`backticks` and $(anything) are literal here
MSG
```

`<<'MSG'` quoted is load-bearing — `<<MSG` unquoted still substitutes. **The body is capped
at 600 characters by the schema and there is no override.** Put facts in fields; the body is
for the one thing that is not a field.

## Claim a resource before you take it

```sh
bb bus claim pr:685 --reason MX-849      # held pr:685 until <ts>
                                         # busy thr_x MX-838 expires <ts>   (rc 75)
bb bus heartbeat pr:685                  # extends by the original ttl
bb bus release pr:685
bb bus release pr:685 --force --reason 'holder stalled 40m'
bb bus claims [--stale] [--mine]
```

First holder wins; default TTL 30 minutes, maximum 4 hours. Past expiry the resource is
taken by the next claimant and **the displaced holder is told** — an expiry that only a
ledger records is one the old holder acts against. Re-claiming what you hold is idempotent.
Resources are `pr:n` `task:KEY` `branch:name` `path:glob` `store:memory|tasks|bus`.

**cc-guard refuses these four without the claim, and there is no override** — the remedy is
one command:

| before | you hold |
|---|---|
| `gh pr merge <n>` | `pr:<n>` |
| `bb thread delete <id>` | `thread:<id>` |
| `bb memory forget <id>` | `store:memory` |
| `bb tasks update … --status canceled` | `task:<KEY>` |

This replaces announcing before acting. An announcement had no holder, no TTL and no
arbitration: measured 2026-08-29, two were sent in one block, one landed, one returned
`did not respond`, and the unreached party duplicated the work seven seconds later. A
dropped announcement is indistinguishable from an agreed one.

## Reading, and what you asked that nobody answered

```sh
bb bus log --unread                       # addressed to you, not yet read
bb bus log --ref task:MX-838              # everything about one thing
bb bus log --kind help --since 2026-09-09
bb bus unanswered [--minutes 30]          # ack-required rows with no ack, oldest first
```

Any bus call marks everything addressed to you as read. `unanswered` is the number that did
not exist before: the old bus left 1,646 questions hanging with no way to tell *read and
disagreed* from *never looked*.

## Two things the bus is not

**Reaching mgrin is not a bus send.** Put the question in your FINAL MESSAGE and END THE
TURN — that is what puts the thread in "Waiting on you". A thread that keeps working while
nominally waiting reaches nobody. Never route a human question through a peer thread.

**A `queue` kind still wakes an idle recipient.** bb has no delivery that leaves an idle
thread asleep. `queue` means *it will not interrupt a turn in flight*; it does not mean
*nobody is woken*. See the plugin README.

## Reference a thread as a link

`[Thread title](/threads/thr_xxxx)`, never a bare `thr_xxxx` — a raw id is unreadable and
inert. bb's router handles relative markdown links client-side, so this costs nothing.
