# RELEASING.md

SemVer releases matching DSH's own prerelease scheme (see the new-dsh-plugin
skill's references/release.md; re-verify its dated facts at each release).

## Version scheme

- The plugin version is independent SemVer: while qualified only against a DSH
  prerelease, the version carries the matching channel (`-alpha.N` against a DSH
  alpha, `-rc.N` against an rc). Stable `x.y.z` only after the full suites pass
  against a stable DSH.
- `peerDependencies` pin every `@deepseek-ai/*` to the EXACT versions the full
  suites passed against (no `^`/`~` against prereleases). The contract test
  (`test/contract.test.ts`) fails the suite on any drift from the installed host.

## Release gate (no bypass)

1. `git pull --ff-only` on a clean main; close or defer release-blocking beads.
2. `corepack pnpm typecheck && corepack pnpm test` (fast + facade + real-client
   suites) and `node harness/verify.mjs` — all green on the pinned host.
3. Release-campaign budgets: real-client sweeps at `NUM_RUNS=25` per surface
   (`test/tui-real.test.mjs -t P-06`, `test/web.real.test.mjs -t P-06`).
4. `nix flake check` (offline suite check against the pinned dsh) and
   `nix run .#e2e` (whole-binary harness with the store-built bundle).
5. Record results (versions, seeds, counts) in CHANGELOG.md and TESTING.md.

## Cut a release

1. Bump `package.json` `version` (the flake derives its version from it).
2. Add a CHANGELOG.md entry: version, date, changes, exact DSH/dsh-TUI versions
   tested, the commit tested, suite evidence.
3. Commit `5.3 FLASH: release: vX.Y.Z`, create the annotated tag `vX.Y.Z` on
   that commit, push main and the tag.
4. Consumers (nix-config) pin the tag; deployment and per-host verification
   follow the lead's rollout process (Jake's acceptance gate first).
