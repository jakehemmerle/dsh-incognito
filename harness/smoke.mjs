#!/usr/bin/env node
/**
 * SMOKE TEST: boot the real dsh binary with the plugin mounted in persist
 * mode and assert session files materialize under $DSH_HOME/sessions/.
 * Gates everything else in the harness.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = new URL('..', import.meta.url).pathname;
const PLUGIN_LIB = join(repo, 'lib/index.js');

function listFilesRecursive(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? listFilesRecursive(path) : [path];
	});
}

function scaffoldVenv() {
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
	return { home, profile };
}

function patchYaml({ plugin }) {
	if (!plugin) return '[]\n';
	return `# disable the base durable backend and mount the incognito facade
- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: session-persistence-incognito
      name: ${PLUGIN_LIB}
      config:
        root: !!js dshHomePath('sessions')
`;
}

function boot(home, env) {
	return new Promise((resolve) => {
		const child = spawn('dsh', ['headless', 'Reply with exactly: ok'], {
			env: { ...process.env, DSH_HOME: home, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		let err = '';
		const timer = setTimeout(() => { child.kill('SIGKILL'); }, 120_000);
		child.stdout.on('data', (d) => { out += d; });
		child.stderr.on('data', (d) => { err += d; });
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, out, err });
		});
	});
}

async function main() {
	const results = [];
	for (const arm of ['persist', 'incognito']) {
		const { home, profile } = scaffoldVenv();
		writeFileSync(join(profile, 'cordis.patch.yml'), patchYaml({ plugin: true }));
		const run = await boot(home, arm === 'incognito' ? { DSH_INCOGNITO: '1' } : {});
		const sessionFiles = listFilesRecursive(join(home, 'sessions'));
		const clean = run.code === 0;
		results.push({ arm, code: run.code, files: sessionFiles, home, out: run.out, err: run.err, clean });
		console.log(`arm=${arm} exit=${run.code} sessionFiles=${sessionFiles.length}`);
		for (const f of sessionFiles) console.log(`  ${f.replace(home, '$DSH_HOME')}`);
		if (!clean) {
			console.log(`stdout: ${run.out.slice(-2000)}`);
			console.log(`stderr: ${run.err.slice(-2000)}`);
		}
	}
	const [persist, incognito] = results;
	const pass = persist.files.length > 0 && incognito.files.length === 0 && persist.clean && incognito.clean;
	console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL');
	if (!pass) process.exitCode = 1;
	for (const r of results) rmSync(r.home, { recursive: true, force: true });
}

await main();
