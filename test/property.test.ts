import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { IncognitoSessionStore } from '../src/incognito-store.ts';
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';

/** SessionId is a branded string; tests use plain literals. */
const sid = (id: string): SessionId => id as SessionId;
import type { IncognitoSessionHandle } from '../src/incognito-handle.ts';

interface TestEvent {
	seq: number;
	type: string;
	data: { n: number };
}

function header(id: SessionId): SessionHeader {
	return { version: 4, id, createdAt: 1_700_000_000_000, isSeeded: false };
}

function event(seq: number): SessionEvent {
	return { seq, type: 'user/message', data: { n: seq } } as unknown as SessionEvent;
}

const smallNat = fc.nat({ max: 20 });

describe('IncognitoSessionStore properties', () => {
	it('appends stay contiguous and read-your-writes holds under arbitrary batch schedules', () => {
		fc.assert(
			fc.asyncProperty(
				fc.array(fc.tuple(fc.constant(0), fc.nat({ max: 5 })), { maxLength: 40 }),
				fc.tuple(smallNat, smallNat),
				async (batches, [offset, length]) => {
					const store = new IncognitoSessionStore();
					const writer = store.create({ header: header(sid('p')), inheritedEventCount: SessionLogOffset(0), prefix: [] });
					let seq = 0;
					for (const [, size] of batches) {
						const batch = Array.from({ length: size }, () => event(seq++));
						writer.append(batch);
						// Read-your-writes: every append is immediately visible.
						expect(store.readSlice(sid('p')).length).toBe(seq);
						// Contiguity: seqs are 0..n-1 in order.
						const events = store.readSlice(sid('p'));
						expect(events.map((e) => e.seq)).toEqual(Array.from({ length: seq }, (_, i) => i));
					}
					const slice = await writer.read(offset, length);
					expect(slice.events.length).toBe(Math.min(length, Math.max(0, seq - offset)));
					writer.close();
					expect(store.stat(sid('p'))?.eventCount).toBe(seq);
				},
			),
			{ numRuns: Number(process.env.NUM_RUNS ?? 100) },
		);
	});

	it('stat/list stay consistent with the store after any interleaving', () => {
		fc.assert(
			fc.property(fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c'), smallNat)), (plan) => {
				const store = new IncognitoSessionStore();
				const writers = new Map<string, IncognitoSessionHandle>();
				const expected = new Map<string, number>();
				for (const [id, size] of plan) {
					if (!writers.has(id)) {
						const created = store.create({ header: header(id as SessionId), inheritedEventCount: SessionLogOffset(0), prefix: [] });
						writers.set(id, created);
						expected.set(id, 0);
					}
					const writer = writers.get(id)!;
					const existing = store.stat(id as SessionId)?.eventCount ?? 0;
					writer.append(Array.from({ length: size }, (_, i) => event(existing + i)));
					expected.set(id, existing + size);
					expect(store.stat(id as SessionId)?.eventCount).toBe(expected.get(id));
				}
				expect(store.list().length).toBe(expected.size);
				for (const snapshot of store.list()) {
					expect(snapshot.eventCount).toBe(expected.get(snapshot.header.id));
				}
			}),
			{ numRuns: Number(process.env.NUM_RUNS ?? 100) },
		);
	});
});
