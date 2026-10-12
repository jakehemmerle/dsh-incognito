# Changelog

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
