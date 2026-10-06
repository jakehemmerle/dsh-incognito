import {
	SessionAlreadyExistsError,
	SessionAlreadyOwnedError,
	SessionHandleClosedError,
	SessionPersistenceNotFoundError,
	SessionPersistenceRevision,
	assertContiguous,
	materializeAppendBatch,
	materializeCreateHeader,
	validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence';
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence';
import type { SessionAccess } from '@deepseek-ai/dsh-session-persistence';
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import { IncognitoSessionHandle } from './incognito-handle.ts';

interface IncognitoSessionState {
	header: SessionHeader;
	events: SessionEvent[];
	nextSeq: number;
	ownerHandle: IncognitoSessionHandle | null;
	revision: SessionPersistenceRevision;
	inheritedEventCount: SessionLogOffset;
}

export interface CreateSessionRequest {
	header: SessionHeader;
	inheritedEventCount: SessionLogOffset;
	/** Preload the exact fork-inherited prefix (seeded creates). */
	prefix: readonly SessionEvent[];
}

/**
 * Process-local in-memory sessions. Single-writer ownership per id; appends
 * validate through the shipped storage-contract validators, so incognito
 * sessions refuse the same inputs the durable backend refuses. Snapshot
 * revisions are opaque store-local tokens.
 */
export class IncognitoSessionStore {
	private readonly sessions = new Map<SessionId, IncognitoSessionState>();
	private counter = 0;

	/** Whether this store owns the session id (a live entry exists). */
	owns(id: SessionId): boolean {
		return this.sessions.has(id);
	}

	ownerOf(id: SessionId): IncognitoSessionHandle | null {
		return this.sessions.get(id)?.ownerHandle ?? null;
	}

	/**
	 * Create a session and take its write ownership. The caller (facade)
	 * resolves the inherited prefix for seeded creates.
	 * @throws {SessionAlreadyExistsError} when the id is already in this store.
	 */
	create(request: CreateSessionRequest): IncognitoSessionHandle {
		const meta = materializeCreateHeader(request.header);
		if (this.sessions.has(meta.id)) throw new SessionAlreadyExistsError(meta.id);
		const prefix = [...request.prefix];
		validateStoredEvents(meta, prefix);
		const state: IncognitoSessionState = {
			header: meta,
			events: prefix,
			nextSeq: prefix.length,
			ownerHandle: null,
			revision: SessionPersistenceRevision(`memory:incognito:${++this.counter}`),
			inheritedEventCount: request.inheritedEventCount,
		};
		this.sessions.set(meta.id, state);
		const handle = new IncognitoSessionHandle(this, meta.id, meta, request.inheritedEventCount, 'write');
		state.ownerHandle = handle;
		return handle;
	}

	/**
	 * Open an existing session. `read` never takes ownership and works while a
	 * write handle is live; `write` claims single-writer ownership.
	 * @throws {SessionPersistenceNotFoundError} when the store lacks the id.
	 * @throws {SessionAlreadyOwnedError} for `write` when ownership is taken.
	 */
	open(id: SessionId, access: SessionAccess): IncognitoSessionHandle {
		const state = this.sessions.get(id);
		if (state === undefined) throw new SessionPersistenceNotFoundError(id);
		if (access === 'write') {
			if (state.ownerHandle !== null && state.ownerHandle.isOwner()) {
				throw new SessionAlreadyOwnedError(id);
			}
			const handle = new IncognitoSessionHandle(this, id, state.header, state.inheritedEventCount, 'write');
			state.ownerHandle = handle;
			return handle;
		}
		return new IncognitoSessionHandle(this, id, state.header, state.inheritedEventCount, 'read');
	}

	/** Release write ownership held by `handle` for `id`; store-internal. */
	release(id: SessionId, handle: IncognitoSessionHandle): void {
		const state = this.sessions.get(id);
		if (state !== undefined && state.ownerHandle === handle) state.ownerHandle = null;
	}

	/**
	 * Validate and append a contiguous batch to the owned buffer. Appends to a
	 * session whose write handle was closed or replaced reject loudly.
	 */
	append(id: SessionId, events: readonly SessionEvent[]): void {
		const state = this.sessions.get(id);
		if (state === undefined) throw new SessionPersistenceNotFoundError(id);
		if (state.ownerHandle === null) throw new SessionHandleClosedError(id, "append");
		const batch = materializeAppendBatch(events);
		assertContiguous(id, batch, state.nextSeq);
		for (const event of batch) {
			state.events.push(event);
			state.nextSeq = event.seq + 1;
		}
		state.revision = SessionPersistenceRevision(`memory:incognito:${++this.counter}`);
	}

	/** Deep-copied contiguous slice of the stored log, bounds-clamped. */
	readSlice(id: SessionId, offset?: number, length?: number): SessionEvent[] {
		const state = this.sessions.get(id);
		if (state === undefined) throw new SessionPersistenceNotFoundError(id);
		const start = Math.max(0, offset ?? 0);
		if (start >= state.events.length) return [];
		const end = length === undefined ? state.events.length : Math.min(state.events.length, start + Math.max(0, length));
		return state.events.slice(start, end);
	}

	/** Store-local snapshot, or `undefined` when the id is unknown. */
	stat(id: SessionId): SessionPersistenceSnapshot | undefined {
		const state = this.sessions.get(id);
		if (state === undefined) return undefined;
		return {
			header: structuredClone(state.header),
			revision: state.revision,
			eventCount: state.events.length,
		};
	}

	/** Snapshots for every session this store owns. */
	list(): SessionPersistenceSnapshot[] {
		return [...this.sessions.values()].map((state) => ({
			header: structuredClone(state.header),
			revision: state.revision,
			eventCount: state.events.length,
		}));
	}

	/**
	 * Resolve the flush of every live write handle. In-memory buffers have
	 * nothing to drain; the promise chain just mirrors the handle contract.
	 */
	flushAll(): Promise<void[]> {
		return Promise.all(
			[...this.sessions.values()]
				.map((state) => state.ownerHandle)
				.filter((handle): handle is IncognitoSessionHandle => handle !== null && handle.isOwner())
				.map((handle) => handle.flush()),
		);
	}
}
