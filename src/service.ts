import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import {
	SessionPersistence,
	SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence';
import { FacadeWriteHandle } from './facade-handle.ts';
import type {
	SessionHandle,
	SessionPersistenceCreateOptions,
	SessionPersistenceOpenOptions,
	SessionPersistenceListOptions,
	SessionPersistenceSnapshot,
	SessionPersistenceStatOptions,
	SessionAccess,
} from '@deepseek-ai/dsh-session-persistence';
import { SessionLogOffset } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { IncognitoSessionStore } from './incognito-store.ts';
import { ModeStore } from './mode.ts';
import type { IncognitoMode, IncognitoPluginConfig, ResolvedPluginConfig } from './types.ts';

/**
 * Facade persistence service over two backends, routed by ownership, not by
 * current mode. `create()` routes by the mode stamped at call time; every
 * other operation checks whether the incognito store owns the id first, then
 * delegates to the inner durable backend. The two writer sets are disjoint by
 * construction.
 */
export class IncognitoSessionPersistence extends SessionPersistence {
	static provide = 'sessionPersistence';

	readonly modeStore: ModeStore;
	readonly store: IncognitoSessionStore;

	private readonly config: ResolvedPluginConfig;
	private inner: JsonlSessionPersistence | null = null;
	private readonly logger: { info(message: string): unknown; warn(message: string): unknown };
	/** Live facade write handles by id; the most recent is the conversion target. */
	private readonly activeWrites = new Map<SessionId, FacadeWriteHandle>();

	constructor(ctx: Context, config: ResolvedPluginConfig, modeStore: ModeStore, logger: { info(message: string): unknown; warn(message: string): unknown }) {
		super(ctx);
		this.config = config;
		this.modeStore = modeStore;
		this.store = new IncognitoSessionStore();
		this.logger = logger;
	}

	/** Construct the inner durable backend on a child context. Failure enters degraded mode. */
	attachInner(): void {
		mkdirSync(this.config.root, { recursive: true });
		const childCtx = this.ctx.extend().isolate('sessionPersistence');
		try {
			this.inner = new JsonlSessionPersistence(childCtx as never, {
				root: this.config.root,
				...(this.config.compression !== undefined ? { compression: this.config.compression } : {}),
			}) as JsonlSessionPersistence;
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('[dsh-incognito] inner backend construction failed:', String(error));
			this.inner = null;
			this.logger.warn(`dsh-incognito: durable backend failed to start (${String(error)}); all sessions are in-memory and never touch disk`);
		}
	}

	async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
		const inheritedEventCount = header.isSeeded ? options?.inheritedEventCount : 0;
		if (header.isSeeded && (options?.inheritedEventCount === undefined || options.inheritedEventCount === 0)) {
			throw new TypeError(`session "${header.id}": seeded create requires a non-zero inheritedEventCount`);
		}
		if (!header.isSeeded && options?.inheritedEventCount !== undefined && options.inheritedEventCount !== 0) {
			throw new TypeError(`session "${header.id}": inheritedEventCount is only valid for a seeded create`);
		}
		if (this.modeStore.isIncognito() || this.inner === null) {
			if (this.inner === null && !this.modeStore.isIncognito()) {
				this.logger.warn(`dsh-incognito: degraded mode accepted create for session "${header.id}" in memory`);
			}
			const prefix = await this.resolveInheritedPrefix(header, SessionLogOffset(inheritedEventCount ?? 0), options?.signal);
			const backing = this.store.create({ header, inheritedEventCount: SessionLogOffset(inheritedEventCount ?? 0), prefix });
			return this.trackWriteHandle(backing);
		}
		const backing = await this.inner.create(header, options);
		return this.trackWriteHandle(backing);
	}

	/** Wrap a fresh write backing in a facade handle and register it as live. */
	private trackWriteHandle(backing: SessionHandle): FacadeWriteHandle {
		const facadeHandle = new FacadeWriteHandle(backing.id, backing.header, backing.inheritedEventCount, backing, (handle) => {
			if (this.activeWrites.get(handle.id) === handle) this.activeWrites.delete(handle.id);
		});
		// The most recently issued live write handle is the conversion target.
		this.activeWrites.delete(backing.id);
		this.activeWrites.set(backing.id, facadeHandle);
		return facadeHandle;
	}

	async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
		if (this.store.owns(id)) {
			const backing = this.store.open(id, access);
			return access === 'write' ? this.trackWriteHandle(backing) : backing;
		}
		if (this.inner === null) throw new SessionPersistenceNotFoundError(id);
		const backing = await this.inner.open(id, access, options);
		return access === 'write' ? this.trackWriteHandle(backing) : backing;
	}

	/**
	 * Toggle persist ↔ incognito. Turning ON additionally converts the
	 * requested live write session to incognito mid-session: the SAME session
	 * continues, its on-disk log is wiped, and nothing further in this session
	 * ever touches disk. Events already written before the toggle survive in
	 * memory (read-your-writes). Turning OFF affects only sessions created
	 * afterwards; the live session keeps its current backing.
	 *
	 * `requestedId` names the CURRENT session as known by the caller (the
	 * `/incognito` command passes `invocation.agent.sessionId`). The facade
	 * never guesses: converting "the most recently issued handle" would wipe
	 * the wrong session whenever another live write session exists (subagents,
	 * forks, a reopened session). Without a requested id the legacy most
	 * recent live write handle is targeted.
	 */
	async toggle(requestedId?: SessionId): Promise<{ mode: IncognitoMode; outcome: 'converted' | 'in-memory' | 'none' }> {
		const mode = this.modeStore.toggle();
		if (!this.modeStore.isIncognito()) return { mode, outcome: 'none' };
		let facadeHandle: FacadeWriteHandle | undefined;
		if (requestedId !== undefined) {
			facadeHandle = this.activeWrites.get(requestedId);
			if (facadeHandle === undefined) {
				return { mode, outcome: this.store.owns(requestedId) ? 'in-memory' : 'none' };
			}
		} else {
			facadeHandle = [...this.activeWrites.values()].at(-1);
			if (facadeHandle === undefined) return { mode, outcome: 'none' };
		}
		// A store-owned id means the backing is already the in-memory buffer.
		if (this.store.owns(facadeHandle.id)) return { mode, outcome: 'in-memory' };
		if (this.inner === null) return { mode, outcome: 'in-memory' };
		await this.convertDurableToIncognito(facadeHandle, facadeHandle.currentBacking());
		return { mode, outcome: 'converted' };
	}

	/**
	 * Read-then-close-then-wipe-then-buffer. Ordering is deliberate: the full
	 * log is read from the durable handle first (pre-toggle events survive in
	 * memory), then close drains any in-flight durability work and releases
	 * single-writer ownership, and only then is the on-disk artifact removed.
	 * A delete failure propagates loudly — the wipe is never pretended.
	 */
	private async convertDurableToIncognito(facadeHandle: FacadeWriteHandle, durable: SessionHandle): Promise<void> {
		const id = facadeHandle.id;
		const stored = await durable.read();
		await durable.close();
		const path = await this.inner!.resolveCurrentLog(id);
		try {
			if (path !== undefined) this.wipeUnderRoot(path);
		} catch (error) {
			// dql: a failed wipe must never pretend success. The durable handle
			// was already closed, so reopen it for write and restore it as the
			// backing — the session stays durable, owned, and appendable — then
			// rethrow. (The mode stays incognito; mode rollback is a separate
			// product decision noted in SPEC P-04.)
			const reopened = await this.inner!.open(id, 'write');
			facadeHandle.swapBacking(reopened);
			throw error;
		}
		const buffer = this.store.create({
			header: facadeHandle.header,
			inheritedEventCount: facadeHandle.inheritedEventCount,
			prefix: stored.events,
		});
		facadeHandle.swapBacking(buffer);
	}

	/** Remove the session's on-disk directory, refusing paths outside the configured root. */
	private wipeUnderRoot(path: string): void {
		const root = resolve(this.config.root);
		const sessionDir = dirname(resolve(path));
		if (sessionDir === root || !sessionDir.startsWith(root + '/')) {
			throw new Error(`dsh-incognito: refusing to wipe "${sessionDir}" outside the configured root "${root}"`);
		}
		rmSync(sessionDir, { recursive: true, force: false });
	}

	/** Flush every live write handle. */
	async flush(): Promise<void> {
		const errors: unknown[] = [];
		try {
			await this.inner?.flush();
		} catch (error) {
			errors.push(error);
		}
		try {
			await this.store.flushAll();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, 'dsh-incognito: service-wide flush failed for one or more sessions');
		}
	}

	async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
		if (this.store.owns(id)) return this.store.stat(id);
		return this.inner?.stat(id, options);
	}

	async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
		const durable = this.inner === null ? [] : [...await this.inner.list(options)];
		const incognito = this.store.list();
		const owned = new Set(incognito.map((snapshot) => snapshot.header.id));
		return [...incognito, ...durable.filter((snapshot) => !owned.has(snapshot.header.id))];
	}

	/**
	 * Read the exact fork-inherited prefix for a seeded create from whichever
	 * backend owns the parent. Missing parents fail loudly: a seeded session
	 * with a reconstructed-wrong prefix would corrupt replay.
	 */
	private async resolveInheritedPrefix(header: SessionHeader, inheritedEventCount: number, signal?: AbortSignal): Promise<readonly SessionEvent[]> {
		if (inheritedEventCount === 0) return [];
		if (header.parentSession === undefined) {
			throw new TypeError(`session "${header.id}": seeded create without parentSession cannot resolve an inherited prefix`);
		}
		const parentId = header.parentSession;
		const parent = await this.open(parentId, 'read', { signal });
		const slice = await parent.read(0, inheritedEventCount, { signal });
		if (slice.events.length !== inheritedEventCount) {
			throw new SessionPersistenceNotFoundError(parentId);
		}
		await parent.close();
		return slice.events;
	}
}

export interface ApplyConfig {
	config: IncognitoPluginConfig;
	/** Env-style initial mode; parsed once at apply time. */
	env: Record<string, string | undefined>;
	logger: { info(message: string): unknown; warn(message: string): unknown };
}

/** Construct the facade for a plugin context; used by `apply()` and tests. */
export function createFacade(ctx: Context, config: ResolvedPluginConfig, modeStore: ModeStore, logger: ApplyConfig['logger']): IncognitoSessionPersistence {
	const facade = new IncognitoSessionPersistence(ctx, config, modeStore, logger);
	facade.attachInner();
	return facade;
}
