<!-- agents-md ceiling: 56 lines -->
# AGENTS.md — bb-plugin-bus

A peer message bus between bb threads: rooms, ambient sends, and addressed sends the bb
server delivers as a real turn. [`README.md`](README.md) is the user-facing document and
the design rationale; `skills/bus/SKILL.md` is what agents are taught. **A behaviour change
owes an edit to the skill too** — it ships with the plugin and is how threads learn the
protocol without being told.

## Commands, all run 2026-09-09

```sh
npm install          # rc=0
npm test             # node --test over lib.test.ts — 35 tests, 0 fail
npm run typecheck    # tsc --noEmit, rc=0
bb plugin build .    # produces dist/server.js + dist/server.meta.json
```

## The gate

`npm test`, `npm run typecheck`, and two GitHub Actions workflows —
`.github/workflows/test.yml` and `.github/workflows/managed-install.yml`. The second is
the one a clean local run cannot stand in for: bb's managed git install resolves
**runtime dependencies only** (`npm install --omit=dev --omit=optional --ignore-scripts`)
before `bb plugin build`, so a module imported at runtime but parked in `devDependencies`
builds here and fails for every real user.

**This plugin currently has an empty `dependencies` block, and that is a feature** — no
daemon, no network, no runtime dependency. Adding the first one is a decision, not a
detail.

## Layout

| path | what it is |
|---|---|
| `lib.ts` | every rule: rooms, membership, cursors, delivery mode |
| `lib.test.ts` | the suite; the `npm test` glob names this file explicitly |
| `server.ts` | bb wiring — commands, the SDK `threads.send` call, the SQLite schema |
| `skills/bus/SKILL.md` | the protocol as agents read it |

## Conventions that differ from the defaults

- **Tests are `node --test --experimental-strip-types` against the TypeScript sources**,
  no build step, no vitest. `npm test` names `lib.test.ts` literally, so a new suite file
  is invisible until you add it to the script.
- **Nothing in this plugin waits, blocks or polls.** Addressed delivery is the bb server's
  job through the SDK; a change that introduces a listener, a poller or a queue drain here
  breaks the property the design rests on — that a session cannot silently go deaf.
- **Cursors advance only to what was actually handed to the caller.** A `recv` that
  advanced past an unreturned page would lose messages with nothing going red.

**Nothing about who may merge, how agents are spawned, or how the maintainer's
machine handles secrets belongs in this file, and none of it is stated here.**
Those are properties of a working environment, not of this project; if you are
contributing, your own conventions apply and nothing in this repo depends on
the maintainer's.
