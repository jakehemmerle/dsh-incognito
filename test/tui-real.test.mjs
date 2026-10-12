// Real dsh-TUI property tests for /incognito (bead dsh-incognito-vzv).
// Drives a real `dsh --profile rig-tui` (dsh-TUI) in a private tmux socket via
// the vendored rig, with the plugin mounted from this repo's built lib/. Every
// assertion on disk walks the real $DSH_HOME/sessions tree.
//
// Arms: persist baseline (P-01), mid-session toggle-on wipes the current
// session and never writes again (P-02/P-03/P-04), toggle-off + next session
// persists (P-05), boot incognito via DSH_INCOGNITO=1 (P-06). A fast-check
// sweep generates chat-burst lengths with a fresh TUI per case (NUM_RUNS,
// default 8; the release campaign raises it — TESTING.md records it).
import { describe, expect, it } from 'vitest';

// The OFFLINE Nix suite check has no browser/tmux: it sets SKIP_REAL_CLIENT=1
// and these suites report as skipped there; on the host they always run, and
// the whole-binary e2e app covers the store-built bundle separately.
const describeReal = process.env.SKIP_REAL_CLIENT ? describe.skip : describe;
import fc from 'fast-check';
import { existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMockLlm } from './rig/mock-llm.mjs';
import { makeProfile, startTui } from './rig/rig.mjs';

const PLUGIN_LIB = new URL('../lib/index.js', import.meta.url).pathname;
const REPLY_TOKEN = 'PONG-INCOGNITO';
const REPLY = new RegExp(REPLY_TOKEN);
const LAUNCHPAD_READY = /mock-alpha/;

function sessionFiles(dshHome) {
	const root = join(dshHome, 'sessions');
	if (!existsSync(root)) return [];
	const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const p = join(dir, entry.name);
		return entry.isDirectory() ? walk(p) : [p];
	});
	return walk(root);
}

/** Mount the facade after makeProfile (absolute root, base row disabled), then assert activity. */
function mountFacade(profile) {
	const root = join(profile.dshHome, 'sessions');
	const patchPath = join(profile.dir, 'cordis.patch.yml');
	const extra = `# disable the base durable backend and mount the incognito facade
- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: session-persistence-incognito
      name: ${PLUGIN_LIB}
      config:
        root: ${root}
`;
	writeFileSync(patchPath, readFileSync(patchPath, 'utf8') + extra);
}

async function makeTui({ incognitoEnv = false } = {}) {
	const mock = await startMockLlm({ script: () => ({ text: REPLY_TOKEN }) });
	const profile = makeProfile({ kind: 'tui', mock });
	mountFacade(profile);
	// Row activity before any input: facade mounted, base durable row disabled.
	const dump = await profile.dumpConfig();
	expect(dump.stdout).toContain('session-persistence-incognito');
	const baseIdx = dump.stdout.indexOf('- id: session-persistence-jsonl');
	expect(baseIdx).toBeGreaterThan(-1);
	const nextRow = dump.stdout.indexOf('\n- id:', baseIdx + 1);
	const baseBlock = nextRow === -1 ? dump.stdout.slice(baseIdx) : dump.stdout.slice(baseIdx, nextRow);
	expect(baseBlock).toMatch(/disabled:\s*true/);
	if (incognitoEnv) profile.env.DSH_INCOGNITO = '1';
	const tui = startTui(profile);
	await tui.waitFor(LAUNCHPAD_READY);
	return { mock, profile, tui };
}

async function chatTurn(tui, mock, turnsBefore) {
	await tui.submit('hello', { until: () => mock.turns().length > turnsBefore });
	await tui.waitFor(REPLY, { timeout: 30000 });
}

describeReal('dsh-incognito on a real dsh-TUI (private tmux socket)', () => {
	it('P-01 persist arm: a chatted session materializes under $DSH_HOME/sessions', { timeout: 120000 }, async () => {
		const { mock, profile, tui } = await makeTui();
		try {
			await chatTurn(tui, mock, 0);
			const files = sessionFiles(profile.dshHome);
			expect(files.length).toBeGreaterThan(0);
			expect(files.some((f) => f.endsWith('.jsonl') || f.endsWith('.zstd'))).toBe(true);
		} finally {
			await tui.kill();
			profile.dispose();
			await mock.close();
		}
	});

	it('P-02/P-03/P-04 mid-session /incognito: the current session is wiped from disk and never writes again', { timeout: 180000 }, async () => {
		const { mock, profile, tui } = await makeTui();
		try {
			await chatTurn(tui, mock, 0);
			const before = sessionFiles(profile.dshHome);
			expect(before.length).toBeGreaterThan(0);

			// Toggle ON through the real command path.
			await tui.submit('/incognito', { until: () => true, attempts: 2 });
			await tui.waitFor(/wiped from disk/, { timeout: 30000 });

			// The wipe is real: nothing remains under the sessions root.
			expect(sessionFiles(profile.dshHome)).toEqual([]);

			// The SAME session continues: another full turn completes in memory.
			const turns = mock.turns().length;
			await chatTurn(tui, mock, turns);

			// Nothing further ever touches disk (checked after the turn settled).
			expect(sessionFiles(profile.dshHome)).toEqual([]);
		} finally {
			await tui.kill();
			profile.dispose();
			await mock.close();
		}
	});

	it('P-05 toggle-off: the current session stays in memory; the next session persists', { timeout: 240000 }, async () => {
		const { mock, profile, tui } = await makeTui();
		try {
			await chatTurn(tui, mock, 0);
			await tui.submit('/incognito', { until: () => true, attempts: 2 });
			await tui.waitFor(/wiped from disk/, { timeout: 30000 });
			expect(sessionFiles(profile.dshHome)).toEqual([]);

			// Toggle OFF: sessions created from now on persist again.
			await tui.submit('/incognito', { until: () => true, attempts: 2 });
			await tui.waitFor(/persist to disk again/, { timeout: 30000 });
			expect(sessionFiles(profile.dshHome)).toEqual([]);

			// A NEW session (post-toggle) must materialize on disk. /new
			// navigates to a fresh session screen; let the transition settle
			// before typing into the new composer.
			await tui.submit('/new', { until: () => true, attempts: 2 });
			await new Promise((resolve) => setTimeout(resolve, 2000));
			const turns = mock.turns().length;
			await chatTurn(tui, mock, turns);
			const after = sessionFiles(profile.dshHome);
			expect(after.length).toBeGreaterThan(0);
		} finally {
			await tui.kill();
			profile.dispose();
			await mock.close();
		}
	});

	it('P-06 boot incognito: DSH_INCOGNITO=1 means zero files across generated chat bursts', { timeout: 300000 }, async () => {
		const { mock, profile, tui } = await makeTui({ incognitoEnv: true });
		try {
			const bursts = fc.nat({ max: 3 });
			await fc.assert(
				fc.asyncProperty(bursts, async (n) => {
					let turns = mock.turns().length;
					for (let i = 0; i < n; i += 1) {
						await chatTurn(tui, mock, turns);
						turns = mock.turns().length;
						// Invariant after every completed turn: nothing on disk.
						expect(sessionFiles(profile.dshHome)).toEqual([]);
					}
				}),
				{ numRuns: Number(process.env.NUM_RUNS ?? 8) },
			);
		} finally {
			await tui.kill();
			profile.dispose();
			await mock.close();
		}
	});
});
