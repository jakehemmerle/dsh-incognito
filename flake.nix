{
  description = "dsh-incognito: incognito mode for DSH session persistence";

  inputs = {
    # Fleet nixpkgs pin (~/nix-config/flake.lock, node "nixpkgs").
    nixpkgs.url = "github:NixOS/nixpkgs/7fc6f2c20af09cdcaf48b92ec3121860139ec668";
    # Fleet DSH 0.2.1-rc.2 tree, pinned as a path input: its node_modules
    # copies feed the plugin package's peer symlinks (in-closure, so the
    # bundle can resolve the same-version host modules). The RUNNING binary
    # used by devShell/checks/e2e is the literal dshStore path below - the
    # exact store build the nix-management launcher execs; dst is that same
    # binary with --profile dsh-tui.
    dsh.url = "path:/nix/store/l9m9bm830hjgs0xhi86wv8g3bgwlsyz6-dsh-0.2.1-rc.2";
    dsh.flake = false;
  };

  outputs = { self, nixpkgs, dsh }:
    let
      # Fleet DSH 0.2.1-rc.2 - the EXACT store build the nix-management
      # launcher execs (and dst: the same binary with --profile dsh-tui).
      # Referenced literally so the plugin resolves the host's own module
      # instances; the P-11 contract test fails the suite if this pin drifts
      # from package.json's exact peer pins.
      dshStore = "/nix/store/l9m9bm830hjgs0xhi86wv8g3bgwlsyz6-dsh-0.2.1-rc.2";
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: builtins.listToAttrs (map (s: { name = s; value = f s; }) systems);
      pluginMeta = builtins.fromJSON (builtins.readFile ./package.json);
      # Clean source: drop build/test state and the beads db (git-ignored anyway).
      cleanSrc = pkgs: pkgs.lib.cleanSourceWith {
        src = pkgs.lib.cleanSource ./.;
        filter = path: type: !(type == "directory" && (baseNameOf path == "node_modules" || baseNameOf path == "lib" || baseNameOf path == ".git" || baseNameOf path == ".beads" || baseNameOf path == "test" || baseNameOf path == "harness" || baseNameOf path == ".devbin"));
      };
    in
    {
      packages = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; }; in {
          default = pkgs.stdenv.mkDerivation {
            pname = "dsh-incognito";
            version = pluginMeta.version;
            src = cleanSrc pkgs;
            nativeBuildInputs = [ pkgs.esbuild ];
            dontConfigure = true;
            dontBuild = true;
            installPhase = ''
              mkdir -p $out/lib $out/node_modules/@deepseek-ai
              esbuild src/index.ts --bundle --format=esm --platform=node --target=node22 \
                --packages=external --sourcemap --legal-comments=eof --log-level=warning \
                --outfile=$out/lib/index.js
              cp package.json $out/package.json
              # The bundle keeps @deepseek-ai imports external; resolve them
              # against the HOST's own copies (the pinned dsh store build), so
              # service classes and error types stay single-sourced with the
              # running dsh. No second copy of any @deepseek-ai module.
              for pkg in cordis dsh-commands dsh-session dsh-session-persistence dsh-session-persistence-jsonl; do
                ln -s "${dsh}/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/$pkg" "$out/node_modules/@deepseek-ai/$pkg"
              done
            '';
            passthru = {
              inherit pluginMeta;
              # The exact pinned host build the suites ran against.
              inherit dshStore;
            };
          };
        });

      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; }; in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs pkgs.pnpm pkgs.tmux pkgs.esbuild ];
            shellHook = ''
              export DSH_TELEMETRY_DISABLED=1
              # Fleet-pinned dsh (0.2.1-rc.2) and beads 1.3.0.
              export PATH="${dshStore}/bin:/nix/store/8yhl7n32v992xlidv0jy53gyl4mgq8a3-beads-1.3.0/bin:$PATH"
              # dst shim: the pinned binary with the TUI profile, like the
              # nix-management launcher does.
              mkdir -p .devbin
              printf '#!/usr/bin/env bash\nexec ${dshStore}/bin/dsh --profile dsh-tui "$@"\n' > .devbin/dst
              chmod +x .devbin/dst
              export PATH="$PWD/.devbin:$PATH"
            '';
          };
        });

      checks = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          plugin = self.packages.${system}.default;
          # Full offline dependency store from pnpm-lock.yaml (fixed output).
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (plugin) pname version;
            src = pkgs.lib.cleanSource ./.;
            fetcherVersion = 2;
            hash = "sha512-bAPcjDA5R1SlEUfvKqrlDDu8/bfmdOp8uIMUr2eLM3NSxJ6Iv8x23tG5bdcjQUMALveNNzHEaBSCNMPfkIRPGQ==";
          };
        in {
          # Fast suites (vitest + tsc) against the exact pinned dsh: the
          # contract test resolves DSH_BIN from the store pin, so a pin or
          # peer drift fails here first.
          suite = pkgs.stdenv.mkDerivation {
            name = "dsh-incognito-suite-" + plugin.version;
            src = cleanSrc pkgs;
            nativeBuildInputs = [ pkgs.nodejs pkgs.pnpm pkgs.pnpmConfigHook ];
            pnpmDeps = pnpmDeps;
            DSH_BIN = "${dshStore}/bin/dsh";
            # The sandbox has no browser or tmux: the real-client suites report
            # as skipped here and run on the host / via the e2e app instead.
            SKIP_REAL_CLIENT = "1";
            # pnpmConfigHook (postConfigure) installs node_modules offline with
            # --ignore-scripts, wires pnpm 11 flags (trust_lockfile, pm_on_fail)
            # and copies the fetched store to a writable dir.
            dontPnpmBuild = true;
            checkPhase = ''
              pnpm typecheck
              pnpm test
            '';
            installPhase = ''
              touch $out
            '';
          };
        });

      apps = forAllSystems (system: {
        e2e = {
          type = "app";
          program = let
            pkgs = import nixpkgs { inherit system; };
          in "${pkgs.writeShellScript "dsh-incognito-e2e" ''
            set -eu
            export PATH="${pkgs.nodejs}/bin:${dshStore}/bin:$PATH"
            export DSH_TELEMETRY_DISABLED=1
            export PLUGIN_LIB="${self.packages.${system}.default}/lib/index.js"
            cd ${self}
            node harness/verify.mjs
          ''}";
        };
      });
    };
}
