#!/usr/bin/env node
/**
 * SMOKE: gates everything else in the harness. Boots the real `dsh` binary and
 * asserts the plugin is ACTIVELY mounted, then proves both disk behaviors.
 * Model: the vendored local mock (test/rig/mock-llm.mjs) — no network, no
 * credentials, no real provider calls (bead dsh-incognito-jbm deleted the
 * live-credential path and the model-less boot that made exit codes meaningless;
 * no user credential store is read anywhere in this harness).
 *
 * Checks:
 *   1. Row activity (dump-config): the composed profile shows
 *      session-persistence-incognito mounted (file:// entry) and the base
 *      session-persistence-jsonl row disabled.
 *   2. Persist arm: with the plugin mounted and DSH_INCOGNITO unset, session
 *      files materialize under $DSH_HOME/sessions/ and the run reaches the mock.
 *   3. Incognito arm: DSH_INCOGNITO=1 writes nothing under sessions/.
 *
 * Negative control: SMOKE_NEGATIVE_CONTROL=1 scaffolds the venv WITHOUT the
 * plugin rows and REQUIRES the row-activity assertion to fail — proving the
 * check bites when the plugin is unmounted. Exit 0 iff the control trips.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockLlm } from '../test/rig/mock-llm.mjs';

const repo = new URL('..', import.meta.url).pathname;
const PLUGIN_LIB = join(repo, 'lib/index.js');
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
	const home = mkdtempSync(join(tmpdir(), 'dsh-incognito-smoke-'));
	const profile = join(home, 'profiles', 'verify');
	mkdirSync(profile, { recursive: true });
	writeFileSync(join(profile, 'cordis.yml'), '[]\n');
	writeFileSync(join(profile, 'package.json'), JSON.stringify({
		name: 'dsh-profile-verify',
		private: true,
		dependencies: {},
		dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
	}, null, 2));
	const pluginRows = plugin ? `- id: session-persistence-jsonl
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

function dsh(args, home, extraEnv = {}) {
	return new Promise((resolve) => {
		const env = { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'mock-local-only-key', ...extraEnv };
		const child = spawn('dsh', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** @returns {{ active: boolean, pluginRowMounted: boolean, baseRowDisabled: boolean, detail: string }} */
export function assertPluginRowActive(dump) {
	const pluginRowMounted = dump.includes('- id: session-persistence-incognito');
	const rowIdx = dump.indexOf('- id: session-persistence-jsonl');
	let baseRowDisabled = false;
	if (rowIdx !== -1) {
		const rest = dump.slice(rowIdx);
		const nextRow = rest.indexOf('\n- id:');
		const block = nextRow === -1 ? rest : rest.slice(0, nextRow);
		baseRowDisabled = /disabled:\s*true/.test(block);
	}
	const active = pluginRowMounted && baseRowDisabled;
	const detail = `pluginRowMounted=${pluginRowMounted} baseRowDisabled=${baseRowDisabled}`;
	if (!active) {
		const error = new Error(`plugin row not active in composed config (${detail})`);
		error.pluginRowMounted = pluginRowMounted;
		error.baseRowDisabled = baseRowDisabled;
		throw error;
	}
	return { active, pluginRowMounted, baseRowDisabled, detail };
}

async function bootTurn(mock, home, incognito) {
	const turnsBefore = mock.turns().length;
	const run = await dsh(['--profile', 'verify', 'Reply with exactly: ok'], home, incognito ? { DSH_INCOGNITO: '1' } : {});
	const sawModelTurn = mock.turns().length > turnsBefore;
	return { ...run, sawModelTurn };
}

async function main() {
	const mock = await startMockLlm({ script: () => ({ text: 'ok' }) });
	try {
		if (process.env.SMOKE_NEGATIVE_CONTROL === '1') {
			// The plugin is unmounted: the row-activity assertion MUST fail.
			const home = scaffoldVenv(mock, { plugin: false });
			const dump = await dsh(['--profile', 'verify', '--dump-config'], home);
			let tripped = false;
			try {
				assertPluginRowActive(dump.out);
			} catch {
				tripped = true;
			}
			rmSync(home, { recursive: true, force: true });
			console.log(tripped ? 'NEGATIVE CONTROL TRIPPED (unmounted plugin correctly rejected)' : 'NEGATIVE CONTROL FAILED (assertion passed without the plugin!)');
			if (!tripped) process.exitCode = 1;
			return;
		}

		// 1. Row activity via dump-config (mount + base disabled).
		const dumpHome = scaffoldVenv(mock, { plugin: true });
		const dump = await dsh(['--profile', 'verify', '--dump-config'], dumpHome);
		rmSync(dumpHome, { recursive: true, force: true });
		let activity;
		try {
			activity = assertPluginRowActive(dump.out);
			console.log(`row activity: ${activity.detail}`);
		} catch (error) {
			console.log(`row activity: ${error.message}`);
			console.log('dump tail:', dump.out.slice(-800));
			process.exitCode = 1;
			return;
		}

		// 2. Persist arm: files materialize, run completes through the mock.
		const persistHome = scaffoldVenv(mock, { plugin: true });
		const persistRun = await bootTurn(mock, persistHome, false);
		const persistFiles = listFilesRecursive(join(persistHome, 'sessions'));
		console.log(`persist arm: exit=${persistRun.code} modelTurn=${persistRun.sawModelTurn} files=${persistFiles.length}`);
		for (const f of persistFiles) console.log(`  ${f.replace(persistHome, '$DSH_HOME')}`);
		rmSync(persistHome, { recursive: true, force: true });

		// 3. Incognito arm: zero files.
		const incogHome = scaffoldVenv(mock, { plugin: true });
		const incogRun = await bootTurn(mock, incogHome, true);
		const incogFiles = listFilesRecursive(join(incogHome, 'sessions'));
		console.log(`incognito arm: exit=${incogRun.code} modelTurn=${incogRun.sawModelTurn} files=${incogFiles.length}`);
		for (const f of incogFiles) console.log(`  ${f.replace(incogHome, '$DSH_HOME')}`);
		rmSync(incogHome, { recursive: true, force: true });

		const persistOk = persistRun.code === 0 && persistRun.sawModelTurn && persistFiles.length > 0;
		const incogOk = incogRun.code === 0 && incogRun.sawModelTurn && incogFiles.length === 0;
		const pass = activity.active && persistOk && incogOk;
		console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL');
		if (!pass) {
			if (!persistOk) console.log('persist stdout tail:', persistRun.out.slice(-400), 'stderr:', persistRun.err.slice(-400));
			if (!incogOk) console.log('incognito stdout tail:', incogRun.out.slice(-400), 'stderr:', incogRun.err.slice(-400));
			process.exitCode = 1;
		}
	} finally {
		await mock.close();
	}
}

await main();
