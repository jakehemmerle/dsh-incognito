import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Contract suite (new-dsh-plugin testing.md §2): the plugin's @deepseek-ai/*
 * peer pins are a host seam. DSH version-gates plugins at profile startup: a
 * peer whose declared version stops below (or beside) the running dsh gets the
 * plugin DISABLED. For this plugin that is catastrophic and silent-ish: the
 * profile patch also disables the base `session-persistence-jsonl` row, so a
 * mismatched peer leaves the profile with NO session persistence at all.
 *
 * Release rule (references/release.md rule 3): against a prerelease DSH, peers
 * are pinned to EXACTLY the versions the full suites passed against — no ^/~
 * ranges, because npm and DSH may disagree on prerelease range matching.
 *
 * The installed host version is resolved from the real dsh launcher: DSH_BIN
 * (default `dsh`) is realpathed, launcher `exec` targets are followed, and the
 * version is read from the resolved install's `@deepseek-ai/dsh/package.json`.
 * A run that cannot resolve the host binary fails loudly (no silent skips);
 * set DSH_BIN to the launcher path in sandboxed environments.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface DshPackage {
  name: string;
  version: string;
}

function execTargetOf(scriptPath: string): string | undefined {
  let script: string;
  try {
    script = readFileSync(scriptPath, 'utf8');
  } catch {
    return undefined; // binary or unreadable — not a launcher script
  }
  const execLine = script.split('\n').reverse().find((line) => /^\s*exec\s+"?\S*dsh("?\s+".*)?$/.test(line));
  if (execLine === undefined) return undefined;
  const match = /exec\s+"?(\S*dsh)"?/.exec(execLine);
  return match?.[1];
}

function installedDshVersion(): DshPackage {
  const bin = process.env.DSH_BIN ?? 'dsh';
  const found = spawnSync('which', [bin], { encoding: 'utf8' });
  const onPath = found.status === 0 ? found.stdout.trim().split('\n')[0]?.trim() : '';
  if (onPath === undefined || onPath === '') {
    throw new Error(`cannot find "${bin}" on PATH (set DSH_BIN to the dsh launcher path)`);
  }
  const real = spawnSync('readlink', ['-f', onPath], { encoding: 'utf8' });
  const resolved = real.status === 0 && real.stdout.trim() !== '' ? real.stdout.trim() : onPath;
  // Candidate chain, most concrete first: an `exec`ed store binary (the
  // versioned nix wrapper tree that carries lib/node_modules), then the
  // realpath and the PATH entry themselves.
  const candidates: string[] = [];
  for (const link of [resolved, onPath]) {
    const target = execTargetOf(link);
    if (target !== undefined) candidates.push(target);
  }
  candidates.push(resolved, onPath);
  for (const entry of candidates) {
    // <install>/bin/dsh → <install>/lib/node_modules/@deepseek-ai/dsh/package.json
    const pkgPath = join(dirname(entry), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string; version: string };
      return { name: pkg.name, version: pkg.version };
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`cannot read @deepseek-ai/dsh/package.json under any of: ${candidates.join(', ')} (set DSH_BIN to the dsh launcher path)`);
}

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as T;
}

describe('host seam: @deepseek-ai peer pins match the installed dsh exactly', () => {
  const pkg = loadJson<{ name: string; version: string; peerDependencies: Record<string, string>; devDependencies: Record<string, string> }>('package.json');

  it('resolves the installed dsh binary', () => {
    const dsh = installedDshVersion();
    expect(dsh.name).toBe('@deepseek-ai/dsh');
    expect(dsh.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('every @deepseek-ai/* peerDependency is an exact pin of the installed dsh version', () => {
    const dsh = installedDshVersion();
    const peers = Object.entries(pkg.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/'));
    expect(peers.length).toBeGreaterThan(0);
    for (const [name, range] of peers) {
      expect(range, `${name} peer range must be an exact pin (no ^/~) against a prerelease dsh`).not.toMatch(/^[~^]/);
      expect(range, `${name} peer must be pinned to the installed dsh ${dsh.version} or DSH disables this plugin (and the profile loses persistence)`).toBe(dsh.version);
    }
  });

  it('every @deepseek-ai/* devDependency is the exact version the suites qualify against', () => {
    const dsh = installedDshVersion();
    const devs = Object.entries(pkg.devDependencies).filter(([name]) => name.startsWith('@deepseek-ai/'));
    for (const [name, range] of devs) {
      expect(range, `${name} devDependency must be an exact pin`).not.toMatch(/^[~^]/);
      expect(range, `${name} devDependency must match the installed dsh ${dsh.version}`).toBe(dsh.version);
    }
  });
});
