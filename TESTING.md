# TESTING.md — traceability and evidence

Every property in SPEC.md §2 mapped to its tests, surfaces, and results.
Versions under test: **DSH 0.2.1-alpha.2** (store `/nix/store/i24c2k38bz3h86r0v7bjr4amk7d4vxrj-dsh-0.2.1-alpha.2`),
**dsh-TUI 0.14.0** (dst = the same binary with `--profile dsh-tui`), plugin peers
exactly `0.2.1-alpha.2` / cordis `4.0.5-alpha.1`, node v24.21.0, pnpm 12.11.2.

## Commands

- Fast/facade suites: `corepack pnpm test` (vitest; also runs the real-client suites).
- Whole-binary headless: `node harness/verify.mjs` (mock model; arms baseline / plugin-persist / plugin-incognito + mode-flip sweep).
- Smoke + negative control: `node harness/smoke.mjs`; `SMOKE_NEGATIVE_CONTROL=1 node harness/smoke.mjs`.
- Real TUI: `corepack pnpm vitest run test/tui-real.test.mjs` (private tmux socket).
- Real web: `corepack pnpm vitest run test/web.real.test.mjs` (headless Chromium via `CHROMIUM_PATH`, default the Nix google-chrome).
- Nix gates: `nix flake check` (offline suite check against the pinned dsh) and `nix run .#e2e` (whole-binary harness with the store-built bundle).
- Release campaign sweeps: `NUM_RUNS=25 corepack pnpm vitest run test/tui-real.test.mjs -t P-06` and `... test/web.real.test.mjs -t P-06`.

## Traceability

| Property (SPEC §2) | Oracle | Test | Surface(s) | Result |
|---|---|---|---|---|
| P-01 persist writes files | FS | toggle-lifecycle P4/P5; tui-real P-01; web-real P-01; verify baseline+plugin-persist arms | facade + TUI + web + headless | **PASS** (store-bundle arm green via nix run .#e2e) |
| P-02 incognito writes none | FS | toggle-lifecycle P1; tui-real P-02 arm; web-real P-02 arm; verify plugin-incognito arm + flip sweep | facade + TUI + web + headless | **PASS** |
| P-03 invocation session converted | FS+MEM | toggle-target R1/R2 (facade + real command contract); tui-real P-02 (real /incognito dispatch); web-real P-02 (composer dispatch) | TUI + web + facade | **PASS** — web CAN dispatch the command; no web N/A |
| P-04 conversion transactional | FS+MEM | toggle-lifecycle P1-P3 (read-your-writes, real wipe, real backend); tui-real/web-real P-02 arms | facade + TUI + web | **PASS**; known wipe-failure window tracked as bead dql (red pending) |
| P-05 toggle-off next-session persists | FS+MEM | toggle-lifecycle P4; tui-real P-05 (toggle-off, /new, chat, files) | facade + TUI | **PASS** |
| P-06 boot mode via env | FS+CFG | mode-and-store (parsing); tui-real P-06 fc sweep; web-real P-06 fc sweep; verify plugin-incognito arm | headless + TUI + web | **PASS**; release sweeps at NUM_RUNS=25 green (2026-10-12) |
| P-07 restart erases incognito sessions | MEM+FS | property.test.ts (store snapshot/owner semantics); resume-throws documented as designed behavior (README Limitations) | facade | **PASS** (facade layer; client restart leg covered by the durable-backend contract via toggle-lifecycle fixtures) |
| P-08 visibility snapshots | MEM | mode-and-store + property tests (stat/list shapes, eventCount vs sizeBytes) | facade | **PASS** |
| P-09 degraded mode loud+safe | logger+FS | mode-and-store (degraded paths); service.ts console.error + per-create warn | facade | **PASS** |
| P-10 exactly one persistence provider | CFG | harness/smoke.mjs row-activity assertion (mounted + base disabled); tui-real/web-real dumpConfig assertions | headless + TUI + web | **PASS** |
| P-11 host seam exact pins | HOST | contract.test.ts (resolves installed dsh, compares every peer/devDep) | host | **PASS** at 0.2.1-alpha.2 (red b73fb61, fix 98d80ec) |
| P-12 contract errors propagate | thrown types | mode-and-store + property tests (exists/owned/seq-gap/read-only) | facade | **PASS** |
| P-13 mode process-local | FS+CFG | verify flip sweep (alternating env across fresh venvs); mode store unit tests | headless + facade | **PASS** |

## Budgets and coverage

- Fast/facade properties: 30 runs per fast-check property (toggle-lifecycle
  P1-P5, per-run temp roots, real JSONL backend); mode/store unit properties
  fixed-seed deterministic. Release: unchanged (the facade layer is
  deterministic per generated case; the client sweeps below carry the
  randomized load).
- Real-client sweeps: P-06 boot-incognito burst property, NUM_RUNS=8 during
  development, **NUM_RUNS=25 for the release campaign** (both surfaces, green,
  2026-10-12) — 25 fresh real dsh-TUI / dsh-web clients each, asserting the
  zero-files invariant after every completed turn.
- Deterministic real-client arms: persist baseline, mid-session toggle-on
  (wipe + no-further-writes), toggle-off + next-session persists — one per
  surface (TUI + web), green at commit.
- Mutation/flake checks: web preview-notice dismissal race found by a
  full-suite repeat run and fixed (repeat-run x3 green after the fix); the
  P-06 TUI sweep caught a rig env-allowlist gap (vendored-copy delta, fixed);
  the whole-binary harness negative control proves the row-activity assertion
  bites when the plugin is unmounted.
- Seeds: fast-check runs use fresh seeds per run (printed on failure with the
  shrink path); deterministic arms are command-replayable.

## Known open items

- dsh-incognito-dql (red pending): wipe failure mid-conversion can leave the
  mode toggled with the inner handle closed (SPEC P-04 target invariant).
- dsh-incognito-8h5 (chore): build.mjs prints 0.0 KiB (cosmetic; the bundle
  is correct, about 21 KiB).
