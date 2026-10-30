# dsh-incognito SPEC

Product and technical spec for the incognito session-persistence plugin, per the
new-dsh-plugin specification guide. Versions under test: **DSH 0.2.1-rc.2**
(the latest DSH release, 2026-10-23; supersedes the 0.2.1-alpha.2 exception),
**dsh-TUI 0.16.1**, plugin peers pinned exactly (dsh-* `0.2.1-rc.2`, cordis
`4.0.5`). Every property has a
stable ID, an independent oracle (never the implementation), and a surface
mapping. Where a surface cannot apply, the row says why.

## 1. Product spec

### Problem and scope

DSH persists every session to `$DSH_HOME/sessions/` (durable JSONL backend).
Jake needs sessions that **never touch disk** — sensitive one-offs, throwaway
debugging, shared machines — without giving up normal persistence for everything
else. `dsh-incognito` replaces the durable backend with an ownership-routed
facade: sessions created while the mode is off behave exactly as today; sessions
created while the mode is on live only in process memory; turning the mode on
mid-session converts the **current** session in place (its on-disk log is wiped)
and it continues in memory for the rest of its life.

**Privacy scope (what /incognito does and does not cover):**

- **Covers:** every byte the session-persistence backend would write under the
  configured sessions root — event log, header, checkpoints, projections,
  locks, compressed artifacts. After conversion or in incognito mode the tree
  under the root gains nothing for that session, ever (verified at every step).
- **Does not cover:** model/provider requests (the configured endpoint still
  receives prompt content); process memory (events remain in RAM by design —
  that is what read-your-writes needs); other processes' logs (shell history,
  terminal scrollback, DSH logs outside the sessions root); anything a *later*
  opt-in write does. Incognito is a disk-persistence property, not network or
  memory privacy.
- **Resume semantics:** after the process exits an incognito session never
  existed — resume throws `SessionPersistenceNotFoundError`. That is the feature.

### Non-goals

- No encryption-at-rest, no per-session selective redaction of already-persisted
  *other* sessions, no UI beyond the `/incognito` command and the env var, no
  web UI control (web sessions are covered server-side by the same facade; see
  P-03's surface note), no config to relocate state (the facade reuses the
  durable backend's config shape verbatim).

### User journeys

- **TUI (`dst`):** user runs `/incognito` from the command menu mid-conversation →
  confirmation text states the current session was wiped from disk and continues
  in memory. `/incognito` again → mode off, text states sessions *created from
  now on* persist; the current session stays in memory. First-screen
  (Launchpad) command availability is verified by the TUI suite (plugin
  shortcuts don't run on the Launchpad; command-menu behavior there is
  established by test, not assumed).
- **Headless (`dsh --profile … "task"`):** no slash commands; `DSH_INCOGNITO=1`
  selects incognito for the whole process — zero writes under the root.
- **Web (`dsh web`):** the facade runs in the server process; sessions created
  through the web UI follow the mode at creation time. Whether the web composer
  can dispatch the `/incognito` plugin command is verified by the web suite;
  if it cannot, the TUI-only conversion surface is the documented rationale
  (P-03 web column), and web still requires P-01/P-02/P-07/P-09/P-10/P-11 to hold.

### State ownership

One process-local enum (`persist | incognito`), owned by `ModeStore`, created in
`apply()`, initial value parsed **once** from `DSH_INCOGNITO` (truthy spellings
`1/true/yes/on`, case-insensitive; anything else, including absence, is
persist). Mode is stamped onto a session at `create()` time. The mode is **not
persisted anywhere**: a new process starts persist unless the env var says
otherwise (P-08). Sessions are owned per-id by exactly one backend (in-memory
store or durable inner), disjoint by construction.

### Interaction rules

- Busy turns: conversion only manipulates the persistence layer; the agent loop
  keeps appending through the same facade handle (backing swap is transparent).
- Repeated `/incognito`: toggling twice returns to the original mode; converting
  an already-in-memory session is a no-op besides the mode (`outcome: in-memory`).
- Multiple clients: two processes share nothing (separate facades, same root);
  a durable session converted by one process is deleted under the other's feet —
  same-process semantics only; cross-process conversion is out of scope (durable
  backend contract: other processes see materialized sessions; the wipe makes it
  disappear, matching "never existed" for future reads).

## 2. Acceptance properties

Oracle legend — **FS**: independent walk of the real `$DSH_HOME/sessions` tree;
**MEM**: facade `stat`/`list`/`read` snapshots (eventCount/contiguity);
**WIRE**: serialized requests at the mock model; **HOST**: resolved installed
dsh version + package.json pins; **CFG**: `dsh --dump-config` composed row.

| ID | Property (non-negotiables per lead) | Oracle | headless | TUI | web |
|---|---|---|---|---|---|
| P-01 | **Persist mode writes session files**: a session created in persist mode materializes under the root and grows on disk after each flush | FS (files exist, size > 0) | verify arm baseline/persist | vzv arm | bac arm |
| P-02 | **Incognito writes none**: a session created in incognito mode never creates any file under the root, checked after every append/flush | FS (tree empty for that id at every step) | verify arm incognito | vzv arm | bac arm |
| P-03 | **The invocation session is the one converted**: `/incognito` converts exactly `invocation.agent.session.id`; other live write sessions stay durable and untouched | FS + MEM (per-id: converted id empty on disk with full in-memory log; others' files byte-count non-decreasing) | N/A (no slash commands in headless) | vzv (command path) | bac (composer dispatch — else documented N/A) |
| P-04 | **Conversion is transactional (read → close → wipe → buffer)**: pre-toggle events survive in memory (read-your-writes), post-toggle appends never touch disk, a failed wipe is never pretended as success, and a failed wipe restores the durable backing so the session stays durable, owned, and appendable | FS + MEM (contiguous seqs 0..n across the toggle; FS empty from the first post-wipe check; failed-wipe leg asserts the restored durable backing) | facade-level (toggle-lifecycle P1–P3 + wipe-failure R) | vzv re-drive | bac re-drive |
| P-05 | **Toggle-off promise**: after toggle-off the current session keeps its in-memory backing; the next session created materializes on disk | FS + MEM (next id has files; current id never does) | facade-level (P4) | vzv | bac |
| P-06 | **Boot mode**: `DSH_INCOGNITO=1` makes every session in that process memory-only; unset makes persist the default; parsed once at apply | FS (zero files all run) + CFG (plugin row present) | verify incognito arm | vzv env boot | bac env boot |
| P-07 | **Restart erases incognito sessions**: stat/list lose in-memory ids after restart; resume throws `SessionPersistenceNotFoundError`; persist sessions resume normally | MEM + FS (restart on same profile: fresh service, fresh process) | facade-level (restart.test: both legs) + headless verify venvs | vzv legs A/B (real process restart, /resume supervisor) | fresh service (restart.test R1/R2); web restart UI not driven (see below) |
| P-08 | **Visibility**: incognito sessions appear in stat/list process-locally with `eventCount`, no `sizeBytes`; durable ones carry `sizeBytes` | MEM (snapshot field shapes) | facade-level | — | — |
| P-09 | **Degraded mode is loud and safe**: inner backend construction failure logs an error and a per-create warning; sessions stay in memory; boot does not crash | captured logger + FS (nothing written) | facade-level | — | — |
| P-10 | **Exactly one sessionPersistence provider**: the profile patch disables `session-persistence-jsonl` and inserts the facade with a required `root`; the composed config shows exactly the facade row | CFG (dump-config row assertions) | profile-level | vzv fixture | bac fixture |
| P-11 | **Host seam**: every `@deepseek-ai/*` peer/devDep is an exact pin of the version present in the installed host tree (plugin disabled otherwise, and with the base row disabled that means no persistence at all) | HOST | contract test | (same) | (same) |
| P-12 | **Contract errors propagate unchanged**: exists/owned/seq-gap/read-only violations surface as the shipped error types, never swallowed | thrown-type assertions | facade-level (mode-and-store, property) | — | — |
| P-13 | **Mode is process-local**: toggles are not persisted; a fresh process starts persist unless `DSH_INCOGNITO` says otherwise | FS (fresh venv trees) + CFG | verify flip sweep | vzv | — |

Surface N/A rationales: headless cannot run slash commands (P-03 headless N/A);
P-08/P-09/P-12 are storage-layer properties observable through any client
(facade-level tests are the oracle); web conversion dispatch (P-03 web) is
settled by test in bac — a negative result becomes the documented N/A rationale,
not a silent skip.

## 3. Technical spec

### Seams (verified against the installed rc.2 tree)

- Service replacement: the facade provides `sessionPersistence`
  (`static provide`), constructed on the plugin context. The inner durable
  backend is DSH's own `session-persistence-jsonl` plugin, mounted with
  `ctx.plugin(jsonl, config)` on `ctx.extend().isolate('sessionPersistence')`
  and read back through `inject(['sessionPersistence'])` in that scope.
  DSH 0.2.1-rc.2 no longer exports `JsonlSessionPersistence` (only
  `{ Config, JsonlCompressionSchema, apply, name }`; the class now needs a
  backend tracker that `apply` installs), so the facade no longer constructs
  it. Every facade operation awaits the mount; a mount failure enters
  degraded mode. Contract-guarded by the real
  backend lifecycle tests (toggle-lifecycle suite).
- Command seam: `ctx.commands.register({ definitionId, name, description,
  handler(invocation) })`; the handler receives `invocation.agent.session.id`
  (dsh-commands alpha.2 `CommandInvocation`). Guarded by toggle-target R2.
- Storage contract: shipped validators (`materializeCreateHeader`,
  `materializeAppendBatch`, `assertContiguous`, `validateStoredEvents`) and
  shipped error types are reused verbatim — incognito refuses what the durable
  backend refuses. Guarded by mode-and-store/property tests + P-12.
- Host version seam: exact peer pins (P-11) — the contract suite fails first on
  any dsh bump.

### Mid-session conversion (P-04)

Read-then-close-then-wipe-then-buffer, in that order: full log read from the
durable handle; `close()` drains in-flight durability work and releases
single-writer ownership; only then is the session directory under the root
removed (`rmSync -r`; a path outside the root refuses loudly; the wipe is never
pretended); the buffer is registered and swapped in as the handle's backing.

**Failed-wipe semantics (bead dql, fixed in v0.1.0-alpha.2 by red a9b6b79 →
fix 807e87f):** if the wipe fails after the durable handle was closed, the
facade reopens the durable handle for write and swaps it back as the backing
BEFORE rethrowing — a failed wipe leaves the session durable, owned, and
appendable (`test/wipe-failure.test.ts`). The error then surfaces through the
host command runtime, which settles a thrown handler as a `kind: 'error'
`command/done` result (verified in dsh-commands 0.2.1-alpha.2 `lib/index.js`),
so the failure is never silent.

**Product decision — no mode rollback on conversion failure** (recorded this
audit; implementation unchanged): `ModeStore` stays `incognito` after a failed
wipe. Rationale: the mode is the user's deliberate request for sessions
deemed private — transient conversion failures (e.g. an unwritable session
parent) must not silently re-enable disk persistence for SESSIONS CREATED
AFTER the failure; the failed conversion itself leaves the one affected
session durable so no data is lost and appends keep working. A retry is the
existing toggle: the user can flip the mode off at any time. Rolling the mode
back would trade a documented, recoverable best-effort behavior for
persistence of sessions the user explicitly asked to keep off disk.
Session-scoped rollback alternative remains a future product decision; it is
NOT implemented.

### Harness and budgets

- Fast layer: vitest + fast-check. Fast properties default to 100 cases
  (property.test) / 30 cases (toggle-lifecycle real-backend, per-run temp
  roots); the release run raises them through `NUM_RUNS` (set ≥1000 and
  recorded in TESTING.md).
- Whole-binary: `harness/verify.mjs` arms (baseline / plugin-persist /
  plugin-incognito + mode-flip sweep) on fresh virtual homes with the **vendored
  mock model** — no live credentials, no real provider calls (bead `jbm`).
- Real clients: TUI via a real `dst` on a private tmux socket (bead `vzv`); web
  via Playwright on real `dsh web` (bead `bac`); each drives P-01–P-07 with the
  real sessions tree as oracle. The P-06 boot-mode sweeps boot a FRESH client,
  mock and profile per generated case; budget + seed come from `NUM_RUNS` and
  `FC_SEED` (`FC_PATH` replays a failure). The release campaign runs ≥100
  cases per surface across ≥3 logged seeds.
- Replay: every property replays via `FC_SEED` + `FC_PATH`; regression
  minimizations land as named tests before fixes.
- Web restart UI leg: not driven through the web UI; the same transition is
  exercised at the facade level against a fresh service on the same root
  (restart.test R1/R2 is exactly what a restarted web server process runs),
  and the TUI legs prove the transition end-to-end in a real process. The web
  column above records this reduced scope deliberately rather than as a
  silent skip.
