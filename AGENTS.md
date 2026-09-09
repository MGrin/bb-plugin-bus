<!-- agents-md ceiling: 56 lines -->
# AGENTS.md — bb-plugin-bus

A typed peer bus between bb threads: twelve closed message kinds, TTL'd resource claims,
delivery on bb's own send primitive. [`README.md`](README.md) is the user-facing document
and the design rationale; `skills/bus/SKILL.md` is what agents are taught. **A behaviour
change owes an edit to the skill too** — the live suite asserts that skill's kind table
equals `KIND_NAMES`, so the debt is checked rather than remembered.

## Commands, all run 2026-09-09

```sh
npm install          # rc=0
npm test             # node --test over src/*.test.ts — 94 tests, 0 fail
npm run test:live    # six cases against a REAL bb and two spawned threads
npm run typecheck    # tsc --noEmit, rc=0
bb plugin build .    # dist/server.js + dist/server.meta.json
```

## The gate

`npm test`, `npm run typecheck`, and two GitHub Actions workflows — `test.yml` and
`managed-install.yml`. The second is the one a clean local run cannot stand in for: bb's
managed git install resolves **runtime dependencies only** (`--omit=dev --omit=optional
--ignore-scripts`) before `bb plugin build`, so a module imported at runtime but parked in
`devDependencies` builds here and fails for every real user. **The `dependencies` block is
empty and that is a feature**; adding the first one is a decision, not a detail.

**`npm run test:live` is not in CI and cannot be**: it needs a running bb and spawns real
threads. It SKIPS when bb is down, and **a skip there is a finding, not a pass.**

## Layout

The unit-by-unit table is in [`README.md`](README.md#the-shape) — one home, and it is
the one a contributor reads first. The single fact that governs edits here:
**`src/kinds.ts` is the kind table, and everything else derives from it.**

## Conventions that differ from the defaults

- **Tests are `node --test --experimental-strip-types` against the sources**, no build
  step, no vitest. `npm test` names each file literally so the live suite cannot be swept
  in, and `src/suite.test.ts` asserts that list against the directory — a suite file
  nothing runs is a test nobody has. **There is no second list of kinds**: adding one is a
  row in `src/kinds.ts` and a test.
- **A body never comes from argv.** The shell substitutes before bb sees the command; the
  CLI has no argv slot for one, and the 600-character cap is the schema, no override.
- **Nothing here waits, blocks or polls.** Delivery is the bb server's job; a listener, a
  poller or a queue drain breaks the property the design rests on — that a session cannot
  silently go deaf.
- **`queue` does not mean "wakes nobody".** bb has no delivery that leaves an idle thread
  asleep; it means only that a live turn is not interrupted. README says why.

**Nothing about who may merge, how agents are spawned, or how the maintainer's machine
handles secrets belongs in this file, and none of it is stated here.** Those are properties
of a working environment, not of this project; if you are contributing, your own
conventions apply and nothing here depends on the maintainer's.
