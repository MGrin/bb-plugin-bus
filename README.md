# bb-plugin-bus

A typed peer bus between [bb](https://getbb.app) threads.

One stream, twelve message kinds, and TTL'd resource claims. A thread's identity is its bb
thread id; an address bb does not know is refused rather than delivered. Delivery rides on
bb's own send primitive — no listener process, nothing to poll, and a session cannot go deaf.

```sh
bb plugin install git:https://github.com/MGrin/bb-plugin-bus.git@main
```

## Usage

```sh
bb bus send --kind <kind> --to <thread-id> [--ref <ref>] [--field k=v]… [--body-file <p>]
bb bus <kind> --to <thread-id> …                 # one verb per kind; same validation
bb bus claim <resource> --reason <r> [--ttl 30m] [--wait [--max-wait 2h]] # held / busy / waiting (rc 75)
bb bus heartbeat <resource> · release <resource> [--force --reason '<why>'] · claims [--stale] [--mine]
bb bus log [--kind K] [--ref R] [--from T] [--to T] [--since <ts>] [--unread] [-n N]
bb bus unanswered [--minutes N] · build
bb bus join --description '<one line>' · leave · peers   # the shared space across servers
bb bus send … --to <thread-id>@<server> · ack --ack-of x<n> · claim … --shared
```

## The shared space across bb servers

Threads on several bb servers can share one space through a small relay. It is **opt-in
twice**: a server takes part only once its three settings are set, and a thread takes part
only once it runs `bb bus join`. A thread that never joined does not exist for the other
servers, and nothing about the local bus changes for it.

- **Addresses.** `thr_x@<server>` is a joined thread on another server; a bare id stays
  local. Crossed messages use the same twelve kinds, fields, 600-character cap, acks and
  wake modes, and show in `log`, `log --unread` and `unanswered` as `x<n>`.
- **Who reads what.** The relay keeps every message for good. A message is readable only
  with the sending or the receiving server's token; the peer list and the shared claims
  are readable by every server. The token is the whole boundary: whoever runs the relay
  can read everything on it.
- **Shared claims** (`--shared`) behave like local ones — first holder wins, rc 75, ttl,
  heartbeat, wait list, release on archive — settled by the relay. An unreachable relay
  is **rc 69**, never a fallback to a local claim. A local claim checks this server's copy
  of the shared claims, so it never makes a network call.
- **Delivery.** Nothing connects into a server. Each server asks the relay every 10 s,
  stores what is new and delivers it with the same primitive as a local message; a failed
  delivery is retried five times and then left visible in `bb bus log`.
- **Storage.** Crossed messages and the shared state live in `shared.db`, a separate file
  beside `data.db`, so a backup of `data.db` never carries a crossed secret.
- **No content filter.** What crosses is the sending agent's decision. The skill carries
  the rule (nothing personal, no memories, a secret only when needed).

**Join a server** — one command, which installs or updates the plugin and asks for the
token without echoing it:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/MGrin/bb-plugin-bus/main/scripts/install-shared.sh) \
  --server <this server's name> --relay <relay URL>
```

The relay is not part of this repository. It speaks a small JSON protocol under `/v2`
(peers, messages, sync, claims) with one bearer token per server; `src/shared/relay.ts` is
the client and the contract.

## The kind table

| kind | required fields | ack | wake |
|---|---|---|---|
| `claim` | `resource`, `ttl`, `reason` | — | immediate |
| `release` | `resource` | — | queue |
| `handoff` | `ref`, `done`, `next` | **yes** | immediate |
| `help` | `ref`, `blocked_on` | **yes** | immediate |
| `merge-ready` | `ref` (a `pr:`), `gate` | **yes** | immediate |
| `question` | `ref`, `ask` | **yes** | immediate |
| `report` | `ref`, `status` ∈ `working\|blocked\|done`, `next` | — | queue |
| `done` | `ref`, `evidence` | — | queue |
| `decision` | `ref`, `ruling`, `by` | — | queue |
| `finding` | `ref`, `what`, `filed` | — | queue |
| `ack` | `ack_of`, `answer` | — | queue |
| `note` | — (body only) | — | queue |

`src/kinds.ts` is the single source for this table. The CLI's verbs, usage lines, help text,
validation and every refusal message are derived from it, so adding a kind is one row and a
test — never a convention in a skill.

The body is optional on every kind, comes from **`--body-file <path>` and nothing else**,
and is **capped at 600 characters by the schema, with no override**.

**`--body -` does not exist and refuses by name.** bb does not forward stdin to a plugin
CLI — `PluginCliContext` is `{cwd, threadId, projectId, signal}` and the plugin runs inside
the bb *server* — so a piped body read the server's fd 0 and arrived empty. It shipped that
way for an hour on 2026-09-09, storing empty rows at rc 0 while telling every sender it had
worked. The flag refuses rather than being silently absent, because removing it quietly
would leave every existing caller sending nothing. The cap it replaces was a hook, and it was overridden 3,603 times against 96
refusals. `note` is the only free-prose kind and the plugin reports its share so it can be
watched shrinking.

## The shape

One responsibility per unit, and `server.ts` decides nothing — that is what keeps every
rule reachable by `node --test` without bb running.

| unit | responsibility |
|---|---|
| `src/kinds.ts` | **the kind table** — the single source for fields, ack and wake mode |
| `src/refs.ts` | the two prefixed vocabularies (`ref` and `resource` are not the same) |
| `src/envelope.ts` | validation, `BODY_CAP`, the one-line injected form |
| `src/store.ts` | the three tables — `messages`, `claims`, `claim_waiters` — and every statement over them |
| `src/claims.ts` | the claim state machine, pure over an injected clock |
| `src/delivery.ts` | one delivery primitive, two modes, the 409 fallback |
| `src/cli.ts` | argv; the verb list is generated from the kind table |
| `src/shared/` | the shared space: address, relay client, `shared.db` store, sync, rendering |
| `server.ts` | bb wiring only |

## Claims

First holder wins; a second claimant gets `busy` at rc 75. Default TTL 30 minutes, maximum
4 hours; `heartbeat` extends by the original TTL. Past expiry the resource is taken by the
next claimant and **the displaced holder is told** — an expiry that only a ledger records is
one the old holder acts against. Archiving or deleting a thread releases its claims, so a
dead thread cannot hold `pr:685` forever.

**A busy claim tells the holder once** (MX-1400). A plain claim on a held resource sends the
holder one `claim` message per claimant per holder claim: a claimant polling every 15 s
woke one holder 7 times for one wait on 2026-10-04. Later attempts are still rc 75 with the
same output and post nothing. "Already told" is read from the message rows themselves — a
`claim` from that claimant to that holder about the same key since the holder's
`claimed_ts` — so there is no table to keep in step, and a new holder claim (a release and
re-take, an expiry and take, a renewal) resets it. A `--wait` join still tells the holder.

**The wait list** (MX-1390). `claim --wait` joins a FIFO list for a held resource (still rc
75). A release, an expiry or the holder's archive grants the slot to the head, as a `claim`
message to it; the grant holds 10 minutes until the waiter re-claims for its own ttl, so a
waiter that went idle cannot rebuild the 3-hour idle hold that prompted this. A plain claim
cannot jump the list. A waiter leaves at `--max-wait` (default 2h), by `release`, or when its
thread is archived or deleted. Because an expiry nobody touches would otherwise strand the
head, the server arms ONE timer for the earliest expiry among waited claims; with nobody
waiting it arms nothing.

**No renewal while anyone waits** (MX-1394). With a non-empty list, `heartbeat` and the
holder's own re-claim are refused at rc 75, naming the waiters, so a contended claim lasts
the ttl its holder asked for; the 3-hour idle hold on 2026-10-02 was a renewed one. The one
exception is a granted waiter confirming its pickup. With nobody waiting, nothing changed.

Enforcement is SPECIFIED AND NOT YET DEPLOYED, and the difference is the whole point of
saying so here. `bus_claim_required` reads this store read-only and refuses `gh pr merge
<n>` without `pr:<n>`, `bb thread delete <id>` without `thread:<id>`, `bb memory forget
<id>` without `store:memory`, and a task cancel without `task:<KEY>` — with no override env
var. It is written up in the machine's `docs/guard/mx849-handoff.md` and lands on MX-812;
the deployed cc-guard binary has no such rule, measured 2026-09-09.

Until it does, the claim is arbitrated by this store alone: the first holder wins and a
second claimant gets `busy` at rc 75. That is real. What is absent is the STOP — a session
that never claims is not corrected by anything, which is exactly the failure mode a
document asserting the refusal would hide.

## What `queue` mode does and does not buy

**bb has no delivery that leaves an idle thread asleep, and this plugin does not pretend
otherwise.** Measured against bb 2026-09-09:

- The send-mode enum is `start | auto | steer | steer-if-active | queue-if-active`. There is
  no plain `queue`. `queue-if-active` queues only when the thread is ACTIVE; on an idle
  thread `resolveSendMode` returns `start` and a turn begins.
- `queuedMessages.create` is the same: `createQueuedMessageForThread` requests an immediate
  auto-send when the target is idle, and a periodic sweep visits every idle thread holding a
  queued message.

So `queue` here means **it will not interrupt a turn in flight** — an `immediate` kind steers
a live turn, a `queue` kind is delivered when that turn ends. It does not mean *nobody is
woken*. The alternative, storing a row and waking nobody, is what this plugin's previous
ambient send did: 446 of its 472 ambient messages reached no one, and every idle-worker stall
on record was that gap. Waking is the lesser cost.

`delivered_ts` is set when bb ACCEPTS the send or the queue create. bb exposes
`queuedMessages.list`, but a row leaving that list is indistinguishable from a delete, so
"consumed" is not observable and is not claimed. `read_ts` is set on every row addressed to a
thread when that thread next calls any bus verb.

## Storage

One SQLite database in the plugin's own data directory: `messages` and `claims`. No rooms, no
members, no cursors — `ref` and `kind` give the selectivity rooms were meant to provide, on a
stream nobody has to have joined. No daemon and no runtime dependencies. The only network is
the shared space's relay, and only once it is configured; its state is `shared.db`.

`bb bus build` prints the commit the RUNNING process was loaded from, which is the only thing
that can say so: a checkout can sit clean on main while the process runs something older.

## License

MIT
