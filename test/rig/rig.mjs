// Vendored from ~/nix-config/skills/new-dsh-plugin/scripts/rig.mjs
// (nix-config commit 6a7e613, October 2026; see test/rig/mock-llm.mjs header
// for the vendoring rationale). Update by re-copying from the skill.
// Isolated DSH test rig for plugin e2e tests. Never touches ~/.dsh or the
// live dsh-web on port 3080: every run gets its own HOME, DSH_HOME, port and
// tmux socket, and model calls go to mock-llm.mjs.
//
//   import { makeProfile, startWeb, runHeadless, startTui } from '<skill>/scripts/rig.mjs';
//   const mock = await startMockLlm();
//   const p = makeProfile({ kind: 'web', mock, plugins: [{ id: 'my-plugin', name: '/abs/path/index.js', config: {} }] });
//   const web = await startWeb(p);  await web.fetch('/api/x');  await web.stop();  p.dispose();
//
// kind: 'web' (dsh-base + dsh-web-app), 'headless' (dsh-base + dsh-headless),
// 'tui' (dsh-base + the installed/patched dsh-TUI, symlinked like nix-config).
// Env overrides: DSH_BIN (launcher), DSH_TUI_DIR (dsh-TUI package to mount).
// CLI: `node rig.mjs paths` prints the resolved launcher, store and package dirs.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where the installed DSH lives. All read-only; read its lib/ to learn plugin APIs. */
export function paths() {
  const managed = join(homedir(), '.local/share/nix-management/bin/dsh');
  const bin = process.env.DSH_BIN ?? (existsSync(managed) ? managed : 'dsh');
  let store = null;
  try { store = /\/nix\/store\/[a-z0-9]+-dsh-[0-9][^/\s"']*/.exec(readFileSync(bin, 'utf8'))?.[0] ?? null; } catch { /* not a wrapper */ }
  const dshRoot = store ? join(store, 'lib/node_modules/@deepseek-ai/dsh') : null;
  const packages = dshRoot ? join(dshRoot, 'node_modules/@deepseek-ai') : null;
  const version = dshRoot ? JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8')).version : null;
  let tui = process.env.DSH_TUI_DIR ?? null;
  if (!tui) {
    try { tui = realpathSync(join(homedir(), '.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui')); } catch { /* no dst profile */ }
  }
  return { bin, store, dshRoot, packages, version, tui };
}

const BUNDLES = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  tui: ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui'],
};
const PROFILE = { web: 'web', headless: 'headless', tui: 'rig-tui' };

export const MOCK_MODELS = [
  { id: 'mock-alpha', name: 'Mock Alpha', contextWindow: 128000, maxTokens: 8000, input: ['text'] },
  { id: 'mock-beta', name: 'Mock Beta', contextWindow: 200000, maxTokens: 16000, input: ['text', 'image'] },
];

/** Rows every rig profile carries: mock route as default, no prompts, no telemetry. */
export function baseRows(mock, { models = MOCK_MODELS, providerId = 'mock' } = {}) {
  const rows = [
    { id: 'permission', name: '@deepseek-ai/dsh-permission-presets', config: { defaultPreset: 'danger-full-access', presets: { 'danger-full-access': { approval: 'never', sandbox: 'danger-full-access' } } } },
    { id: 'session-log-deepseek', name: '@deepseek-ai/dsh-session-log-deepseek', config: { enabled: false } },
    { id: 'session-telemetry-otel', name: '@deepseek-ai/dsh-session-telemetry-otel', config: { mode: 'DISABLED' } },
    { id: 'plugin-package-inventory-deepseek', name: '@deepseek-ai/dsh-plugin-package-inventory-deepseek', config: { enabled: false } },
  ];
  if (mock) {
    rows.unshift({ id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: providerId, model: models[0].id } });
    rows.push({ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { [providerId]: {
      api: 'openai-completions', apiKeyEnv: 'MOCK_KEY', baseURL: mock.baseURL, displayName: 'Mock', models } } } });
  }
  return rows;
}

/**
 * A throwaway HOME/DSH_HOME with one profile.
 *   plugins: rows to insert ({ id, name: absolute file path to the entry (not a directory), config })
 *   rows:    extra patch rows (id-targeted overrides), applied after the base rows
 *   tuiRow:  dsh-tui row config override (tui only)
 */
export function makeProfile({ kind = 'web', mock, plugins = [], rows = [], bundles, models, tuiRow = {}, seedTui = {} } = {}) {
  if (!BUNDLES[kind]) throw new Error(`unknown kind ${kind}`);
  const where = paths();
  const root = mkdtempSync(join(tmpdir(), `dsh-rig-${kind}-`));
  const home = join(root, 'home');
  const dshHome = join(home, '.dsh');
  const name = PROFILE[kind];
  const dir = join(dshHome, 'profiles', name);
  const work = join(root, 'work');
  for (const d of [dir, work]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies: {},
    dsh: { profile: { bundles: bundles ?? BUNDLES[kind] } } }, null, 2));
  writeFileSync(join(dir, 'cordis.yml'), '[]\n');
  const all = [...baseRows(mock, { models }), ...rows];
  if (plugins.length) all.push({ insert: plugins });
  let patch = all.map((row) => `- ${JSON.stringify(row)}`).join('\n') + '\n';
  if (kind === 'tui') {
    if (!where.tui) throw new Error('no dsh-TUI package: set DSH_TUI_DIR');
    const tuiPkg = JSON.parse(readFileSync(join(where.tui, 'package.json'), 'utf8'));
    // dsh refuses a bundle whose peers stop below the running dsh unless the pair is exempted.
    writeFileSync(join(dir, 'compatibility.json'), JSON.stringify({ [`@deepseek-harness-tui/dsh-tui@${tuiPkg.version}`]: [where.version] }));
    mkdirSync(join(dir, 'node_modules/@deepseek-harness-tui'), { recursive: true });
    symlinkSync(where.tui, join(dir, 'node_modules/@deepseek-harness-tui/dsh-tui'));
    patch += `- ${JSON.stringify({ id: 'dsh-tui', config: { fullscreen: true, lang: 'en', terminalImages: false, ...tuiRow } })}\n`;
    mkdirSync(join(home, '.dsh-tui'), { recursive: true });
    const seed = { 'onboarding.json': { completed: true, version: 1 }, 'lang.json': { lang: 'en' }, 'home.json': { seen: true },
      'theme.json': { theme: 'dark' }, ...(mock ? { 'model.json': { provider: 'mock', model: (models ?? MOCK_MODELS)[0].id } } : {}), ...seedTui };
    for (const [file, value] of Object.entries(seed)) writeFileSync(join(home, '.dsh-tui', file), JSON.stringify(value));
  }
  writeFileSync(join(dir, 'cordis.patch.yml'), patch);
  const env = { ...process.env, HOME: home, DSH_HOME: dshHome, MOCK_KEY: 'mock', DSH_TELEMETRY_DISABLED: '1' };
  return {
    kind, root, home, dshHome, name, dir, work, env, bin: where.bin,
    /** Every dsh log line written so far (warnings about plugin load failures land here). */
    logs() {
      const logDir = join(dshHome, 'logs');
      try { return readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('\n'); } catch { return ''; }
    },
    readTui(file) { try { return JSON.parse(readFileSync(join(home, '.dsh-tui', file), 'utf8')); } catch { return undefined; } },
    /** The composed profile tree (`dsh --dump-config`): assert your row is present and configured. */
    dumpConfig() { return run(this, ['--profile', name, '--dump-config']); },
    dispose() {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      if (existsSync(root)) throw new Error(`rig: ${root} still exists; stop (and await) every dsh started on it before dispose()`);
    },
  };
}

function run(profile, args, { timeout = 120000 } = {}) {
  // Async on purpose: spawnSync would block this process's event loop, and an
  // in-process mock-llm server could never answer the model call.
  return new Promise((resolve) => {
    const child = spawn(profile.bin, args, { cwd: profile.work, env: profile.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, timeout);
    child.on('exit', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

/** One headless turn: `dsh --profile headless [--json] <prompt>`. */
export function runHeadless(profile, prompt, { json = false, timeout } = {}) {
  return run(profile, ['--profile', profile.name, ...(json ? ['--json'] : []), prompt], { timeout });
}

/** `dsh web` on a free loopback port in its own process group, signed in with its launch token. */
export async function startWeb(profile, { timeout = 90000, args = [] } = {}) {
  const child = spawn(profile.bin, ['--profile', profile.name, '--no-open', '--host', '127.0.0.1', '--port', '0', ...args],
    { cwd: profile.work, env: profile.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh web printed no URL:\n${output}`)), timeout);
    const onData = (d) => {
      output += d;
      const m = /(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(output);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`dsh web exited (${code}):\n${output}`)); });
  });
  const origin = new URL(url).origin;
  const first = await fetch(url, { redirect: 'manual' });
  const cookie = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    url, origin, cookie, pid: child.pid,
    output: () => output,
    /** fetch() against the server with the session cookie (plugin routes need it; 401 without). */
    fetch: (path, init = {}) => fetch(origin + path, { ...init, headers: { ...(init.headers ?? {}), cookie } }),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** dsh-TUI in a detached tmux session on a private tmux socket (Jake's own tmux is untouched). */
export function startTui(profile, { cols = 150, rows = 40, args = [] } = {}) {
  const socket = `dsh-rig-${process.pid}-${Date.now()}`;
  const tmux = (...a) => execFileSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' });
  // Vendored-copy delta: also forward DSH_INCOGNITO (dsh-incognito's boot mode).
	const envs = ['HOME', 'DSH_HOME', 'MOCK_KEY', 'DSH_TELEMETRY_DISABLED', 'DSH_INCOGNITO', 'PATH'].map((k) => `${k}=${JSON.stringify(profile.env[k] ?? '')}`);
  const cmd = [profile.bin, '--profile', profile.name, ...args].map((a) => JSON.stringify(a)).join(' ');
  tmux('new-session', '-d', '-s', 'rig', '-x', String(cols), '-y', String(rows), '-c', profile.work,
    `env ${envs.join(' ')} TERM=xterm-256color ${cmd}; echo "[[exited $?]]"; sleep 600`);
  const capture = () => tmux('capture-pane', '-p', '-t', 'rig');
  // The pane's shell leads its own process group; dsh runs inside it.
  const panePid = Number(tmux('display-message', '-p', '-t', 'rig', '#{pane_pid}').trim());
  return {
    socket, capture,
    /** tmux key names: 'Enter', 'Escape', 'M-BSpace' (Option+Backspace), 'C-w', 'BTab' (Shift+Tab), 'M-Left'. */
    keys: (...keys) => tmux('send-keys', '-t', 'rig', ...keys),
    /** Literal text, no key-name parsing. */
    text: (s) => tmux('send-keys', '-t', 'rig', '-l', s),
    /** Raw bytes, e.g. '\x1b\x7f' for a Meta-sending terminal's Option+Backspace. */
    raw: (s) => tmux('send-keys', '-t', 'rig', '-H', ...Buffer.from(s, 'utf8').toString('hex').match(/../g)),
    async waitFor(pattern, { timeout = 30000, not = false } = {}) {
      const deadline = Date.now() + timeout;
      let last = '';
      while (Date.now() < deadline) {
        last = capture();
        if (pattern.test(last) !== not) return last;
        await sleep(150);
      }
      throw new Error(`timed out waiting for ${not ? 'absence of ' : ''}${pattern}\n--- screen ---\n${last}`);
    },
    /**
     * Type a prompt and press Enter like a person: wait until the text is echoed,
     * pause, press Enter, and press it again if `until` does not hold within 4 s.
     * Text and Enter sent in one burst can be read as one chunk, and dsh-TUI 0.14.0's
     * Launchpad then drops the Enter (about half of runs without this).
     * until: RegExp on the screen, or () => boolean (e.g. () => mock.turns().length > n).
     */
    async submit(str, { until, attempts = 3 } = {}) {
      tmux('send-keys', '-t', 'rig', '-l', str);
      const tail = str.slice(-20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const echoDeadline = Date.now() + 10000;
      while (!new RegExp(tail).test(capture())) {
        if (Date.now() > echoDeadline) throw new Error(`submit: text never echoed\n--- screen ---\n${capture()}`);
        await sleep(100);
      }
      const before = capture();
      const done = typeof until === 'function' ? until
        : until instanceof RegExp ? () => until.test(capture()) : () => capture() !== before;
      for (let i = 0; i < attempts; i += 1) {
        await sleep(250);
        tmux('send-keys', '-t', 'rig', 'Enter');
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          if (done()) return i + 1;
          await sleep(100);
        }
      }
      throw new Error(`submit: Enter never took effect after ${attempts} tries\n--- screen ---\n${capture()}`);
    },
    /**
     * Stop the TUI and wait for its process group to exit. dsh-TUI writes
     * ~/.dsh-tui/last-run.json and resume.txt while it shuts down, which would
     * otherwise race profile.dispose() and leave the temp dir behind. Always await it.
     */
    async kill() {
      try { tmux('kill-server'); } catch { /* already gone */ }
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try { process.kill(-panePid, 0); } catch { return; }
        await sleep(100);
      }
      try { process.kill(-panePid, 'SIGKILL'); } catch { /* gone */ }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [cmd] = process.argv.slice(2);
  if (cmd === 'paths') console.log(JSON.stringify(paths(), null, 2));
  else { console.error('usage: node rig.mjs paths'); process.exit(2); }
}
