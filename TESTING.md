# TESTING.md — traceability and evidence

> **DSH 0.2.1-rc.2 port (0.1.0-rc.1, 2026-10-23):** every suite below was rerun
> against DSH 0.2.1-rc.2 and dsh-TUI 0.16.1, with peers exactly 0.2.1-rc.2 /
> cordis 4.0.5. Results: full suite 35/35; fast properties NUM_RUNS=1000
> (seed 20261023) 7/7; P-06 sweeps 100 cases per surface over seeds
> 20261023/24/25, all green; mutant caught by TUI and web P-01;
> `nix flake check` and `nix run .#e2e` green. Details are in CHANGELOG.md
> 0.1.0-rc.1. The alpha.2 evidence below is historical.

> **v0.1.0-rc.1 release gate (2026-10-30, mbp, commit 5a274eb on main):** DSH
> 0.2.1-rc.2 (`DSH_BIN=/nix/store/l9m9bm830hjgs0xhi86wv8g3bgwlsyz6-dsh-0.2.1-rc.2/bin/dsh`),
> dsh-TUI 0.16.1 (`DSH_TUI_DIR` = `/nix/store/ij4q915vdsagwrgsdbwpwka5lxd16hzn-dsh-tui-0.16.1`'s
> package), headless Chromium (`CHROMIUM_PATH` = Playwright chromium-1217),
> node v24.16.0, pnpm 12.11.2; fresh clone, `corepack pnpm build` first (the
> real-client suites and verify load `lib/index.js`). Results: typecheck green;
> full suite 35/35 (real-client TUI 6/6, web 3/3 executed); `node
> harness/verify.mjs` VERIFY PASS; fast properties NUM_RUNS=1000 (seed
> 20261030) 7/7; P-06 sweeps NUM_RUNS=34/33/33 × seeds 20261030/31/32 =
> **100 cases per surface (TUI, web), all green**; `nix flake check` all checks
> passed; `nix run .#e2e` VERIFY PASS.

Every property in SPEC.md §2 mapped to its tests, surfaces, and results.
Versions under test: **DSH 0.2.1-alpha.2** (store `/nix/store/i24c2k38bz3h86r0v7bjr4amk7d4vxrj-dsh-0.2.1-alpha.2`),
**dsh-TUI 0.14.0** (dst = the same binary with `--profile dsh-tui`), plugin peers
exactly `0.2.1-alpha.2` / cordis `4.0.5-alpha.1`, node v24.21.0, pnpm 12.11.2.
Updated by the ROUND C closure audit (2026-10-12): the whole board was re-verified,
five closures were reopened and fixed (see the audit section), and the evidence below
is from runs after those fixes (test hardening commit 6cbddcf).


## Commands

- Fast/facade suites: `corepack pnpm test` (vitest; also runs the real-client suites — these SKIP only when the OFFLINE nix check sets SKIP_REAL_CLIENT=1; on the host they always execute, re-verified by the ROUND C audit: 35/35 in ~104 s incl. six TUI and three web client arms).
- Fast properties with a raised budget: `NUM_RUNS=1000 FC_SEED=<seed> corepack pnpm vitest run test/property.test.ts test/toggle-lifecycle.test.ts`.
- Whole-binary headless: `node harness/verify.mjs` (mock model; arms baseline / plugin-persist / plugin-incognito + mode-flip sweep).
- Smoke + negative control: `node harness/smoke.mjs`; `SMOKE_NEGATIVE_CONTROL=1 node harness/smoke.mjs`.
- Real TUI: `corepack pnpm vitest run test/tui-real.test.mjs` (private tmux socket).
- Real web: `corepack pnpm vitest run test/web.real.test.mjs` (headless Chromium via `CHROMIUM_PATH`, default the Nix google-chrome).
- Nix gates: `nix flake check` (offline suite check against the pinned dsh) and `nix run .#e2e` (whole-binary harness with the store-built bundle).
- Release campaign sweeps (one client/server per generated case): `NUM_RUNS=<n> FC_SEED=<seed> corepack pnpm vitest run test/tui-real.test.mjs -t P-06` and the same for `test/web.real.test.mjs -t P-06`; `FC_PATH=<path>` replays a shrunken failure against the same seed.

## Traceability

| Property (SPEC §2) | Oracle | Test | Surface(s) | Result |
|---|---|---|---|---|
| P-01 persist writes files | FS | toggle-lifecycle P4/P5; tui-real P-01; web-real P-01; verify baseline+plugin-persist arms | facade + TUI + web + headless | **PASS** (store-bundle arm green via nix run .#e2e) |
| P-02 incognito writes none | FS | toggle-lifecycle P1; tui-real P-02 arm; web-real P-02 arm; verify plugin-incognito arm + flip sweep | facade + TUI + web + headless | **PASS** |
| P-03 invocation session converted | FS+MEM | toggle-target R1/R2 (facade + real command contract); tui-real P-02 (real /incognito dispatch); web-real P-02 (composer dispatch) | TUI + web + facade | **PASS** — web CAN dispatch the command; no web N/A |
| P-04 conversion transactional (incl. failed-wipe durability) | FS+MEM | toggle-lifecycle P1-P3 (read-your-writes, real wipe, real backend); **wipe-failure R (red a9b6b79 → fix 807e87f, shipped v0.1.0-alpha.2): a failed wipe rethrows AND restores the durable backing (session durable, owned, appendable; mode stays incognito per the SPEC product decision)** | facade + TUI + web + headless | **PASS** (decoded by the ROUND C audit; previously stuck at "dql red pending" while already fixed) |
| P-05 toggle-off next-session persists | FS+MEM | toggle-lifecycle P4; tui-real P-05 (toggle-off, /new, chat, files) | facade + TUI | **PASS** |
| P-06 boot mode via env | FS+CFG | mode-and-store (parsing); tui-real P-06 fc sweep (fresh client per case); web-real P-06 fc sweep (fresh server per case); verify plugin-incognito arm | headless + TUI + web | **PASS**; release campaign NUM_RUNS=34/33/33 × seeds 20261012/13/14 = **100 cases per surface, all green** (2026-10-12, post-audit) |
| P-07 restart erases incognito sessions | MEM+FS | **test/restart.test.ts (facade: fresh service over the SAME root — persist leg resumes via stat/list/open+append contiguous; incognito leg: zero files, absent from list/stat, resume throws SessionPersistenceNotFoundError); tui-real P-07 leg A (real process restart → /resume → Sessions supervisor restores the transcript; the resumed session keeps its id) and leg B (converted session: zero files + the supervisor lists 0 total after restart)** | facade + TUI (+ headless verify venvs; web restart is the same facade through a fresh service — see SPEC P-07 note) | **PASS** (added by the ROUND C audit; the previous row claimed a "toggle-lifecycle fixtures" restart leg that did not exist) |
| P-08 visibility snapshots | MEM | mode-and-store + property tests (stat/list shapes, eventCount vs sizeBytes) | facade | **PASS** |
| P-09 degraded mode loud+safe | logger+FS | mode-and-store (degraded paths); service.ts console.error + per-create warn | facade | **PASS** |
| P-10 exactly one persistence provider | CFG | harness/smoke.mjs row-activity assertion (mounted + base disabled); tui-real/web-real dumpConfig assertions | headless + TUI + web | **PASS** |
| P-11 host seam exact pins | HOST | contract.test.ts (resolves installed dsh, compares every peer/devDep) | host | **PASS** at 0.2.1-alpha.2 (red b73fb61, fix 98d80ec) |
| P-12 contract errors propagate | thrown types | mode-and-store + property tests (exists/owned/seq-gap/read-only) | facade | **PASS** |
| P-13 mode process-local | FS+CFG | verify flip sweep (alternating env across fresh venvs); mode store unit tests | headless + facade | **PASS** |

Surface N/A rationales: headless cannot run slash commands (P-03 headless N/A);
P-08/P-09/P-12 and the failed-wipe leg of P-04 are storage-layer properties observable
through the facade oracle; web conversion dispatch (P-03 web) and the web restart leg
(P-07) are recorded per the notes above — no silent skips.

## Budgets and coverage

- Fast/facade properties: property.test at 100 cases/property and toggle-lifecycle at
  30 cases/property in the default suite (per-run temp roots, real JSONL backend).
  **Release audit run, 2026-10-12 (post-audit): NUM_RUNS=1000 with FC_SEED=20261012
  for both files — 8 properties × 1000 cases, green in 216 s total on the 2026-10-12 audit run (NUM_RUNS=1000, FC_SEED=20261012; 7/7 tests green — property.test 0.5 s, toggle-lifecycle 216 s).**
  Failures replay via FC_SEED/FC_PATH.
- Real-client release campaign (2026-10-12, post-audit; one fresh client/mock/profile
  per generated case, burst depth 0-3 per case): TUI **100** cases, web **100** cases,
  over seeds **20261012 (34), 20261013 (33), 20261014 (33)** — all green
  TUI: seed 20261012 34 cases (2m47s), 20261013 33 (2m40s), 20261014 33 (2m44s); web: 20261012 34 (5m45s), 20261013 33 (5m34s), 20261014 33 (5m36s); all rc=0, every seed logged above with the sweep header ([sweep] surface=... seed=... numRuns=...). (The earlier v0.1.0-alpha.1/alpha.2 gates swept NUM_RUNS=25 once
  on a single shared client per surface and were under the authorized ≥100-across-≥3-seeds
  budget; the ROUND C audit reopened the release bead over this and the close reason's
  "25 fresh real clients each" wording was corrected.)
- Deterministic real-client arms: persist baseline, mid-session toggle-on (wipe +
  no-further-writes), toggle-off + next-session persists, and the two P-07 restart
  legs — one run each per surface (TUI + web), green at commit and re-green in the
  post-audit full suite (35/35, ~104 s).
- Seeds: the repo's sweeps read FC_SEED/FC_PATH/NUM_RUNS (added by the audit; before
  that the P-06 sweeps had no seed parameter and were not replayable).
- Isolation: every generated campaign case boots its own client, mock and profile
  (per-case fixture per testing.md; the old single-client-per-sweep design did not).

## Mutation and flake checks (2026-10-12, post-audit)

- **Planted-mutant campaign (skill requirement; first run this audit): caught 3/3 on
  fresh temp copies of the repo (node_modules symlinked), one mutant applied at a time:**
  1. `service.ts`: delete the failed-wipe recovery (reopen + swapBacking) → **killed**
     by `wipe-failure.test.ts > R: a failed wipe rethrows but leaves the session durable,
     owned, and appendable` (P-04 failed-wipe leg).
  2. `command.ts`: call `facade.toggle()` without the invocation session id → **killed**
     by `toggle-target.test.ts > R2` (P-03).
  3. `mode.ts`: drop the `'on'` truthy spelling from `parseIncognitoEnv` → **killed** by
     `mode-and-store.test.ts > parseIncognitoEnv → parses truthy spellings
     case-insensitively once` (P-06).
  Full log: /tmp/incog-mutants.log (host-side; reproducible by re-planting the three
  diffs one at a time).
- Flake finds recorded: web preview-notice dismissal race (fixed in the alpha.1
  campaign, repeat ×3 green); the P-06 TUI sweep exposed a rig env-allowlist gap
  (vendored-copy delta, fixed); the whole-binary negative control proves the
  row-activity assertion bites (smoke SMOKE_NEGATIVE_CONTROL=1).
- **ROUND C audit find (fixed): the web console gate's old filter judged
  "Failed to load resource" errors with a broken ternary — non-favicon 4xx/5xx resource
  errors escaped BOTH filters. The tightened gate (exact-URL allowlist via
  page.on('response')) immediately exposed the real recurring 404 it had been covering:
  dsh-web CORE's `/open-in-app/icon` route (host UI, not this plugin), which is now
  allowlisted explicitly in web.real.test.mjs.**

## Whole-binary harness evidence

- `node harness/verify.mjs`: **VERIFY PASS** (2026-10-12 20:27, post-audit) - 3 fresh venvs per arm + 3 flip-sweep runs; baseline/plugin-persist write session files, plugin-incognito and the incognito flips write zero; every run reached the mock and exited cleanly.
- `node harness/smoke.mjs` + `SMOKE_NEGATIVE_CONTROL=1`: **SMOKE PASS** and the **negative control TRIPPED** (2026-10-12 20:27, post-audit; row activity mounted=true, base disabled=true, persist arm files=2, incognito arm files=0).

## Closure-audit section (ROUND C, 2026-10-12)

Re-verified every closed bead against its recorded evidence; **nine of the fourteen closed work beads verified as-is; five closures were reopened because the recorded evidence did not hold** (then fixed and re-closed):


- `dsh-incognito-kr8` (SPEC.md): SPEC §3 still described the dql bug as live ("the red
  test will drive that fix") although the fix was committed (a9b6b79/807e87f), tagged,
  and released; the P-04 mode-stays-incognito product decision existed only in a code
  comment. → Fixed (commit 30eb116).
- `dsh-incognito-pcs` (TESTING.md): "Known open items" still listed dql ("red pending")
  and 8h5 as open — contradicting their closures — and the P-07 row claimed a client
  restart leg via "toggle-lifecycle fixtures" that contained no restart at all. →
  Fixed (this file).
- `dsh-incognito-vzv` (TUI suite): no restart leg existed for P-07 (the bead's own
  description required one), and the P-06 sweep generated all of its cases on ONE
  shared client — contradicting the recorded "fresh TUI per case" evidence and
  testing.md's per-case isolation rule. → Fixed: per-case fixtures + P-07 legs.
- `dsh-incognito-bac` (web suite): the same P-06 isolation problem, and the console
  gate silently allowed non-favicon failed-resource loads. → Fixed both.
- `dsh-incognito-18t` (release bead): the recorded release-budget evidence (NUM_RUNS=25
  once per surface, one shared client, no seed recorded, not FC_SEED-replayable) was
  under the authorized round-3 budget (≥100 real-client cases per surface over ≥3 seeds;
  fast suites ≥1000). → Fixed: campaign re-run post-audit against the pinned tag's code
  (no re-release), numbers recorded above; RELEASING.md's budget step updated.

Verified as-is (no reopen): `26a`/`7ds` (pins + contract test), `afh` (baseline),
`jbm` (rig vendored; verify/smoke mock-only), `nqk` (§5 verdicts), `qmw` (flake green),
`8h5` (build print + gate flip), `dql` (red a9b6b79 → fix 807e87f — real and shipped in
v0.1.0-alpha.2), `68o` (nix-config 31d1097 pins tag v0.1.0-alpha.2, rev 25a3ceb verified
in flake.lock; profile tests assert the -alpha.2 row). One stale text line remains in
nix-config's pkgs/dsh-incognito.nix comment ("-alpha.1 pinned") — reported to the lead,
not touched from this repo.

## Known open items

- None blocking. Residuals recorded deliberately: the P-07 web-restart UI leg is covered
  at facade/fresh-service level with the rationale in SPEC (not a silent skip); the
  dsh-web core `/open-in-app/icon` 404 belongs to DSH, not this plugin; dsh-TUI 0.14.0
  shows an upstream "validate against 0.2.0-rc.2" banner on DSH 0.2.1-alpha.2 (upstream
  nag under the fleet alpha exception, harmless to the plugin and reported for
  awareness).
