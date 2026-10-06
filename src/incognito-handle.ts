import {
	SessionHandleClosedError,
	SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence';
import type { SessionAccess, SessionHandle, SessionHandleAppendOptions, SessionHandleFlushOptions, SessionHandleReadOptions, SessionHandleReadResult } from '@deepseek-ai/dsh-session-persistence';
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import type { IncognitoSessionStore } from './incognito-store.ts';

/**
 * Full in-memory `SessionHandle` over the incognito buffer — not a discard
 * handle: checkpoint and projection consumers read live handles, so an
 * empty-read discard handle would corrupt derived state. `read()` returns
 * caller-owned deep copies with `eventState: 'detached'`; `flush()` resolves
 * without writing (vacuous durability barrier); `close()` is idempotent and
 * releases single-writer ownership in the store.
 */
export class IncognitoSessionHandle implements SessionHandle {
	readonly id: SessionId;
	readonly header: SessionHeader;
	readonly inheritedEventCount: SessionLogOffset;
	readonly access: SessionAccess;

	private readonly store: IncognitoSessionStore;
	private closed = false;

	constructor(
		store: IncognitoSessionStore,
		id: SessionId,
		header: SessionHeader,
		inheritedEventCount: SessionLogOffset,
		access: SessionAccess,
	) {
		this.store = store;
		this.id = id;
		this.header = header;
		this.inheritedEventCount = inheritedEventCount;
		this.access = access;
	}

	async read(offset?: number, length?: number, _options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
		this.assertOpen('read');
		const events = this.store.readSlice(this.id, offset, length);
		return { eventState: 'detached', events: structuredClone(events) };
	}

	async append(events: readonly SessionEvent[], _options?: SessionHandleAppendOptions): Promise<void> {
		this.assertOpen('append');
		if (this.access === 'read') {
			throw new SessionReadOnlyError(this.id, 'append');
		}
		await this.store.append(this.id, events);
	}

	async flush(_options?: SessionHandleFlushOptions): Promise<void> {
		this.assertOpen('flush');
		// Vacuous durability: nothing is written anywhere, so the barrier
		// resolves immediately. A read handle reaching flush is still a
		// contract violation the JSONL backend would raise.
		if (this.access === 'read') {
			throw new SessionReadOnlyError(this.id, 'flush');
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.store.release(this.id, this);
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}

	/** Whether this handle is still the store's live owner for its id. */
	isOwner(): boolean {
		return !this.closed && this.store.ownerOf(this.id) === this;
	}

	private assertOpen(operation: string): void {
		if (this.closed) throw new SessionHandleClosedError(this.id, operation);
	}
}
