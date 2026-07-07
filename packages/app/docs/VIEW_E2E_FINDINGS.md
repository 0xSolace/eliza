# View-e2e fan-out — real bugs surfaced (and their status)

The per-plugin view-e2e fan-out (audit → feature-asserting tests → adversarial
verify) was built to make view coverage real, not larp. Writing tests that
assert each view's actual features (populated data + every control + the exact
ids/shapes the server accepts) surfaced real product bugs. Each is pinned by a
committed tripwire test so it is change-detected. Status below.

## View-Type Coverage

- **gui**: per-plugin component tests (this fan-out) render the real component
  with realistic data and assert populated data plus every shipped control;
  screenshot/interaction owners live in `packages/app/test/ui-smoke`.
- **future modalities**: the `viewType` contract remains covered at the registry
  and dispatch layers, but concrete alternate view implementations no longer ship.
  New renderers should add their own visual evidence and interaction owners when
  they are restored.

## Fixed

- **plugin-companion — EmotePicker grid diverged from the catalog.** The picker
  shipped a hardcoded 29-item grid where 17 ids were absent from `EMOTE_CATALOG`
  (clicking them → 400 "Unknown emote" at `POST /api/emote`) and 28 real catalog
  emotes were missing. Now derived from `EMOTE_CATALOG` via `emote-picker-grid.ts`;
  alignment locked by `emote-picker-grid.test.ts`. (commit: "fix(companion):
  derive EmotePicker grid from the emote catalog".)

- **app-model-tester — retired alternate renderer issue.** The older terminal
  view capability regression is historical; the concrete renderer and wrapper
  were removed with the TUI cleanup. Keep future modality capability lists tied
  to their restored renderer when that work returns.

- **plugin-feed — FeedAgentSummary type lie.** `getFeedAgentSummary()` only
  proxies the upstream `/agent/summary` body but was typed `Promise<FeedAgentSummary>`
  ({id,name,summary,recentActivity}) — a shape it never builds and the surface
  never reads. Not a product decision after all: `extractAgentSummary(unknown)` is
  the authoritative parser of the real `{agent,portfolio,positions}` envelope.
  Fixed: client return typed `unknown` (validated at the boundary), `FeedAgentSummary`
  deprecated, and `feed-data.contract.test.ts` flipped from documenting the mismatch
  to asserting the resolution. (commit: "fix(feed): correct getFeedAgentSummary
  type lie".)

## Open — deferred

_(none — both formerly-deferred bugs are fixed: app-model-tester TUI,
feed type lie.)_

## Pre-existing (not caused by this work; noted for the owner)

- **plugin-task-coordinator — NotesPanel.test.tsx: 18 failures** under bun+jsdom
  (`window.localStorage.clear is not a function`) on the untouched baseline. A
  jsdom localStorage shim in the shared test env would fix it.
- **test:e2e:manual relative-config quirk** — some plugins' `test:e2e:manual`
  script's `../../vitest.config.ts` misresolves under bunx vitest v4; worked
  around by a package-local `vitest.config.ts` for the new `test` script.
