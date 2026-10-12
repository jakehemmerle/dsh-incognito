#!/usr/bin/env node
/**
 * Whole-binary verification for dsh-incognito against the real `dsh` binary,
 * with the vendored mock model (test/rig/mock-llm.mjs): no network, no
 * credentials, no cost.
 *
 * History (bead dsh-incognito-jbm): this harness used to copy the user's real
 * credential store into each venv and call the real hosted provider — a
 * live-cred, live-quota violation of the mock-model-only rule. It now points the
 * llm-pi-ai row at the local mock (api: openai-completions) and asserts each
 * run completes a real model round-trip through it.
 *
 * Arms (N fresh venvs each):
 *   baseline          — stock headless profile; expect session files on disk.
 *   plugin-persist    — plugin mounted, DSH_INCOGNITO unset; expect session files.
 *   plugin-incognito  — plugin mounted, DSH_INCOGNITO=1; expect zero session files.
 *
 * Plus a mode-flip sweep alternating DSH_INCOGNITO set/unset across fresh
 * venvs to catch state leaking across runs. Prints a PASS/FAIL table and
 * exits 0 only when every expectation holds.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockLlm } from '../test/rig/mock-llm.mjs';

const REPO = new URL('..', import.meta.url).pathname;
const PLUGIN_LIB = join(REPO, 'lib/index.js');

const RUNS_PER_ARM = Number(process.env.VERIFY_RUNS ?? 3);
const TIMEOUT_MS = 120_000;

function listFilesRecursive(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? listFilesRecursive(path) : [path];
	});
}

function modelRows(mock) {
	return `- id: llm-pi-ai
  config:
    providers:
      mock:
        displayName: Mock LLM
        apiKeyEnv: MOCK_API_KEY
        api: openai-completions
        baseURL: ${mock.baseURL}
        models:
          - id: mock-alpha
            name: Mock Alpha
            contextWindow: 200000
            maxTokens: 64000
            input:
              - text
- id: agent-default-model
  config:
    provider: mock
    model: mock-alpha
`;
}

function scaffoldVenv(mock, { plugin }) {
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
	const pluginRows = plugin ? `# disable the base durable backend and mount the incognito facade
- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: session-persistence-incognito
      name: ${PLUGIN_LIB}
      config:
        root: !!js dshHomePath('sessions')
` : '';
	writeFileSync(join(profile, 'cordis.patch.yml'), modelRows(mock) + pluginRows);
	return home;
}

function boot(home, incognito) {
	return new Promise((resolve) => {
		const env = { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'mock-local-only-key' };
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

async function runArm(name, { mock, plugin, incognito }) {
	const runs = [];
	for (let i = 0; i < RUNS_PER_ARM; i += 1) {
		const turnsBefore = mock.turns().length;
		const home = scaffoldVenv(mock, { plugin });
		const run = await boot(home, incognito);
		const sawModelTurn = mock.turns().length > turnsBefore;
		const files = listFilesRecursive(join(home, 'sessions'));
		runs.push({ home, code: run.code, files, err: run.err, out: run.out, sawModelTurn });
		rmSync(home, { recursive: true, force: true });
	}
	const allClean = runs.every((r) => r.code === 0);
	for (const r of runs) {
		console.log(`  [${name}] run: exit=${r.code} modelTurn=${r.sawModelTurn} session tree (${r.files.length} files):`);
		for (const f of r.files) console.log(`    ${f.replace(r.home, '$DSH_HOME')}`);
		if (r.files.length === 0) console.log('    (empty — sessions/ never created)');
		if (r.code !== 0) console.log(`    stderr tail: ${r.err.slice(-300).replace(/\n/g, ' | ')}`);
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
	const mock = await startMockLlm({ script: () => ({ text: 'ok' }) });
	let baseline; let persist; let incognito; let flip = [];
	try {
		baseline = await runArm('baseline', { mock, plugin: false, incognito: false });
		persist = await runArm('plugin-persist', { mock, plugin: true, incognito: false });
		incognito = await runArm('plugin-incognito', { mock, plugin: true, incognito: true });
		for (let i = 0; i < FLIP_RUNS; i += 1) {
			const mode = i % 2 === 0;
			const arm = await runArm(mode ? 'flip-incognito' : 'flip-persist', { mock, plugin: true, incognito: mode });
			flip.push(arm);
		}
	} finally {
		await mock.close();
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
	const modelTurns = [baseline, persist, incognito, ...flip].every((arm) => arm.runs.every((r) => r.sawModelTurn));

	console.log('== dsh-incognito whole-binary verification (mock model, no live creds) ==');
	for (const row of rows) {
		console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${row.name.padEnd(46)} ${row.detail}`);
	}
	console.log(`     (${RUNS_PER_ARM} fresh venvs per arm; ${FLIP_RUNS} flip-sweep runs)`);
	console.log(`runs exited cleanly: ${cleanRows ? 'yes' : 'NO'}`);
	console.log(`every run reached the mock model: ${modelTurns ? 'yes' : 'NO'}`);
	const allPass = rows.every((row) => row.pass) && cleanRows && modelTurns;
	console.log(allPass ? 'VERIFY PASS' : 'VERIFY FAIL');
	if (!allPass) process.exitCode = 1;
}

await main();
