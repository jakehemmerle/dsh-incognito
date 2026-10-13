import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import { IncognitoSessionPersistence } from '../src/service.ts';
import { ModeStore } from '../src/mode.ts';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';

/**
 * P-07 restart-on-the-same-profile properties (SPEC section 2), oracle MEM + FS.
 * A "restart" here is a fresh IncognitoSessionPersistence service built on the
 * SAME sessions root — exactly the state a fresh process that reattaches the
 * plugin sees. The real-client restart arm drives the same transition through
 * a real dsh-TUI (test/tui-real.test.mjs P-07 arm).
 *
 * - Persist sessions resume normally through the facade: a NEW service on the
 *   same root stat/list-resolves the session, opens it for write and appends
 *   the pre-restart events contiguously (read-your-writes across restart).
 * - Incognito sessions are erased by restart BY CONSTRUCTION: they never
 *   materialized, so a fresh service does not stat/list them and a resume
 *   attempt throws SessionPersistenceNotFoundError.
 */

const sid = (id: string): SessionId => id as SessionId;

let runCounter = 0;

function makeFacade(mode: 'persist' | 'incognito', root: string = mkdtempSync(join(tmpdir(), 'dsh-incognito-restart-' + (++runCounter) + '-'))): { facade: IncognitoSessionPersistence; root: string } {
	const facade = new IncognitoSessionPersistence(
		new Context(),
		{ root, compression: 'none' },
		new ModeStore(mode),
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
	return walk(root).filter((path) => path.includes('/' + id + '/'));
}

describe('P-07 restart on the same profile (fresh service over the same root)', () => {
	it('persist sessions resume normally: stat/list show them and a fresh write handle continues the same contiguous log', async () => {
		const first = makeFacade('persist');
		const id = sid('restart-persist');
		const handle = await first.facade.create(headerFor(id));
		await handle.append(batchAt(0, 2));
		await handle.flush();
		const filesBefore = filesForId(first.root, id);
		expect(filesBefore.length).toBeGreaterThan(0);
		await handle.close();

		// Fresh process: new service on the SAME sessions root.
		const second = makeFacade('persist', first.root);
		const stat = await second.facade.stat(id);
		expect(stat?.sizeBytes).toBeGreaterThan(0);
		const listed = await second.facade.list();
		expect(listed.map((row) => row.header.id)).toContain(id);

		const resumed = await second.facade.open(id, 'write');
		await resumed.append(batchAt(2, 2));
		await resumed.flush();
		const read = await resumed.read();
		expect(read.events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
		await resumed.close();

		// The artifact survived and grew on disk across the restart.
		const filesAfter = filesForId(second.root, id);
		expect(filesAfter.length).toBeGreaterThan(0);
	});

	it('incognito sessions are erased by restart: zero files, absent from list/stat, resume throws NotFound', async () => {
		const first = makeFacade('incognito');
		const id = sid('restart-incognito');
		const handle = await first.facade.create(headerFor(id));
		await handle.append(batchAt(0, 2));
		await handle.flush();
		expect(filesForId(first.root, id)).toEqual([]);
		const live = await first.facade.stat(id);
		expect(live?.eventCount).toBe(2);
		await handle.close();

		// Fresh process on the same root: the in-memory id no longer exists.
		const second = makeFacade('persist', first.root);
		expect(await second.facade.stat(id)).toBeUndefined();
		expect((await second.facade.list()).map((row) => row.header.id)).not.toContain(id);
		await expect(second.facade.open(id, 'write')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError);
		expect(filesForId(second.root, id)).toEqual([]);
	});
});
