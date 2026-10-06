import { SessionHandleClosedError } from '@deepseek-ai/dsh-session-persistence';
import type {
	SessionAccess,
	SessionHandle,
	SessionHandleAppendOptions,
	SessionHandleFlushOptions,
	SessionHandleReadOptions,
	SessionHandleReadResult,
} from '@deepseek-ai/dsh-session-persistence';
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';

/**
 * Facade-level write handle. Every write handle the facade issues wraps the
 * *current* backing — the durable inner handle or the in-memory buffer — so
 * the backing can be swapped at runtime for mid-session conversion. All
 * operations delegate to the live backing; `swapBacking` is reserved for the
 * facade's conversion path.
 */
export class FacadeWriteHandle implements SessionHandle {
	readonly id: SessionId;
	readonly header: SessionHeader;
	readonly inheritedEventCount: SessionLogOffset;
	readonly access: SessionAccess;

	private backing: SessionHandle;
	private closed = false;
	private onRelease: ((handle: FacadeWriteHandle) => void) | null;

	constructor(
		id: SessionId,
		header: SessionHeader,
		inheritedEventCount: SessionLogOffset,
		backing: SessionHandle,
		onRelease: ((handle: FacadeWriteHandle) => void) | null,
	) {
		this.id = id;
		this.header = header;
		this.inheritedEventCount = inheritedEventCount;
		this.access = 'write';
		this.backing = backing;
		this.onRelease = onRelease;
	}

	/** Swap the backing mid-flight (conversion). Facade-internal. */
	swapBacking(next: SessionHandle): void {
		this.backing = next;
	}

	/** The current backing handle (facade-internal diagnostics). */
	currentBacking(): SessionHandle {
		return this.backing;
	}

	/** Whether this facade handle is still open. */
	isOpen(): boolean {
		return !this.closed;
	}

	async read(offset?: number, length?: number, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
		this.assertOpen('read');
		return this.backing.read(offset, length, options);
	}

	async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
		this.assertOpen('append');
		await this.backing.append(events, options);
	}

	async flush(options?: SessionHandleFlushOptions): Promise<void> {
		this.assertOpen('flush');
		await this.backing.flush(options);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const release = this.onRelease;
		this.onRelease = null;
		await this.backing.close();
		release?.(this);
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}

	private assertOpen(operation: string): void {
		if (this.closed) throw new SessionHandleClosedError(this.id, operation);
	}
}
