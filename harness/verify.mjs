#!/usr/bin/env node
/**
 * Whole-binary verification for dsh-incognito against the real `dsh` binary.
 *
 * Arms (N fresh venvs each):
 *   baseline          — stock headless profile; expect session files on disk.
 *   plugin-persist    — plugin mounted, DSH_INCOGNITO unset; expect session files.
 *   plugin-incognito  — plugin mounted, DSH_INCOGNITO=1; expect zero session files.
 *
 * Plus a mode-flip sweep alternating DSH_INCOGNITO set/unset across fresh
 * venvs to catch state leaking across runs.
 *
 * Prints a PASS/FAIL table and exits 0 only when every expectation holds.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const PLUGIN_LIB = join(REPO, 'lib/index.js');
// Model rows shared by every arm: route the run through the user's local
// ProviderProxy catalog (secret copied from the real home's credential store)
// so the boot reaches a real model reply regardless of the arm under test.
const MODEL_ROWS = `- id: llm-pi-ai
  config:
    providers:
      providerproxy:
        displayName: ProviderProxy
        apiKeyEnv: PROVIDERPROXY_API_KEY
        api: openai-responses
        baseURL: http://gpu.tail47033e.ts.net:4000/v1
        models:
          - id: claude-haiku-4-5-20251001
            name: Claude Haiku 4.5
            contextWindow: 200000
            maxTokens: 64000
            input:
              - text
            reasoningEfforts:
              low: low
              medium: medium
              high: high
- id: agent-default-model
  config:
    provider: providerproxy
    model: claude-haiku-4-5-20251001
`;

const RUNS_PER_ARM = Number(process.env.VERIFY_RUNS ?? 3);
const TIMEOUT_MS = 120_000;

function listFilesRecursive(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? listFilesRecursive(path) : [path];
	});
}

function scaffoldVenv(plugin) {
	const home = mkdtempSync(join(tmpdir(), 'dsh-incognito-verify-'));
	const profile = join(home, 'profiles', 'verify');
	mkdirSync(profile, { recursive: true });
	writeFileSync(join(profile, 'cordis.yml'), '[]\n');
	writeFileSync(join(profile, 'package.json'), JSON.stringify({
		name: 'dsh-profile-verify',
		private: true,
		dependencies: {},
		dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
	}, null, 2));
	// Credentials: copy the user's provider secret into the venv (read-only
	// source) so the model call can authenticate; never touches ~/.dsh itself.
	copyFileSync(join(homedir(), '.dsh', '.credentials.yaml'), join(home, '.credentials.yaml'));
	const pluginRows = plugin ? `# disable the base durable backend and mount the incognito facade
- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: session-persistence-incognito
      name: ${PLUGIN_LIB}
      config:
        root: !!js dshHomePath('sessions')
` : '';
	writeFileSync(join(profile, 'cordis.patch.yml'), plugin ? MODEL_ROWS + pluginRows : MODEL_ROWS);
	return home;
}

function boot(home, incognito) {
	return new Promise((resolve) => {
		const env = { ...process.env, DSH_HOME: home };
		if (incognito) env.DSH_INCOGNITO = '1';
		else delete env.DSH_INCOGNITO;
		const child = spawn('dsh', ['--profile', 'verify', 'Reply with exactly: ok'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
		child.stdout.on('data', (d) => { out += d; });
		child.stderr.on('data', (d) => { err += d; });
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, out, err });
		});
	});
}

async function runArm(name, { plugin, incognito }) {
	const runs = [];
	for (let i = 0; i < RUNS_PER_ARM; i += 1) {
		const home = scaffoldVenv(plugin);
		const run = await boot(home, incognito);
		const files = listFilesRecursive(join(home, 'sessions'));
		runs.push({ home, code: run.code, files, err: run.err });
		rmSync(home, { recursive: true, force: true });
	}
	const allClean = runs.every((r) => r.code === 0);
	for (const r of runs) {
		console.log(`  [${name}] run: exit=${r.code} session tree (${r.files.length} files):`);
		for (const f of r.files) console.log(`    ${f.replace(r.home, '$DSH_HOME')}`);
		if (r.files.length === 0) console.log('    (empty — sessions/ never created)');
	}
	return { name, runs, allClean };
}

function expectation(arm) {
	switch (arm.name) {
		case 'baseline':
		case 'plugin-persist':
			return arm.runs.every((r) => r.files.length > 0);
		case 'plugin-incognito':
		case 'flip-incognito':
			return arm.runs.every((r) => r.files.length === 0);
		case 'flip-persist':
			return arm.runs.every((r) => r.files.length > 0);
		default:
			return false;
	}
}

const FLIP_RUNS = Number(process.env.VERIFY_FLIP_RUNS ?? 3);

async function main() {
	const baseline = await runArm('baseline', { plugin: false, incognito: false });
	const persist = await runArm('plugin-persist', { plugin: true, incognito: false });
	const incognito = await runArm('plugin-incognito', { plugin: true, incognito: true });
	const flip = [];
	for (let i = 0; i < FLIP_RUNS; i += 1) {
		const mode = i % 2 === 0;
		const arm = await runArm(mode ? 'flip-incognito' : 'flip-persist', { plugin: true, incognito: mode });
		flip.push(arm);
	}

	const rows = [
		{ name: 'baseline (stock profile, no plugin)', pass: expectation(baseline), detail: `${baseline.runs[0]?.files.length ?? 0}+ session files per run` },
		{ name: 'plugin-persist (DSH_INCOGNITO unset)', pass: expectation(persist), detail: 'session files present, plugin delegates to durable backend' },
		{ name: 'plugin-incognito (DSH_INCOGNITO=1)', pass: expectation(incognito), detail: 'zero files under sessions/ per run' },
		...flip.map((arm) => ({
			name: `flip sweep: ${arm.name} run`,
			pass: expectation(arm),
			detail: `${arm.runs[0]?.files.length ?? 0} files (fresh venv, alternating mode)`,
		})),
	];

	const cleanRows = [baseline, persist, incognito, ...flip].every((arm) => arm.runs.every((r) => r.code === 0));

	console.log('== dsh-incognito whole-binary verification ==');
	for (const row of rows) {
		console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${row.name.padEnd(46)} ${row.detail}`);
	}
	console.log(`     (${RUNS_PER_ARM} fresh venvs per arm; ${FLIP_RUNS} flip-sweep runs)`);
	console.log(`runs exited cleanly: ${cleanRows ? 'yes' : 'NO (see stderr excerpts below)'}`);
	for (const result of [baseline, persist, incognito, ...flip]) {
		for (const r of result.runs) {
			if (r.code !== 0) console.log(`[${result.name}] exit=${r.code} stderr: ${r.err.slice(-500)}`);
		}
	}
	const allPass = rows.every((row) => row.pass);
	console.log(allPass ? 'VERIFY PASS' : 'VERIFY FAIL');
	if (!allPass) process.exitCode = 1;
}

await main();
