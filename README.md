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
bb bus send --kind <kind> --to <thread-id> [--ref <ref>] [--field k=v]… [--body - | --body-file <p>]
bb bus <kind> --to <thread-id> …                 # one verb per kind; same validation
bb bus claim <resource> --reason <r> [--ttl 30m] # held / busy (rc 75)
bb bus heartbeat <resource> · release <resource> [--force --reason '<why>'] · claims [--stale] [--mine]
bb bus log [--kind K] [--ref R] [--from T] [--to T] [--since <ts>] [--unread] [-n N]
bb bus unanswered [--minutes N] · build
```

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

The body is optional on every kind and **capped at 600 characters by the schema, with no
override**. The cap it replaces was a hook, and it was overridden 3,603 times against 96
refusals. `note` is the only free-prose kind and the plugin reports its share so it can be
watched shrinking.

## Claims

First holder wins; a second claimant gets `busy` at rc 75. Default TTL 30 minutes, maximum
4 hours; `heartbeat` extends by the original TTL. Past expiry the resource is taken by the
next claimant and **the displaced holder is told** — an expiry that only a ledger records is
one the old holder acts against. Archiving or deleting a thread releases its claims, so a
dead thread cannot hold `pr:685` forever.

Enforcement lives in cc-guard, which reads this store read-only: before `gh pr merge <n>` the
caller must hold `pr:<n>`, before `bb thread delete <id>` `thread:<id>`, before
`bb memory forget <id>` `store:memory`, before a task cancel `task:<KEY>`. No override env
var — the remedy is one command.

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
stream nobody has to have joined. No daemon, no network, no runtime dependencies.

`bb bus build` prints the commit the RUNNING process was loaded from, which is the only thing
that can say so: a checkout can sit clean on main while the process runs something older.

## License

MIT
