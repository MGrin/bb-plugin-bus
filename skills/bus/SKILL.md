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

`ref` is one of `task:MX-n` `pr:n` `pr:owner/repo#n` `path:p` `store:memory|tasks|bus`.

## The body comes from a FILE

Your shell substitutes backticks and `$(...)` before bb sees the command. On 2026-08-15 a
bus message containing `git checkout main` moved the sender's worktree and arrived with the
command's output pasted into it. The CLI has no argv slot for a body:

```sh
cat > /tmp/msg <<'MSG'
`backticks` and $(anything) are literal here
MSG
bb bus note --to thr_abc --body-file /tmp/msg
```

`<<'MSG'` quoted is load-bearing — `<<MSG` unquoted still substitutes.

**`--body -` does not exist and refuses by name.** bb does not forward stdin to a plugin
CLI: the plugin runs inside the bb *server*, so a piped body reached nothing. It shipped
that way for an hour on 2026-09-09 and stored EMPTY bodies at rc 0, telling every sender it
had worked — which is why the flag refuses instead of merely being absent.

**The body is capped at 600 characters by the schema and there is no override.** Put facts
in fields; the body is for the one thing that is not a field.

## Claim a resource before you take it

```sh
bb bus claim pr:685 --reason MX-849      # held pr:685 until <ts>
                                         # busy thr_x MX-838 expires <ts>   (rc 75)
bb bus heartbeat pr:685                  # extends by the original ttl
bb bus release pr:685
bb bus release pr:685 --force --reason 'holder stalled 40m'
bb bus claims [--stale] [--mine]          # waiters are listed under each claim
bb bus claim path:/x --reason BX-1 --wait [--max-wait 2h]   # join the FIFO wait list
                                         # waiting 2 for thr_x MX-838 expires <ts>   (rc 75)
```

**A busy claim tells the holder ONCE** (MX-1400): your first plain attempt wakes it, later
identical attempts are rc 75 and wake nobody until the holder takes a new claim. Polling
gains you nothing.

**Waiting for a busy slot: `--wait`, never a poll loop** (MX-1390). It is still rc 75 —
you do not hold it, so `claim --wait && run` does not run. You are on a FIFO list; when the
holder releases, expires or is archived, the slot is **granted to the head** and a
`[bus #n claim …] reason="GRANTED to you from the wait list"` message wakes you. A grant
holds only **10 minutes**: re-run the same `bb bus claim … --ttl <yours>` to take your full
ttl, or `bb bus release` it. Nobody can jump the list — a plain claim on a slot with waiters
is `busy` to the head. Re-running `--wait` keeps your first place. You leave the list with
`bb bus release <r>`, at `--max-wait` (default 2h, max 4h), or when your thread is archived.

**No renewal while anyone waits** (MX-1394). With a non-empty wait list, the holder's
`heartbeat` AND its re-claim are refused at rc 75, naming the waiters: a contended claim
lasts the ttl you asked for. **Size `--ttl` to the run up front.** The one renewal allowed is
a granted waiter confirming its 10-minute pickup. Nobody waiting = heartbeat as before.

First holder wins; default TTL 30 minutes, maximum 4 hours. Past expiry the resource is
taken by the next claimant and **the displaced holder is told** — an expiry that only a
ledger records is one the old holder acts against. Re-claiming what you hold is idempotent.

**`bb bus claims` lists RELEASED and EXPIRED rows too — read the state column:**
`held until <ts>` is live; `EXPIRED <ts>` is a TTL that ran out (the next claimant takes
it); `released by <thread>` is a release, own or `--force`; `released by thread-archived`
or `thread-deleted` means **the holder's thread was archived or deleted**, and every claim
it held went with it. That last one is never a TTL: a live thread that sees it lost its
claims to a lifecycle event, and should re-claim and say so (MX-1280 — it read `released
by expiry` until then, and a 2h claim gone at 10.6 min was taken for an advisory TTL).
Resources are `pr:n` `pr:owner/repo#n` `task:KEY` `branch:name` `path:glob` `thread:thr_x` `store:memory|tasks|bus`.

**A bare `pr:n` is a MGrin/dotfiles PR. Any other repo is `pr:<owner>/<repo>#<n>`**, e.g.
`bb bus claim 'pr:MGrin/bb-plugin-bus#27'` (quote it: an unquoted `#` is a comment or a glob operator in some shells).
`pr:MGrin/dotfiles#27` and `pr:27` are ONE claim, and owner/repo compare case-insensitively
(MX-1312 — `pr:bb-plugin-bus-27` was refused and the merge went ahead unclaimed).

**A `path:` claim is keyed by the FILE, not by what you typed.** A relative path is read
from the root of the repo your shell stands in, and every git worktree of a repo maps to its
main checkout. So `path:setup/phases`, `path:./setup/phases/` and the absolute path are one
resource, two worktrees of one repo collide, and `path:README.md` in two different repos is
two resources. A relative path from OUTSIDE a repo is refused — claim the absolute path.
**Do not prefix the repo's own name**: `path:dotfiles/setup/phases` is read from the repo
root, so it names `<repo>/dotfiles/setup/phases` — a different key from the
`path:setup/phases` the next thread claims for the same lock. That shape is refused with the
corrected spelling (MX-1203). The deploy lock is **`path:setup/phases`** and the full-gate
lock is **`path:.mx-gate`**, both repo-relative and already repo-scoped by the key.
`claims` shows `<as typed> = <key>` when the two differ; `--json` keeps `resource` as typed
and adds `key`.

**Claim these four before you take them.** The store arbitrates today: the first holder
wins and a second claimant gets `busy` at **rc 75**, which is real and enforced here.

**cc-guard does NOT yet refuse them.** `bus_claim_required` is specified in
`docs/guard/mx849-handoff.md` and lands on MX-812; the deployed binary has no such rule —
measured 2026-09-09, zero hits for `claim` in its `--help` and no source on main. So this
is a CONVENTION you are asked to keep, not a refusal that will stop you, and a session that
skips it gets no warning. Flip this paragraph when MX-812 deploys.

| before | you hold |
|---|---|
| `gh pr merge <n>` (dotfiles) | `pr:<n>` |
| `gh pr merge <n> -R <owner>/<repo>` | `pr:<owner>/<repo>#<n>` |
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
