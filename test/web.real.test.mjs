// Real dsh-web property tests for /incognito (bead dsh-incognito-bac).
// Drives the real `dsh web` server (vendored rig startWeb) with headless
// Chromium (Nix google-chrome via executablePath) through the REAL web UI:
// dismiss the preview notice, choose the workspace, chat in the composer, and
// dispatch /incognito from the composer's command menu. Assertions walk the
// real $DSH_HOME/sessions tree (server-side persistence).
//
// Arms: persist baseline (P-01 web), mid-session toggle-on wipes and never
// writes again (P-02/P-03/P-04 web — the composer CAN dispatch the plugin
// command, so there is no web N/A), boot incognito via DSH_INCOGNITO=1
// (P-06 web) with a fast-check burst sweep: one fresh server, mock, profile and
// browser per generated case (NUM_RUNS, default 8; the release campaign raises
// it with FC_SEED/NUM_RUNS — TESTING.md records the seeds).
import { describe, expect, it } from 'vitest';

// The OFFLINE Nix suite check has no browser/tmux: it sets SKIP_REAL_CLIENT=1
// and these suites report as skipped there; on the host they always run, and
// the whole-binary e2e app covers the store-built bundle separately.
const describeReal = process.env.SKIP_REAL_CLIENT ? describe.skip : describe;
import fc from 'fast-check';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startMockLlm } from './rig/mock-llm.mjs';
import { makeProfile, startWeb } from './rig/rig.mjs';

const PLUGIN_LIB = new URL('../lib/index.js', import.meta.url).pathname;
const REPLY_TOKEN = 'PONG-INCOGNITO';
const CHROME = process.env.CHROMIUM_PATH ?? '/run/current-system/sw/bin/google-chrome';

function sessionFiles(dshHome) {
	const root = join(dshHome, 'sessions');
	if (!existsSync(root)) return [];
	const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const p = join(dir, entry.name);
		return entry.isDirectory() ? walk(p) : [p];
	});
	return walk(root);
}

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

async function makeWeb({ incognitoEnv = false } = {}) {
	const mock = await startMockLlm({ script: () => ({ text: REPLY_TOKEN }) });
	const profile = makeProfile({ kind: 'web', mock });
	mountFacade(profile);
	if (incognitoEnv) profile.env.DSH_INCOGNITO = '1';
	const dump = await profile.dumpConfig();
	expect(dump.stdout).toContain('session-persistence-incognito');
	const baseIdx = dump.stdout.indexOf('- id: session-persistence-jsonl');
	const nextRow = dump.stdout.indexOf('\n- id:', baseIdx + 1);
	const baseBlock = nextRow === -1 ? dump.stdout.slice(baseIdx) : dump.stdout.slice(baseIdx, nextRow);
	expect(baseBlock).toMatch(/disabled:\s*true/);
	const web = await startWeb(profile);
	const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	const consoleErrors = [];
	const resourceFailures = [];
	page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
	page.on('pageerror', (e) => consoleErrors.push(String(e)));
	// Chromium console text omits the URL; record failing responses explicitly
	// so the allowlist can be exact about WHICH resource was not found.
	page.on('response', (resp) => { if (resp.status() >= 400) resourceFailures.push(resp.status() + ' ' + resp.url()); });
	await page.goto(web.url, { waitUntil: 'networkidle', timeout: 90000 });
	// Dismiss the preview notice (mounts asynchronously — wait for it, click a
	// dismiss label, wait for it to be gone), then choose the Home workspace.
	const overlay = page.locator('div[class*=_root_]').filter({ hasText: 'still in preview' }).first();
	await overlay.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (!(await overlay.isVisible().catch(() => false))) break;
		for (const label of ['Continue', 'Got it', 'OK', 'Close']) {
			const btn = overlay.locator('button', { hasText: label }).first();
			if (await btn.count()) { await btn.click().catch(() => {}); break; }
		}
		await overlay.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
	}
	await page.waitForTimeout(500);
	await page.getByText('Choose workspace').first().click();
	await page.waitForTimeout(800);
	await page.locator('button, [role=button]').filter({ hasText: /^Home$/ }).first().click();
	await page.waitForTimeout(800);
	await page.locator('button, [role=button]').filter({ hasText: /^Open$/ }).first().click();
	await page.waitForTimeout(2000);
	const composer = page.locator('[aria-label*="commands"]').first();
	await composer.waitFor({ state: 'visible', timeout: 30000 });
	return { mock, profile, web, browser, page, composer, consoleErrors, resourceFailures };
}

async function chatTurn(page, composer, mock, turnsBefore) {
	await composer.click();
	await page.keyboard.type('hello');
	await page.keyboard.press('Enter');
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (mock.turns().length > turnsBefore && (await page.locator('body').innerText()).includes(REPLY_TOKEN)) return;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error('chat turn never completed on web');
}

/** ONLY understood noise is allowlisted; everything else — any other 4xx/5xx
 * resource load, console.error or uncaught page error — fails the arm. The old
 * predicate allowed ANY non-favicon "Failed to load resource" error through
 * by mistake (ROUND C closure audit); tightening it exposed the one real
 * recurring 404: dsh web's own /open-in-app/icon route (UI core, not this
 * plugin) responds 404 on 0.2.1-alpha.2 every session — the broad 404 filter
 * had been covering it unknowingly. */
const KNOWN_NOISE = [
	/\/favicon\.ico(?:\?|$)/, // missing favicon: cosmetic, host-level
	/\/open-in-app\/icon\//, // dsh-web core app-icon route 404s on 0.2.1-alpha.2
];
function expectCleanConsole(consoleErrors, resourceFailures = []) {
	// "Failed to load resource ..." console texts carry no URL; the paired
	// resourceFailures entries do, and they carry the allowlist verdict.
	const unexplainedResources = resourceFailures.filter((t) => !KNOWN_NOISE.some((noise) => noise.test(t)));
	expect(unexplainedResources).toEqual([]);
	const unexplainedConsole = consoleErrors.filter((t) => !/^Failed to load resource/.test(t));
	expect(unexplainedConsole).toEqual([]);
}

describeReal('dsh-incognito on real dsh web (headless Chromium)', () => {
	it('P-01 web persist arm: a chatted session materializes server-side', { timeout: 180000 }, async () => {
		const { mock, profile, web, browser, page, composer, consoleErrors, resourceFailures } = await makeWeb();
		try {
			await chatTurn(page, composer, mock, 0);
			const files = sessionFiles(profile.dshHome);
			expect(files.length).toBeGreaterThan(0);
			expect(files.some((f) => f.endsWith('.jsonl') || f.endsWith('.zstd'))).toBe(true);
			expectCleanConsole(consoleErrors, resourceFailures);
		} finally {
			await browser.close();
			await web.stop();
			profile.dispose();
			await mock.close();
		}
	});

	it('P-02/P-03/P-04 web: /incognito from the composer wipes the current session server-side', { timeout: 240000 }, async () => {
		const { mock, profile, web, browser, page, composer, consoleErrors, resourceFailures } = await makeWeb();
		try {
			await chatTurn(page, composer, mock, 0);
			expect(sessionFiles(profile.dshHome).length).toBeGreaterThan(0);

			// Toggle ON through the REAL web command menu.
			await composer.click();
			await page.keyboard.type('/incognito');
			await page.waitForTimeout(1200);
			await page.keyboard.press('Enter');
			await page.waitForTimeout(2000);
			const body = await page.locator('body').innerText();
			expect(body).toMatch(/wiped from disk|continues in memory/i);

			// Wipe is real; nothing remains under the sessions root.
			expect(sessionFiles(profile.dshHome)).toEqual([]);

			// The SAME session continues in memory; another turn completes.
			const turns = mock.turns().length;
			await chatTurn(page, composer, mock, turns);
			expect(sessionFiles(profile.dshHome)).toEqual([]);
			expectCleanConsole(consoleErrors, resourceFailures);
		} finally {
			await browser.close();
			await web.stop();
			profile.dispose();
			await mock.close();
		}
	});

	/** Boot-mode sweep options: release campaigns set NUM_RUNS + FC_SEED (+ FC_PATH for replay). */
	function sweepOptions(defaultRuns) {
		const numRuns = Number(process.env.NUM_RUNS ?? defaultRuns);
		const seed = process.env.FC_SEED === undefined ? undefined : Number(process.env.FC_SEED);
		const path = process.env.FC_PATH;
		console.log(`[sweep] surface=web seed=${seed ?? 'fresh-per-run'} numRuns=${numRuns}${path ? ' path=' + path : ''}`);
		return { numRuns, seed, path };
	}

	// Each generated case gets its OWN server, mock, profile and browser (per-case
	// fixture isolation per testing.md); a failure replays via seed + path.
	it('P-06 web boot incognito: DSH_INCOGNITO=1 means zero files across generated bursts (fresh server per case)', { timeout: 3600000 }, async () => {
		await fc.assert(
			fc.asyncProperty(fc.nat({ max: 3 }), async (n) => {
				const arm = await makeWeb({ incognitoEnv: true });
				const { mock, profile, web, browser, page, composer, consoleErrors, resourceFailures } = arm;
				try {
					let turns = mock.turns().length;
					for (let i = 0; i < n; i += 1) {
						await chatTurn(page, composer, mock, turns);
						turns = mock.turns().length;
						expect(sessionFiles(profile.dshHome)).toEqual([]);
					}
					expect(sessionFiles(profile.dshHome)).toEqual([]);
					expectCleanConsole(consoleErrors, resourceFailures);
				} finally {
					await browser.close();
					await web.stop();
					profile.dispose();
					await mock.close();
				}
			}),
			sweepOptions(8),
		);
	});
});
