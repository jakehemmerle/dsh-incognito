import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { IncognitoSessionPersistence } from '../src/service.ts';
import { ModeStore } from '../src/mode.ts';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';

/**
 * Toggle-lifecycle properties over the REAL facade with the REAL
 * JsonlSessionPersistence backend on a per-run temp root. Every fs assertion
 * walks the actual artifact tree — no mocks anywhere.
 */

const sid = (id: string): SessionId => id as SessionId;

let runCounter = 0;

function makeFacade(initial: 'persist' | 'incognito' = 'persist'): { facade: IncognitoSessionPersistence; root: string } {
	const root = mkdtempSync(join(tmpdir(), `dsh-incognito-prop-${++runCounter}-`));
	const facade = new IncognitoSessionPersistence(
		new Context(),
		{ root, compression: 'none' },
		new ModeStore(initial),
		{ info() {}, warn() {} },
	);
	facade.attachInner();
	return { facade, root };
}

function headerFor(id: SessionId): SessionHeader {
	return { version: 4, id, createdAt: 1_700_000_000_000, isSeeded: false };
}

/**
 * Valid V4 lifecycle events as a pure function of seq: even seqs open turn
 * `seq/2 + 1`, odd seqs close it. Any contiguous run of these events is a
 * well-formed log the durable backend will re-read without complaint.
 */
function eventFor(seq: number): SessionEvent {
	const turn = Math.floor(seq / 2) + 1;
	const event = seq % 2 === 0
		? { seq, time: 1_700_000_000_000 + seq, type: 'turn/start', data: { turn } }
		: { seq, time: 1_700_000_000_000 + seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } };
	return event as unknown as SessionEvent;
}

function batchAt(startSeq: number, size: number): SessionEvent[] {
	return Array.from({ length: size }, (_, i) => eventFor(startSeq + i));
}

/** Every file currently on disk under `root` that belongs to session `id`. */
function filesForId(root: string, id: string): string[] {
	if (!existsSync(root)) return [];
	const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
	return walk(root).filter((path) => path.includes(`/${id}/`));
}

const batchGen = fc.nat({ max: 5 }).map((size) => size);
const phaseGen = fc.array(batchGen, { maxLength: 6 });

describe('toggle lifecycle properties (real facade, real JSONL backend)', () => {
	it('P1: no file for the session exists under the root at ANY point after toggle-on', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.tuple(phaseGen, fc.nat({ max: 6 }), phaseGen),
				async ([pre, toggleIndex, post]) => {
					const { facade, root } = makeFacade();
					const id = `p1-${runCounter}`;
					const handle = await facade.create(headerFor(sid(id)));
					let seq = 0;

					const runBatch = async (size: number) => {
						if (size > 0) await handle.append(batchAt(seq, size));
						seq += size;
						await handle.flush();
					};

					for (const [index, size] of pre.entries()) {
						await runBatch(size);
						if (index === toggleIndex) await facade.toggle();
						// Invariant from the first post-toggle moment onward.
						if (facade.modeStore.isIncognito()) expect(filesForId(root, id)).toEqual([]);
					}
					if (toggleIndex >= pre.length) await facade.toggle();
					for (const size of post) {
						await runBatch(size);
						expect(filesForId(root, id)).toEqual([]);
					}
					await handle.close();
					expect(filesForId(root, id)).toEqual([]);
				},
			),
			{ numRuns: 30 },
		);
	});

	it('P2: read-your-writes across conversion — pre- and post-toggle events all visible, contiguous', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.tuple(phaseGen, phaseGen),
				async ([pre, post]) => {
					const { facade } = makeFacade();
					const id = `p2-${runCounter}`;
					const handle = await facade.create(headerFor(sid(id)));
					let seq = 0;
					for (const size of pre) {
						if (size > 0) await handle.append(batchAt(seq, size));
						seq += size;
					}
					await handle.flush();
					const preCount = seq;

					const { outcome } = await facade.toggle();
					if (pre.length > 0) expect(outcome).toBe('converted');

					for (const size of post) {
						if (size > 0) await handle.append(batchAt(seq, size));
						seq += size;
						await handle.flush();
					}
					const slice = await handle.read();
					expect(slice.eventState).toBe('detached');
					expect(slice.events.map((event) => event.seq)).toEqual(Array.from({ length: seq }, (_, i) => i));
					expect(slice.events.length).toBe(preCount + post.reduce((a, b) => a + b, 0));
					await handle.close();
					// The store keeps the full converted log.
					expect(facade.store.stat(sid(id))?.eventCount).toBe(seq);
				},
			),
			{ numRuns: 30 },
		);
	});

	it('P3: the wipe is real — the pre-toggle on-disk artifact is deleted from the root', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.tuple(fc.nat({ max: 5 }), fc.nat({ max: 5 })),
				async ([preTurns, postTurns]) => {
					const { facade, root } = makeFacade();
					const id = `p3-${runCounter}`;
					const handle = await facade.create(headerFor(sid(id)));
					let seq = 0;
					for (let t = 0; t < preTurns; t += 1) {
						await handle.append(batchAt(seq, 2));
						seq += 2;
					}
					await handle.flush();
					expect(filesForId(root, id).length).toBeGreaterThan(0);
					const diskStat = await facade.stat(sid(id));
					expect(diskStat?.header.id).toBe(sid(id));

					await facade.toggle();

					// The session directory is gone from the root entirely.
					expect(filesForId(root, id)).toEqual([]);
					expect(existsSync(join(root, '_no-cwd', id))).toBe(false);
					// stat/list now resolve through the in-memory store.
					const memoryStat = await facade.stat(sid(id));
					expect(memoryStat?.eventCount).toBe(seq);

					for (let t = 0; t < postTurns; t += 1) {
						await handle.append(batchAt(seq, 2));
						seq += 2;
						await handle.flush();
						expect(filesForId(root, id)).toEqual([]);
					}
					await handle.close();
				},
			),
			{ numRuns: 30 },
		);
	});

	it('P4: after toggle-off the NEXT persist-mode session materializes on disk; incognito ones never do', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.tuple(fc.nat({ max: 5 }), fc.nat({ max: 5 })),
				async ([persistTurns, incognitoTurns]) => {
					const { facade, root } = makeFacade();
					const convertedId = `p4-conv-${runCounter}`;
					const converted = await facade.create(headerFor(sid(convertedId)));
					await converted.append(batchAt(0, 2));
					await converted.flush();
					await facade.toggle();
					await converted.append(batchAt(2, 2));
					await converted.flush();
					expect(filesForId(root, convertedId)).toEqual([]);

					// Toggle OFF: only sessions created from now on persist.
					await facade.toggle();
					const nextId = `p4-next-${runCounter}`;
					const next = await facade.create(headerFor(sid(nextId)));
					let seq = 0;
					for (let t = 0; t < persistTurns; t += 1) {
						await next.append(batchAt(seq, 2));
						seq += 2;
						await next.flush();
						// A fresh persist session materializes and keeps growing.
						expect(filesForId(root, nextId).length).toBeGreaterThan(0);
					}
					if (persistTurns > 0) {
						const onDisk = filesForId(root, nextId).find((path) => path.endsWith('.jsonl'));
						expect(onDisk).toBeDefined();
						expect(statSync(onDisk!).size).toBeGreaterThan(0);
					}
					await next.close();

					// Back ON: a new session must not touch disk.
					await facade.toggle();
					const offId = `p4-off-${runCounter}`;
					const off = await facade.create(headerFor(sid(offId)));
					let offSeq = 0;
					for (let t = 0; t < incognitoTurns; t += 1) {
						await off.append(batchAt(offSeq, 2));
						offSeq += 2;
						await off.flush();
						expect(filesForId(root, offId)).toEqual([]);
					}
					await off.close();
				},
			),
			{ numRuns: 30 },
		);
	});

	it('P5: two-session interleaving keeps routing disjoint — persist grows on disk, converted never does', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.tuple(fc.constantFrom('persist', 'converted'), fc.nat({ max: 5 })), { maxLength: 12 }),
				async (plan) => {
					const { facade, root } = makeFacade();
					const persistId = `p5-persist-${runCounter}`;
					const convertedId = `p5-conv-${runCounter}`;

					const persist = await facade.create(headerFor(sid(persistId)));
					let persistSeq = 0;
					await persist.append(batchAt(persistSeq, 2));
					persistSeq += 2;
					await persist.flush();

					const converted = await facade.create(headerFor(sid(convertedId)));
					let convertedSeq = 0;
					await converted.append(batchAt(convertedSeq, 2));
					convertedSeq += 2;
					await converted.flush();
					// The converted session was created most recently, so toggle() targets it.
					const { outcome } = await facade.toggle();
					expect(outcome).toBe('converted');
					expect(filesForId(root, convertedId)).toEqual([]);
					const persistFilesBefore = filesForId(root, persistId);

					for (const [target, turns] of plan) {
						const handle = target === 'persist' ? persist : converted;
						for (let t = 0; t < turns; t += 1) {
							if (target === 'persist') {
								await handle.append(batchAt(persistSeq, 2));
								persistSeq += 2;
							} else {
								await handle.append(batchAt(convertedSeq, 2));
								convertedSeq += 2;
							}
							await handle.flush();
						}
						expect(filesForId(root, convertedId)).toEqual([]);
						const persistFilesNow = filesForId(root, persistId);
						if (target === 'persist' && turns > 0) {
							expect(persistFilesNow.length).toBeGreaterThanOrEqual(persistFilesBefore.length);
						}
					}

					// Final disjoint state: persist artifact present with all its events,
					// converted session fully in memory.
					const persistStat = await facade.stat(sid(persistId));
					const convertedStat = await facade.stat(sid(convertedId));
					// Durable snapshots carry sizeBytes; in-memory ones carry eventCount.
					expect(persistStat).toBeDefined();
					expect(persistStat?.sizeBytes).toBeGreaterThan(0);
					expect(convertedStat?.eventCount).toBe(convertedSeq);
					expect((await persist.read()).events.map((event) => event.seq))
						.toEqual(Array.from({ length: persistSeq }, (_, i) => i));
					expect(filesForId(root, convertedId)).toEqual([]);
					await persist.close();
					await converted.close();
				},
			),
			{ numRuns: 30 },
		);
	});
});
