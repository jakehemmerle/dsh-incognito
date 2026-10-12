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
