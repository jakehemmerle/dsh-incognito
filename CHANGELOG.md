# Changelog

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
