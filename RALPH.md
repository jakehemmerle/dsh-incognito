# RALPH.md — dsh-incognito work graph (agent rounds)

Plugin: incognito mode for DSH session persistence. Replaces the durable
`session-persistence-jsonl` backend with an ownership-routed facade; incognito
sessions never touch disk. Surfaces: **TUI** (`/incognito` command in dst),
**headless** (`DSH_INCOGNITO=1` env), **web** (server-side session persistence for
web-created sessions; no web UI control by design — rationale goes in SPEC.md).

Follows the §4 round protocol from `~/personal-codebases/DSH-PLUGINS-HANDOFF.md`
(Jake's requirements §1, plugin row §5, subagent brief §7). Beads prefix:
`dsh-incognito` (bd init chose the repo name; handoff suggested `incog` — kept
`dsh-incognito`, self-documenting). Run `bd ready` each round; work top-priority
ready beads; end every round with commits pushed, RALPH.md updated, `bd export`,
and a report to the lead.

## Round history

### Round 1 — recovery + graph + peer-pin red (2026-10-11, late)

Previous engineer's turn was interrupted mid-round; `git status` was clean at
`d1aad8c` (nothing to finish or discard). Their 10 commits have **no
`5.3 FLASH: ` prefix** — history left as-is (do not rewrite pushed main); all
new commits use the prefix.

State found: working plugin implementation (facade over durable + in-memory
backends, mid-session conversion on toggle-on, mode store with env initial,
`/incognito` command), vitest+fast-check suite (mode/store/property/toggle-lifecycle),
and `harness/verify.mjs` whole-binary arms. Missing: beads (initialized this
round), RALPH.md, SPEC.md, flake.nix, vendored rig, real-client web/TUI tests,
TESTING.md, RELEASING.md/CHANGELOG.md.

Critical bug confirmed live: **package.json pins every `@deepseek-ai/*` peer to
`0.2.0-rc.2` while the fleet (and this host) runs `0.2.1-alpha.2`** → DSH
disables the plugin at startup; the profile patch also disables
`session-persistence-jsonl`, so any profile wiring it today would have **zero
session persistence**. This is the fleet-killing risk the lead flags in §6.3.

Work graph (epic `dsh-incognito-b1r`; open when this file is stale, trust `bd ready`):

- [x] `dsh-incognito-afh` recovery baseline (r1)
- [x] `dsh-incognito-26a` red contract test (r1, fixed same round)
- [x] `dsh-incognito-nqk` §5 audit (r1: wrong-session REAL→fixed; conversion window → dql; degraded → closed)
- `dsh-incognito-kr8` SPEC.md with property IDs + oracles + surface rationale
- `dsh-incognito-7ds` (blocked by 26a) fix pins to 0.2.1-alpha.2 + cordis 4.0.5-alpha.1, re-qualify
- `dsh-incognito-jbm` (blocked by 7ds) vendor mock-llm rig into test/rig/, rework verify.mjs off live creds (kills two §5 bugs: verify harness uses live creds; smoke harness invalid — no model row)
- `dsh-incognito-vzv` (blocked by jbm) dsh-TUI real-client property tests, private tmux socket
- `dsh-incognito-bac` (blocked by jbm) Playwright web real-client property tests
- `dsh-incognito-qmw` (blocked by 7ds) flake.nix: package/devShell/checks/.#e2e
- `dsh-incognito-pcs` (blocked by vzv+bac) TESTING.md traceability
- `dsh-incognito-18t` (blocked by pcs+qmw) RELEASING.md + CHANGELOG.md + tag `v0.1.0-alpha.1` when green (round-3 gate)
- `dsh-incognito-68o` (blocked by 18t) nix-config wiring (pkgs + home/dsh.nix rows + test_dsh_profiles.py); incognito is **excepted** from the don't-touch-nix-config rule

	
### Round 1 — outcome (2026-10-12, early)

Closed beads:
- `dsh-incognito-afh` recovery baseline: deps via corepack pnpm 12.11.2 (pnpm 12 gates build scripts; approve via pnpm-workspace.yaml `onlyBuiltDependencies`, packageManager pinned), node v24.21.0. Baseline suite 18/18 green BEFORE the pin bump.
- `dsh-incognito-26a` + `dsh-incognito-7ds` (red→fix pair, the fleet-killing bug): contract test `test/contract.test.ts` resolves the installed host via DSH_BIN→which→readlink→exec-target chain and asserts every `@deepseek-ai/*` peer/devDep is an EXACT pin of the version present in that install tree. Red b73fb61 (peers 0.2.0-rc.2 vs installed 0.2.1-alpha.2 → DSH disables the plugin; profile patch also disables session-persistence-jsonl → profile loses ALL persistence). Fix 98d80ec: peers/devDeps pinned to dsh-* = 0.2.1-alpha.2, cordis = 4.0.5-alpha.1; oracle refined to per-package host versions (cordis has its own version line). Typecheck + 21/21 + build green at alpha.2; plugin API surface verified compatible (no runtime drift).
- `dsh-incognito-nqk` §5 audit verdicts:
  1. **wrong session wiped — REAL, fixed** (red 77938d5 → fix e7d4166). `facade.toggle()` guessed "most recent live write handle"; the real `CommandInvocation` (dsh-commands alpha.2) carries `agent.session.id` ("Agent.session: the live session this agent drives"). Fix: `toggle(requestedId?)` converts the requested id only (legacy fallback kept); `/incognito` handler passes `invocation.agent.session.id`. R1/R2 in `test/toggle-target.test.ts` green; suite 23/23.
  2. **non-transactional conversion — partially mitigated**: ordering read→close→wipe→buffer is deliberate; a wipe failure after close leaves mode toggled + inner handle closed → follow-up bead `dsh-incognito-dql` (repro idea: read-only parent chmod; fix idea: reopen+swap-back or atomic staged rename).
  3. **degraded mode silent — closed**: attachInner console.error + logger.warn; every degraded create warns (service.ts).
- Chore bead `dsh-incognito-8h5`: build.mjs prints 0.0 KiB (cosmetic; lib/index.js ≈21 KiB and correct).

Commits this round (all pushed to origin/main): bce3d6b (build: pnpm 12 + build approvals), b73fb61 (red), 98d80ec (fix pins), 77938d5 (red), e7d4166 (fix toggle target). cb4869e = bd init (auto).

Next round (round 2), in priority order — trust `bd ready`:
1. `dsh-incognito-kr8` SPEC.md (P-ids, oracles, surfaces; web N/A rationale for a /command: web sessions persist server-side — web tests assert server-side files, not a web UI control).
2. `dsh-incognito-jbm` vendor mock-llm rig into test/rig/ and rework harness/verify.mjs off live creds (never run the r0 verify.mjs as-is: it copies ~/.dsh/.credentials.yaml and calls the real ProviderProxy).
3. Then TUI (vzv) / web (bac) real-client property tests, flake.nix (qmw).

### Round 2 — outcome (2026-10-12)

Closed beads (lead's ordered list, all three):
- `dsh-incognito-kr8` **SPEC.md**: P-01..P-13 with independent oracles (FS/MEM/WIRE/HOST/CFG), per-surface columns (headless/TUI/web) incl. N/A rationales, the non-negotiable persistence invariants (persist writes files P-01; incognito writes none P-02; the invocation session is the one converted P-03; conversion transactional P-04), privacy-scope statement (disk persistence only — not network/memory privacy; resume-after-restart impossible by design), state ownership, and the dql gap noted as the target invariant "a failed wipe leaves the session durable and usable".
- `dsh-incognito-jbm` **vendored rig**: `test/rig/mock-llm.mjs` (verbatim from skill @ nix-config 6a7e613, provenance header). `harness/verify.mjs` + `harness/smoke.mjs` reworked onto the local mock (api: openai-completions, MOCK_API_KEY dummy env). Grep acceptance CLEAN (no user-credential-store refs, no real provider anywhere in harness/). smoke asserts row activity via --dump-config (plugin row mounted + base row disabled) and its negative control (SMOKE_NEGATIVE_CONTROL=1) trips when the plugin is unmounted. verify: VERIFY PASS (3 venvs/arm × baseline/persist/incognito + 3 flip sweeps, every run reaches the mock). Commit 19fb4a9.
- `dsh-incognito-qmw` **flake.nix** (commit 9aaf90a): packages.default (esbuild CLI bundle, version from package.json, peer-resolution symlink farm from the pinned dsh tree), devShells.default (node, pnpm, tmux, esbuild, beads 1.3.0, pinned dsh on PATH + dst shim), checks.suite (FULL vitest+tsc offline via fetchPnpmDeps + pnpmConfigHook, DSH_BIN pointed at the pinned store dsh), apps.e2e (verify harness with the store-built bundle via PLUGIN_LIB override). `nix flake check` green; `nix run .#e2e` VERIFY PASS.

Debug findings recorded for future rounds (all resolved inside 9aaf90a):
1. nixpkgs pnpm is 11.x: no --allow-build (pnpm-workspace.yaml onlyBuiltDependencies works there), --trust-lockfile needed offline (the hook sets it), and the repo's packageManager pnpm@12 pin must not be visible to pnpm 11 (manage-package-manager-versions self-fetch) — pnpmConfigHook flow handles all of it.
2. fetchPnpmDeps output is a READ-ONLY store; pnpm needs a writable copy — pnpmConfigHook does this; never hand-wire --store-dir.
3. The store-built bundle needs peer modules RESOLVABLE from its own tree: packages.default ships node_modules/@deepseek-ai/* symlinks into the pinned dsh input copy (in-closure; noBrokenSymlinks rejects literal store-path symlinks). The RUNNING binary for devShell/checks/e2e is the literal fleet path i24c2k38… (input copies would fork module identity); P-11's contract test gates pin drift.

Next round (round 3 = release round), in priority order — trust `bd ready`:
1. `dsh-incognito-vzv` TUI real-client property tests (private tmux socket, /incognito mid-session arms).
2. `dsh-incognito-bac` Playwright web real-client property tests (server-side persistence arms).
3. `dsh-incognito-pcs` TESTING.md traceability; `dsh-incognito-18t` RELEASING.md + CHANGELOG.md + tag v0.1.0-alpha.1 if the full suite is green (round-3 release budgets: ≥100/surface across ≥3 seeds where applicable).
4. Backlog: dql (wipe-failure red), 8h5 (build print), 68o nix-config wiring (lead deploys after tag).

### ROUND A (post-restart) — outcome (2026-10-12)

Closed:
- `dsh-incognito-vzv` (2e24f71 prior export; tests committed with vitest include fix): **real dsh-TUI property tests** — 4 arms on a private tmux socket: P-01 persist baseline (files on chat); P-02/03/04 mid-session `/incognito` through the REAL command dispatch (current session wiped, zero writes after, turn continues in memory); P-05 toggle-off → `/new` → next session persists; P-06 `DSH_INCOGNITO=1` fc burst sweep. The P-06 sweep **caught a rig bug**: the vendored rig's tmux env allowlist dropped DSH_INCOGNITO (fixed as a documented vendored-copy delta). Commit 2e24f71-adjacent (vzv suite + vitest include + rig delta).
- `dsh-incognito-bac` (7784527): **real dsh-web property tests** — Playwright (nix google-chrome via executablePath) through the REAL web UI: dismiss preview notice → choose workspace → chat in the composer. Arms: P-01 server-side files; P-02/03/04 `/incognito` dispatched from the composer **wipes the current session server-side** (the command IS dispatchable in web — no web N/A, SPEC updated understanding); P-06 boot-incognito fc sweep. Preview-notice dismissal race found by a full-suite repeat run, fixed, repeat ×3 green.
- `dsh-incognito-pcs` (bdfe025): **TESTING.md** — P-01..P-13 traceability (oracle/test/surfaces/results), budgets, seed policy, flake/mutation findings, open items.
- `dsh-incognito-18t` (bdfe025, tag `v0.1.0-alpha.1`): **RELEASING.md** (SemVer gate, no bypass), **CHANGELOG.md**, version → **0.1.0-alpha.1** (DSH alpha channel). Release gate green: 30/30 host suites; NUM_RUNS=25 release sweeps on BOTH surfaces; verify VERIFY PASS; `nix flake check` all checks passed; `nix run .#e2e` VERIFY PASS with the store-built bundle. Real-client suites gated behind `RUN_REAL_CLIENT=1` for the OFFLINE nix suite check (no browser/tmux in the sandbox; documented in TESTING.md — they run on host and via the e2e app).

**The lead can now wire nix-config to tag `v0.1.0-alpha.1`** (bead 68o awaits ROUND B authorization).

Open after ROUND A: `dsh-incognito-dql` (red: wipe-failure window), `dsh-incognito-8h5` (chore: build print), `dsh-incognito-68o` (nix-config wiring, blocked on lead authorization), epic `b1r`.

### ROUND B — outcome (2026-10-12)

Closed:
- `dsh-incognito-68o` **nix-config wiring** (nix-config commit f417198, pushed to main, preflight OK, NO conflicts with Jake's concurrent commits — stacked cleanly on 5c7228f): `pkgs/dsh-incognito.nix` (flake input pinned to tag `v0.1.0-alpha.1`; esbuild bundle; node_modules peer symlink farm into dshBase so the bundle resolves the host's own modules; postInstall import smoke proves peer resolution), `home/dsh.nix` (base `session-persistence-jsonl` disabled + facade inserted with the host-computed `root = <home>/.dsh/sessions` in BOTH web and TUI patches — JSON rows, since yaml.generate cannot emit !!js), `tests/test_dsh_profiles.py` (check_incognito asserts the disable row and exactly one facade insert with the tagged name and sessions root on every profile-having host; whole file green: jake/work/gpu/fw13 + dev-main/generic-dev, kali* have no profiles). **dev-main note**: it imports dsh.nix via omp-proxy.nix, so "absence elsewhere" = profile-less hosts only; incognito is unconditional like usage-limits (Jake's installed-everywhere requirement). The lead handles rollout; per-host verification pending.
- `dsh-incognito-dql` **red→fix** (a9b6b79 → 807e87f): wipe failure mid-conversion — red test chmods the session's parent dir so rmSync fails; fix catches the failure, REOPENS the durable handle for write and swaps it back as the backing before rethrowing, so a failed wipe leaves the session durable, owned, and appendable (mode stays incognito — session-scoped invariant per SPEC P-04; mode rollback noted as a separate product decision).
- `dsh-incognito-8h5` (b3e1718): build.mjs now stats the written bundle (21.6 KiB); real-client suites skip ONLY when the offline nix check sets SKIP_REAL_CLIENT=1 (host runs always execute them — the round-2 gate default was inverted).

Open beads: only the epic `b1r` (rounds continue) — everything else closed. Next tag (0.1.0-alpha.2 or 0.1.1-alpha.1) should include the dql fix; v0.1.0-alpha.1 remains the pinned release until the lead re-tags.
## Environment facts (verified this round)

- Host dsh: **0.2.1-alpha.2** (`/nix/store/i24c2k38bz3h86r0v7bjr4amk7d4vxrj-dsh-0.2.1-alpha.2`,
  launcher `~/.local/share/nix-management/bin/dsh`); dst reports the same. Fleet dsh-TUI: **0.14.0**.
- Nested store packages (alpha.2): dsh-session-persistence(-jsonl)/dsh-commands/dsh-session =
  `0.2.1-alpha.2`, cordis = `4.0.5-alpha.1` under
  `<store>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`.
- node v24.21.0 at `/etc/profiles/per-user/jake/bin/node`; **no pnpm on PATH** —
  use `corepack pnpm ...` (corepack 0.36.0). npx 11.19.0.
- alpha.2 `dsh-session-persistence` still exports everything the plugin imports
  (SessionPersistence, handle types, all errors, storage-contract validators).
- Verification harness rule: **mock model only, no live credentials** — never run
  `harness/verify.mjs` as committed in r0 (it copies `~/.dsh/.credentials.yaml`
  and calls the real ProviderProxy). Fixed by bead `dsh-incognito-jbm`.
- Isolation: never `~/.dsh`, `~/.dsh-tui`, port 3080, Jake's tmux.

## Rules (from the handoff)

- Every commit message starts with `5.3 FLASH: `. Commit straight to main; pull
  `--ff-only` before committing; stage only this repo's paths; test before each
  commit — except a red commit for a real bug, which is committed alone and
  followed by a separate fix commit.
- Bugs found: red commit (`5.3 FLASH: red: <id> ...`) then fix (`5.3 FLASH: fix: ...`).
- Mock model only. No real credentials in automated runs.
