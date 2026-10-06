# dsh-incognito design

Synthesized from two competing architecture candidates (proxy-wrapper and standalone-provider)
against the verified persistence contract of DSH 0.2.0-rc.2.

## What this is

A DSH plugin that adds an incognito mode for session persistence. While incognito, sessions
created in that mode never touch disk. Baseline behavior is unchanged when the mode is off.

- `/incognito` toggles the mode at runtime in the TUI.
- `DSH_INCOGNITO=1` sets the initial mode at boot (headless cannot run slash commands).

## Verified ground truth (DSH 0.2.0-rc.2, observed on this machine)

- `JsonlSessionPersistence` (`@deepseek-ai/dsh-session-persistence-jsonl`) is `constructor(ctx, config)`
  with `config = { root: string, compression?: ... }`. It validates the format catalog, asserts the
  root is usable, and installs its live-routing tracker on the passed context.
- The base patch row is `id: session-persistence-jsonl` in `@deepseek-ai/dsh-base/cordis.patch.yml`.
- agent-loop resolves `ctx.get("sessionPersistence")` once at startup. `undefined` means the session
  lives fully in memory. It never re-checks. Resume without the service throws loudly.
- Patch semantics (`@deepseek-ai/cordis-plugin-include`): an id-targeted patch applies overrides
  (`config`, `disabled`, ...) to the existing row. A `name` field only validates; on mismatch the
  patch is skipped with a warning. Row `name` rebinding is impossible. New rows enter via `- insert:`.
- `DSH_HOME` overrides the home directory. A credential-less `dsh headless "..."` boot still
  materializes `$DSH_HOME/sessions/<project>/<encoded-id>/session.v4.jsonl.zstd` plus `session.lock`.
- Plugin module contract: `name`, optional `inject`, `apply(ctx)`; loader uses `exports.default ?? exports`.

## Wiring

User profile patch layer (or the harness writes it into the venv home):

```yaml
- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: session-persistence-incognito
      name: <absolute path>/dsh-incognito/lib/index.js
      config:
        root: !!js dshHomePath('sessions')
```

Exactly one `sessionPersistence` provider exists. The base row is disabled, so there is no
competing service and no mount-order dependence.

## Architecture

One facade service over two backends, routed by ownership, not by current mode.

- `ModeStore`. One enum `'persist' | 'incognito'`, one owner, created in `apply()`. Initial value
  parsed once from `DSH_INCOGNITO` (or config). `/incognito` toggles it. Mode is stamped onto a
  session at `create()` time and decides its backing for life. Toggling never touches a live session.
- Inner backend. `new JsonlSessionPersistence(childCtx, config)` inside `apply()`. Its tracker
  listeners install on the child context; Cordis events fan out tree-wide, so agent emissions reach
  it. Construction failure enters degraded mode (log loudly, all sessions in-memory) instead of
  crashing boot. First smoke test must prove child-context fan-out works; if it does not, fall back
  to constructing the inner backend on the plugin context and filtering our listeners.
- `IncognitoSessionStore`. Process-local in-memory sessions. Per-id state:
  `{ header, events: SessionEvent[], nextSeq, ownerHandle | null, revision }`. Single-writer
  ownership. Appends validate through the shipped `materializeAppendBatch` /
  `materializeCreateHeader`. Seeded creates preload the inherited prefix or fail loudly.
- `IncognitoSessionHandle`. Full in-memory buffer, not a discard handle. `read()` returns
  caller-owned copies with `eventState: 'detached'`. `flush()` resolves without writing (vacuous
  barrier). `close()` is idempotent and releases ownership. Checkpoint and projection consumers
  read live handles; an empty-read discard handle would corrupt derived state.
- Facade `IncognitoSessionPersistence`. `create()` routes by current mode. `open`/`stat`/`list`
  route by whether the incognito store owns the id, else delegate to the inner backend. `flush()`
  drains inner handles and resolves incognito handles. The store installs listeners that filter to
  incognito-owned ids; the inner tracker owns the rest. Disjoint by construction.
- `stat`/`list` include incognito sessions process-locally (`eventCount`, no `sizeBytes`). After
  restart they never existed; resume throws `SessionPersistenceNotFoundError`. That is the feature.
- Contract errors propagate unchanged. Never swallow `SessionAlreadyExistsError`,
  `SessionAlreadyOwnedError`, seq-gap rejections, corruption, or format refusals.

## Module map

| File | Role |
| --- | --- |
| `src/index.ts` | Plugin entry: `name`, `apply(ctx)`; wires config, mode store, inner backend, facade, command. |
| `src/types.ts` | `IncognitoMode`, `IncognitoPluginConfig` (structurally the JSONL backend config). |
| `src/mode.ts` | `ModeStore`: env parsing, toggle, single owner of the enum. |
| `src/service.ts` | Facade over inner backend + incognito store; ownership routing. |
| `src/incognito-store.ts` | In-memory sessions, single-writer ownership, snapshots. |
| `src/incognito-handle.ts` | `SessionHandle` over the buffer. |
| `src/command.ts` | `/incognito` registration. |
| `test/` | Unit tests, property tests, contract-style tests. |
| `harness/` | Whole-binary verification (below). |

## Harness (core verification)

`harness/verify.mjs` wraps the real `dsh` binary. Each run gets a fresh virtual environment:
a temp `DSH_HOME` with `profiles/verify/` scaffolded (package.json, cordis.yml, cordis.patch.yml,
pnpm workspace, mirroring the layout `dsh` scaffolds for a custom profile).

Arms:

1. Baseline. Stock profile, no plugin rows. Expect session files under `$DSH_HOME/sessions/`.
2. Plugin mounted, mode persist. Expect session files, same as baseline (plugin delegates to the
   real backend; disk behavior must be identical in kind).
3. Plugin mounted, `DSH_INCOGNITO=1`. Expect zero files under `$DSH_HOME/sessions/` and a clean exit.

Each arm boots `dsh headless "Reply with exactly: ok"` via `child_process.spawn` with the venv
`DSH_HOME` and a timeout, then inspects the venv tree. A property sweep on top runs arm 3 across
repeated fresh venvs (and a mode-flip sweep toggling the env var) to catch state leaking across
processes or runs.

Exit code 0 with a PASS/FAIL table is the deliverable of every run.
