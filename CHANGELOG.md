# Changelog

## 0.1.0-rc.1 (2026-10-30)

Port to DSH 0.2.1-rc.2. No user-visible behavior change.

- **Fixed:** the plugin could not load on DSH 0.2.1-rc.2. rc.2's
  `@deepseek-ai/dsh-session-persistence-jsonl` no longer default-exports
  `JsonlSessionPersistence`; it exports the plugin (`apply`/`Config`/`name`),
  whose `apply` builds the backend together with its tracker. The facade now
  mounts that plugin on the isolated `sessionPersistence` child scope and reads
  the backend back through `inject`; every facade operation awaits the mount,
  and a failed mount enters degraded mode as before.
- **Changed:** the bundle is ESM (`"type": "module"`). rc.2 imports plugin rows
  concurrently, and the CJS bundle's `require()` of the host's ESM packages
  failed with `ERR_REQUIRE_ESM_RACE_CONDITION`.
- **Peers:** exactly `@deepseek-ai/dsh-*` 0.2.1-rc.2 and cordis 4.0.5.
- **Tests:** the web real-client driver accepts rc.2's preselected default
  workspace (alpha.2 opened on a workspace chooser).
- **Tested against:** DSH 0.2.1-rc.2 (fleet patched store build
  `/nix/store/l9m9bm830hjgs0xhi86wv8g3bgwlsyz6-dsh-0.2.1-rc.2`), dsh-TUI 0.16.1
  (nix-config fleet build `/nix/store/ij4q915vdsagwrgsdbwpwka5lxd16hzn-dsh-tui-0.16.1`),
  commit 70d3f71 (code; this entry is docs only). Evidence, 2026-10-23:
  - red: the previous `src/service.ts` against rc.2 fails 6/7 facade tests
    (toggle-target R1/R2, toggle-lifecycle P2-P5: `default is not a constructor`);
  - full `vitest run` with real clients: 35/35;
  - fast properties `NUM_RUNS=1000 FC_SEED=20261023`: 7/7 (418 s);
  - release sweeps P-06, one fresh client/server per case: TUI and web each
    34 + 33 + 33 = 100 cases over seeds 20261023/24/25, all green
    (TUI 131/126/122 s, web 190/188/185 s);
  - mutant (inner backend never assigned) caught by TUI P-01 and web P-01;
  - `nix flake check` green; `nix run .#e2e` VERIFY PASS;
  - nix-config fleet smoke (isolated DSH_HOME): dst persist turn writes a
    session, `/incognito` wipes it and later turns write nothing,
    `DSH_INCOGNITO=1` boot writes nothing, dsh web boots with no plugin
    warnings.
- **Release gate (2026-10-30, mbp; commit tested 5a274eb, the merge of PR #1
  on main):** DSH 0.2.1-rc.2 (`DSH_BIN` = the pinned store build above),
  dsh-TUI 0.16.1 (`DSH_TUI_DIR` = the store build above), headless Chromium
  (Playwright chromium-1217), node v24.16.0, pnpm 12.11.2. Fresh clone, after
  `corepack pnpm install --frozen-lockfile && corepack pnpm build`:
  - `corepack pnpm typecheck` green; `corepack pnpm test` 35/35 (9 files;
    real-client TUI 6/6 and web 3/3 executed, none skipped);
  - `node harness/verify.mjs` VERIFY PASS;
  - fast properties `NUM_RUNS=1000 FC_SEED=20261030` (property.test +
    toggle-lifecycle): 7/7 (310 s);
  - P-06 release sweeps, one fresh client/server per case: TUI and web each
    34 + 33 + 33 = 100 cases over seeds 20261030/31/32, all green
    (TUI 120/133/126 s, web 185/182/177 s);
  - `nix flake check` all checks passed; `nix run .#e2e` VERIFY PASS;
  - open beads: only the umbrella epic dsh-incognito-b1r (fleet rollout
    follows the release); no release blockers.
- GitHub Actions is unavailable (billing); the local checks above are the gate.

## 0.1.0-alpha.2 (2026-10-12)

Durability fix release, cut before fleet rollout so hosts get the conversion
rollback from day one.

- **Fixed:** a failed wipe during mid-session conversion no longer leaves the
  session bricked — the facade reopens the durable handle and restores it as
  the backing before rethrowing, so a failed wipe leaves the session durable,
  owned, and appendable (bead dsh-incognito-dql; red a9b6b79, fix 807e87f).
- **Chore:** build.mjs measures the written bundle; real-client suites skip
  only when the offline Nix check sets SKIP_REAL_CLIENT=1.
- **Tested against:** unchanged — DSH 0.2.1-alpha.2, dsh-TUI 0.14.0, peers
  exactly `0.2.1-alpha.2` / cordis `4.0.5-alpha.1`. Evidence: 31/31 host
  suites incl. real-client arms, verify arms VERIFY PASS, `nix flake check`
  green, `nix run .#e2e` VERIFY PASS (this tag), profile tests in nix-config
  green. Full matrix: TESTING.md.

## Closure audit (2026-10-12, after the v0.1.0-alpha.2 rollout)

Jake's ROUND C closure audit re-verified every closed bead against its
recorded evidence. Five closures were reopened and fixed on the same pinned
targets (no version bump; this entry documents post-release verification of
the same code):

- **Fixed (test hardening):** P-07 restart-on-the-same-profile had no test at
  any level — a facade-level restart property (`test/restart.test.ts`) and
  two real-client TUI restart legs (`/resume` supervisor; converted-session
  erasure) landed. The P-06 boot sweeps now use one fresh client/mock/profile
  per generated case and honor `FC_SEED`/`FC_PATH`.
- **Release-budget evidence completed (no re-release):** ≥100 real-client
  generated cases per surface (TUI, web) across seeds 20261012/13/14, plus
  fast suites at `NUM_RUNS=1000` — results in TESTING.md.
- **Fixed (test gate):** the web console gate's filter let non-favicon
  "Failed to load resource" errors pass; tightening it exposed dsh-web core's
  `/open-in-app/icon` 404, now explicitly allowlisted.
- **Mutation audit:** 3 planted mutants (dropped wipe recovery, legacy
  wrong-target toggle, dropped env spelling) — caught 3/3.
- **SPEC.md** now records the P-04 mode-stays-incognito product decision
  (a failed wipe restores the session's durable backing; the mode does not
  roll back) and marks the dql gap resolved.
## 0.1.0-alpha.1 (2026-10-12)

First tagged release. Incognito mode for DSH session persistence: sessions
created while the mode is on never touch disk; `/incognito` converts the
current session in place (its on-disk log is wiped and it continues in memory);
`DSH_INCOGNITO=1` selects incognito at boot.

- **Tested against:** DSH 0.2.1-alpha.2 (fleet alpha exception), dsh-TUI 0.14.0;
  plugin peers pinned exactly (`@deepseek-ai/dsh-*` = 0.2.1-alpha.2,
  `@deepseek-ai/cordis` = 4.0.5-alpha.1). Source revision: the commit this tag
  annotates.
- **Fixed:** peer pins no longer disable the plugin on 0.2.1-alpha.2 (which,
  with the base durable row disabled by the profile patch, left profiles with
  no session persistence at all) — red b73fb61, fix 98d80ec.
- **Fixed:** `/incognito` converts exactly the invoking session
  (`invocation.agent.session.id`), never the most recently issued write handle —
  red 77938d5, fix e7d4166.
- **Evidence:** 30/30 vitest (facade + real-client suites); whole-binary verify
  arms + mode-flip sweep green on the mock model; smoke negative control trips;
  release sweeps NUM_RUNS=25 per surface (real dsh-TUI, real dsh web) green;
  `nix flake check` and `nix run .#e2e` green. Full matrix: TESTING.md.
- **Known gaps:** wipe-failure window in mid-session conversion (bead
  dsh-incognito-dql, red pending); mode is process-local by design.
