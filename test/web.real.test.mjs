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
// (P-06 web) with a fast-check burst sweep (NUM_RUNS, default 8).
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
	page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
	page.on('pageerror', (e) => consoleErrors.push(String(e)));
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
	return { mock, profile, web, browser, page, composer, consoleErrors };
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

/** TUI/web share the invariant-asserting helper shape; allowlisted noise only. */
function expectCleanConsole(consoleErrors) {
	const noise = consoleErrors.filter((t) => /Failed to load resource.*404/.test(t) && /favicon/.test(t) === false ? true : /favicon/.test(t));
	const real = consoleErrors.filter((t) => !t.includes('Failed to load resource'));
	expect(real).toEqual([]);
	expect(noise.length).toBe(consoleErrors.length);
}

describeReal('dsh-incognito on real dsh web (headless Chromium)', () => {
	it('P-01 web persist arm: a chatted session materializes server-side', { timeout: 180000 }, async () => {
		const { mock, profile, web, browser, page, composer, consoleErrors } = await makeWeb();
		try {
			await chatTurn(page, composer, mock, 0);
			const files = sessionFiles(profile.dshHome);
			expect(files.length).toBeGreaterThan(0);
			expect(files.some((f) => f.endsWith('.jsonl') || f.endsWith('.zstd'))).toBe(true);
			expectCleanConsole(consoleErrors);
		} finally {
			await browser.close();
			await web.stop();
			profile.dispose();
			await mock.close();
		}
	});

	it('P-02/P-03/P-04 web: /incognito from the composer wipes the current session server-side', { timeout: 240000 }, async () => {
		const { mock, profile, web, browser, page, composer, consoleErrors } = await makeWeb();
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
			expectCleanConsole(consoleErrors);
		} finally {
			await browser.close();
			await web.stop();
			profile.dispose();
			await mock.close();
		}
	});

	it('P-06 web boot incognito: DSH_INCOGNITO=1 means zero files across generated bursts', { timeout: 300000 }, async () => {
		const { mock, profile, web, browser, page, composer, consoleErrors } = await makeWeb({ incognitoEnv: true });
		try {
			const bursts = fc.nat({ max: 3 });
			await fc.assert(
				fc.asyncProperty(bursts, async (n) => {
					let turns = mock.turns().length;
					for (let i = 0; i < n; i += 1) {
						await chatTurn(page, composer, mock, turns);
						turns = mock.turns().length;
						expect(sessionFiles(profile.dshHome)).toEqual([]);
					}
				}),
				{ numRuns: Number(process.env.NUM_RUNS ?? 8) },
			);
			expectCleanConsole(consoleErrors);
		} finally {
			await browser.close();
			await web.stop();
			profile.dispose();
			await mock.close();
		}
	});
});
