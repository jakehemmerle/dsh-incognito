import { describe, expect, it } from 'vitest';
import {
	SessionAlreadyExistsError,
	SessionAlreadyOwnedError,
	SessionHandleClosedError,
	SessionPersistenceNotFoundError,
	SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence';
import { ModeStore, parseIncognitoEnv } from '../src/mode.ts';
import { IncognitoSessionStore } from '../src/incognito-store.ts';
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';

/** SessionId is a branded string; tests use plain literals. */
const sid = (id: string): SessionId => id as SessionId;

function header(overrides: Partial<SessionHeader> = {}): SessionHeader {
	return {
		version: 4,
		id: overrides.id ?? 'sess-1',
		createdAt: 1_700_000_000_000,
		isSeeded: false,
		...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
	} as SessionHeader;
}

function event(seq: number, type = 'user/message') {
	return { seq, type, data: { n: seq } } as unknown as SessionEvent;
}

describe('parseIncognitoEnv', () => {
	it('parses truthy spellings case-insensitively once', () => {
		for (const value of ['1', 'true', 'YES', 'On', ' yes ']) {
			expect(parseIncognitoEnv(value)).toBe('incognito');
		}
	});
	it('defaults to persist for absence and other values', () => {
		for (const value of [undefined, '', '0', 'false', 'no', 'off', '2']) {
			expect(parseIncognitoEnv(value)).toBe('persist');
		}
	});
});

describe('ModeStore', () => {
	it('toggles between modes', () => {
		const store = new ModeStore('persist');
		expect(store.isIncognito()).toBe(false);
		expect(store.toggle()).toBe('incognito');
		expect(store.isIncognito()).toBe(true);
		expect(store.toggle()).toBe('persist');
	});
});

describe('IncognitoSessionStore', () => {
	it('create/open/read/append round-trips', async () => {
		const store = new IncognitoSessionStore();
		const handle = store.create({ header: header(), inheritedEventCount: SessionLogOffset(0), prefix: [] });
		await handle.append([event(0), event(1)]);
		const slice = await handle.read();
		expect(slice.eventState).toBe('detached');
		expect(slice.events).toHaveLength(2);
		// Caller-owned copies: mutating the read result must not touch the buffer.
		(slice.events as SessionEvent[])[0].seq = SessionSeq(99);
		expect((await handle.read(0, 1)).events.at(0)).toMatchObject({ seq: 0 });
	});

	it('read-your-writes through a second read handle', async () => {
		const store = new IncognitoSessionStore();
		const writer = store.create({ header: header(), inheritedEventCount: SessionLogOffset(0), prefix: [] });
		await writer.append([event(0)]);
		const reader = store.open(sid('sess-1'), 'read');
		await writer.append([event(1)]);
		expect((await reader.read()).events).toHaveLength(2);
	});

	it('rejects duplicate create and non-contiguous appends', async () => {
		const store = new IncognitoSessionStore();
		const first = store.create({ header: header(), inheritedEventCount: SessionLogOffset(0), prefix: [] });
		expect(() => store.create({ header: header(), inheritedEventCount: SessionLogOffset(0), prefix: [] })).toThrow(SessionAlreadyExistsError);
		await first.close();
		const writer = store.open(sid('sess-1'), 'write');
		expect(() => store.append(sid('sess-1'), [event(5)])).toThrow();
	});

	it('single-writer: second write-open rejects, double close is safe', async () => {
		const store = new IncognitoSessionStore();
		const first = store.create({ header: header(), inheritedEventCount: SessionLogOffset(0), prefix: [] });
		expect(() => store.open(sid('sess-1'), 'write')).toThrow(SessionAlreadyOwnedError);
		await first.close();
		const second = store.open(sid('sess-1'), 'write');
		await second.close();
		await second.close();
	});

	it('closed handles reject operations; read handles refuse append/flush', async () => {
		const store = new IncognitoSessionStore();
		const writer = store.create({ header: header(), inheritedEventCount: SessionLogOffset(0), prefix: [] });
		await writer.close();
		await expect(writer.append([event(0)])).rejects.toThrow(SessionHandleClosedError);
		await expect(writer.read()).rejects.toThrow(SessionHandleClosedError);
		const reader = store.open(sid('sess-1'), 'read');
		await expect(reader.append([event(0)])).rejects.toThrow(SessionReadOnlyError);
		await expect(reader.flush()).rejects.toThrow(SessionReadOnlyError);
	});

	it('stat/list match store contents; unknown ids absent', async () => {
		const store = new IncognitoSessionStore();
		const writer = store.create({ header: header({ id: sid('a') }), inheritedEventCount: SessionLogOffset(0), prefix: [] });
		store.create({ header: header({ id: sid('b') }), inheritedEventCount: SessionLogOffset(0), prefix: [] });
		await writer.append([event(0), event(1)]);
		expect(store.stat(sid('a'))).toMatchObject({ eventCount: 2 });
		expect(store.stat(sid('missing'))).toBeUndefined();
		expect(store.list().map((snapshot) => snapshot.header.id).sort()).toEqual(['a', 'b']);
		expect(store.list().every((snapshot) => snapshot.sizeBytes === undefined)).toBe(true);
	});

	it('flush after close resolves; flushAll resolves live handles', async () => {
		const store = new IncognitoSessionStore();
		const writer = store.create({ header: header(), inheritedEventCount: SessionLogOffset(0), prefix: [] });
		await writer.close();
		await expect(writer.flush()).rejects.toThrow(SessionHandleClosedError);
		store.create({ header: header({ id: sid('c') }), inheritedEventCount: SessionLogOffset(0), prefix: [] });
		await expect(store.flushAll()).resolves.toHaveLength(1);
	});

	it('open of unknown id throws SessionPersistenceNotFoundError', () => {
		const store = new IncognitoSessionStore();
		expect(() => store.open(sid('nope'), 'read')).toThrow(SessionPersistenceNotFoundError);
	});
});
