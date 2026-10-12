import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { IncognitoSessionPersistence } from '../src/service.ts';
import { ModeStore } from '../src/mode.ts';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';

/**
 * Red for bead dsh-incognito-dql: when the wipe fails mid-conversion, the
 * session must stay DURABLE and USABLE — the invariant the write order
 * (read -> close -> wipe -> buffer) currently breaks, because the durable
 * handle is closed before the wipe and never restored on failure. After a
 * failed toggle the caller must find: the on-disk log intact, appends
 * working, and the session still owned by the durable backend. The mode
 * stays incognito (session-scoped invariant; mode rollback is a separate
 * product decision, noted in SPEC P-04).
 */

const sid = (id: string): SessionId => id as SessionId;

function makeFacade(): { facade: IncognitoSessionPersistence; root: string } {
	const root = mkdtempSync(join(tmpdir(), 'dsh-incognito-wipefail-'));
	const facade = new IncognitoSessionPersistence(
		new Context(),
		{ root, compression: 'none' },
		new ModeStore('persist'),
		{ info() {}, warn() {} },
	);
	facade.attachInner();
	return { facade, root };
}

function headerFor(id: SessionId): SessionHeader {
	return { version: 4, id, createdAt: 1_700_000_000_000, isSeeded: false };
}

function batchAt(startSeq: number, size: number): SessionEvent[] {
	return Array.from({ length: size }, (_, i) => {
		const seq = startSeq + i;
		const turn = Math.floor(seq / 2) + 1;
		return (seq % 2 === 0
			? { seq, time: 1_700_000_000_000 + seq, type: 'turn/start', data: { turn } }
			: { seq, time: 1_700_000_000_000 + seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }) as unknown as SessionEvent;
	});
}

function filesForId(root: string, id: string): string[] {
	if (!existsSync(root)) return [];
	const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
	return walk(root).filter((path) => path.includes(`/${id}/`));
}

describe('wipe failure keeps the session durable and usable (dql)', () => {
	it('R: a failed wipe rethrows but leaves the session durable, owned, and appendable', { timeout: 60000 }, async () => {
		const { facade, root } = makeFacade();
		const id = sid(`wipefail-${Date.now()}`);
		const handle = await facade.create(headerFor(id));
		await handle.append(batchAt(0, 2));
		await handle.flush();
		expect(filesForId(root, id).length).toBeGreaterThan(0);

		// Make the wipe fail: the session directory is removed with rmSync,
		// which needs write permission on its PARENT (the per-project directory
		// under the root) to unlink the session directory itself.
		const before = filesForId(root, id);
		const projectDir = dirname(before[0]!);
		chmodSync(projectDir, 0o555);
		try {
			await expect(facade.toggle(id)).rejects.toThrow();
		} finally {
			chmodSync(projectDir, 0o755);
		}

		// The failed conversion must not have pretended success: the store does
		// not own the id (the session is still durable), the on-disk artifact
		// survives, and appends keep working through the same handle.
		expect(facade.store.owns(id)).toBe(false);
		expect(filesForId(root, id).length).toBeGreaterThan(0);
		await handle.append(batchAt(2, 2));
		await handle.flush();
		const read = await handle.read();
		expect(read.events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
		await handle.close();
		// Durable artifact still on disk after close (flush materializes it).
		expect(filesForId(root, id).length).toBeGreaterThan(0);
	});
});
