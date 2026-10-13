// Real dsh-TUI property tests for /incognito (bead dsh-incognito-vzv).
// Drives a real `dsh --profile rig-tui` (dsh-TUI) in a private tmux socket via
// the vendored rig, with the plugin mounted from this repo's built lib/. Every
// assertion on disk walks the real $DSH_HOME/sessions tree.
//
// Arms: persist baseline (P-01), mid-session toggle-on wipes the current
// session and never writes again (P-02/P-03/P-04), toggle-off + next session
// persists (P-05), boot incognito via DSH_INCOGNITO=1 (P-06), restart on the
// same profile (P-07: a persist session resumes via /resume → the Sessions
// supervisor; an incognito-converted session is listed nowhere). A fast-check
// sweep generates chat-burst bursts with a fresh client, mock and profile per
// generated case (NUM_RUNS, default 8; the release campaign raises it with
// FC_SEED/NUM_RUNS — TESTING.md records the seeds).
import { describe, expect, it } from 'vitest';

// The OFFLINE Nix suite check has no browser/tmux: it sets SKIP_REAL_CLIENT=1
// and these suites report as skipped there; on the host they always run, and
// the whole-binary e2e app covers the store-built bundle separately.
const describeReal = process.env.SKIP_REAL_CLIENT ? describe.skip : describe;
import fc from 'fast-check';
import { existsSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
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

/** Poll the pane capture until a string or regex appears (no key retries — a
 * second Enter in a stateful screen would open the wrong thing). */
async function screenSettle(tui, needle, ms = 30000) {
	const deadline = Date.now() + ms;
	for (;;) {
		const capture = tui.capture();
		const hit = typeof needle === 'string' ? capture.includes(needle) : needle.test(capture);
		if (hit) return capture;
		if (Date.now() > deadline) throw new Error('screen never settled on ' + JSON.stringify(needle) + '\n--- screen ---\n' + capture);
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
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

async function chatTurn(tui, mock, turnsBefore, text = 'hello') {
	await tui.submit(text, { until: () => mock.turns().length > turnsBefore });
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

	/** Boot-mode sweep options: release campaigns set NUM_RUNS + FC_SEED (+ FC_PATH for replay). */
	function sweepOptions(defaultRuns) {
		const numRuns = Number(process.env.NUM_RUNS ?? defaultRuns);
		const seed = process.env.FC_SEED === undefined ? undefined : Number(process.env.FC_SEED);
		const path = process.env.FC_PATH;
		console.log('[sweep] surface=tui seed=' + (seed ?? 'fresh-per-run') + ' numRuns=' + numRuns + (path ? ' path=' + path : ''));
		return { numRuns, seed, path };
	}

	const sessionIdOf = (file) => file.split('/').slice(-2)[0];

	// Resume the persisted session through /resume -> the Sessions supervisor.
	// Pace like a person: type, wait for the command popup, ONE Enter per intent
	// (a burst drop or a second Enter would open other rows — both were caught
	// by repeat runs of this arm during the ROUND C audit). Leg fixtures keep
	// exactly ONE persisted session, so the rows are ["+ New session", legacy]
	// and a single Down selects it.
	async function resumeSavedSession(client, needle) {
		await client.text('/resume');
		await screenSettle(client, 'Continue a saved session'); // popup drawn
		await new Promise((resolve) => setTimeout(resolve, 300));
		await client.keys('Enter');
		await screenSettle(client, 'This terminal hosts'); // supervisor opened; its list rides the plugin
		await client.keys('Right'); // focus the sessions pane
		await screenSettle(client, 'Ctrl+N new');
		await client.keys('Down'); // select the saved session row (the first row is "+ New session")
		await new Promise((resolve) => setTimeout(resolve, 400));
		await client.keys('Enter'); // open the selected row
		await screenSettle(client, needle); // the transcript is restored
	}

	// Each generated case gets its OWN client, mock and profile (per-case fixture
	// isolation per testing.md), so a failure replays exactly via seed + path.
	it('P-06 boot incognito: DSH_INCOGNITO=1 means zero files across generated chat bursts (fresh client per case)', { timeout: 3600000 }, async () => {
		await fc.assert(
			fc.asyncProperty(fc.nat({ max: 3 }), async (n) => {
				const arm = await makeTui({ incognitoEnv: true });
				try {
					let turns = arm.mock.turns().length;
					for (let i = 0; i < n; i += 1) {
						await chatTurn(arm.tui, arm.mock, turns);
						turns = arm.mock.turns().length;
						// Invariant after every completed turn: nothing on disk.
						expect(sessionFiles(arm.profile.dshHome)).toEqual([]);
					}
					expect(sessionFiles(arm.profile.dshHome)).toEqual([]);
				} finally {
					await arm.tui.kill();
					arm.profile.dispose();
					await arm.mock.close();
				}
			}),
			sweepOptions(8),
		);
	});

	it('P-07 restart leg A: the persisted session survives the process and resumes through /resume', { timeout: 420000 }, async () => {
		const { mock, profile, tui } = await makeTui();
		try {
			await chatTurn(tui, mock, 0);
			const before = sessionFiles(profile.dshHome);
			expect(before.length).toBeGreaterThan(0);
			const legacyId = sessionIdOf(before[0]);
			expect(before.some((f) => sessionIdOf(f) !== legacyId)).toBe(false); // exactly one session id

			await tui.kill();
			expect(sessionFiles(profile.dshHome)).toEqual(before); // the artifact survives a graceful kill

			const tui2 = startTui(profile);
			await tui2.waitFor(LAUNCHPAD_READY, { timeout: 60000 });
			await resumeSavedSession(tui2, 'hello'); // the pre-restart message is restored by the facade

			// Resuming parks the fresh boot session (a second id appears); the
			// resumed session keeps ITS id — no fork replaced it, no new id duplicates it.
			const afterResume = sessionFiles(profile.dshHome);
			const ids = new Set(afterResume.map((f) => sessionIdOf(f)));
			expect(ids.has(legacyId)).toBe(true);

			// The SAME session continues: appends land in the facaded id, not a fork.
			const turns = mock.turns().length;
			await chatTurn(tui2, mock, turns, 'hello again');
			expect(sessionFiles(profile.dshHome).some((f) => sessionIdOf(f) === legacyId)).toBe(true);
			await tui2.kill();
		} finally {
			await tui.kill().catch(() => {});
			profile.dispose();
			await mock.close();
		}
	});

	it('P-07 restart leg B: an incognito-converted session is gone forever after a process restart', { timeout: 300000 }, async () => {
		const { mock, profile, tui } = await makeTui();
		try {
			await chatTurn(tui, mock, 0);
			const before = sessionFiles(profile.dshHome);
			expect(before.length).toBeGreaterThan(0);
			const legacyId = sessionIdOf(before[0]);

			// Convert mid-session: the current session is wiped and never touches
			// disk again for the rest of its life.
			await tui.submit('/incognito', { until: () => true, attempts: 2 });
			await tui.waitFor(/wiped from disk/, { timeout: 30000 });
			const turns = mock.turns().length;
			await chatTurn(tui, mock, turns);
			expect(sessionFiles(profile.dshHome).some((f) => sessionIdOf(f) === legacyId)).toBe(false);
			await tui.kill();

			// Boot #2: nothing was ever materialized for this session, so the
			// facade-backed supervisor lists zero sessions and the tree stays empty.
			const tui2 = startTui(profile);
			await tui2.waitFor(LAUNCHPAD_READY, { timeout: 60000 });
			expect(sessionFiles(profile.dshHome).some((f) => sessionIdOf(f) === legacyId)).toBe(false);
			await tui2.text('/resume');
			await screenSettle(tui2, 'Continue a saved session');
			await new Promise((resolve) => setTimeout(resolve, 300));
			await tui2.keys('Enter');
			await screenSettle(tui2, 'This terminal hosts');
			await screenSettle(tui2, /0 total/); // the plugin-backed list has zero sessions
			expect(new RegExp('\\d+(\\.\\d+)? KB · mock-alpha').test(tui2.capture())).toBe(false); // no row ever materializes for it
			await tui2.kill();
		} finally {
			await tui.kill().catch(() => {});
			profile.dispose();
			await mock.close();
		}
	});
});
