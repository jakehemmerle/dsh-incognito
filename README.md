# dsh-incognito

A DSH plugin that adds an incognito mode for session persistence: while
incognito, sessions created in that mode never touch disk. Baseline behavior
is unchanged when the mode is off. See DESIGN.md for the architecture
(ownership-routed facade over the durable JSONL backend plus a process-local
in-memory store) and the verified persistence contract it is built against.

## Install

Mount it in a profile's `cordis.patch.yml`. The base durable backend must be
disabled so exactly one `sessionPersistence` provider exists:

```yaml
- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: session-persistence-incognito
      name: /absolute/path/to/dsh-incognito/lib/index.js
      config:
        root: !!js dshHomePath('sessions')
```

`config` is structurally the JSONL backend config (`root`, optional
`compression`); it is forwarded verbatim to the inner durable backend.

## Usage

- `/incognito` toggles the mode at runtime in the TUI.
  - **On (mid-session conversion).** The CURRENT session stays the same
    session — a new one is never opened. Its on-disk log is wiped (the session
    directory under `sessions/` is removed), and nothing further in that
    session is ever flushed to disk for the rest of its life, even if the
    session continues. The in-memory log keeps every event that was already
    written before the toggle, so reads, checkpoints, and projections keep
    working unchanged (read-your-writes across the conversion).
  - **Off.** No durability promise for the rest of the current session: the
    live session keeps its in-memory backing until it ends. The next session
    created in persist mode (e.g. after `/new`) persists to disk normally.
- `DSH_INCOGNITO=1` sets the initial mode at boot (headless cannot run slash
  commands). Parsed once at plugin apply time; truthy spellings
  (`1`/`true`/`yes`/`on`, case-insensitive) select incognito. Every session
  then starts in-memory with zero disk writes — the previous behavior for
  sessions created in incognito mode.

Incognito sessions are full in-memory sessions: reads, appends, checkpoints,
and projections all work, but nothing is written under `sessions/`.

## Verification

`pnpm verify` (or `node harness/verify.mjs`) boots the real `dsh` binary
against fresh virtual homes under a mktemp dir. Each venv scaffolds a
`profiles/verify/` directory (package.json, cordis.yml, cordis.patch.yml), a
model route, and a copy of the user's credential store so the run reaches a
real model reply; `~/.dsh` itself is never modified.

Arms (3 fresh venvs each, plus a 3-run mode-flip sweep):

| Arm | Expectation |
| --- | --- |
| baseline (stock profile, no plugin) | session files under `$DSH_HOME/sessions/` |
| plugin mounted, `DSH_INCOGNITO` unset | session files, same in kind as baseline |
| plugin mounted, `DSH_INCOGNITO=1` | zero files under `sessions/` (tree listed per run) |

Every run's session tree is printed; the table prints PASS/FAIL and the
process exits non-zero on any failure.

`pnpm test` runs vitest unit tests and fast-check property tests over the
in-memory store and handle (contiguity, read-your-writes, stat/list
consistency, single-writer ownership, double-close, flush-after-close), plus
toggle-lifecycle properties that drive the real facade with the real JSONL
backend on a per-run temp root: no file for a converted session exists at any
point after toggle-on, read-your-writes holds across the conversion, the wipe
is real, the next persist-mode session materializes while incognito ones never
do, and two-session interleavings keep the routing disjoint.

## Limitations

- Incognito sessions are visible to `stat`/`list`/`open` only inside the
  process that created them (they have `eventCount` but no `sizeBytes`).
- Resume after restart throws `SessionPersistenceNotFoundError` by design:
  after the process exits, an incognito session never existed.
- If the inner durable backend fails to construct (bad root, format refusal),
  the facade enters degraded mode: it logs loudly and every session —
  including ones created with persist mode — lives in memory and never
  touches disk.
- Storage-contract validation reuses the shipped validators
  (`materializeCreateHeader`, `materializeAppendBatch`, `assertContiguous`,
  `validateStoredEvents`) from `@deepseek-ai/dsh-session-persistence`, so
  incognito sessions refuse the same inputs the durable backend refuses.
