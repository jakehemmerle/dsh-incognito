import { Context } from '@deepseek-ai/cordis';
import {
	SessionPersistence,
	SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence';
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
import type { IncognitoPluginConfig, ResolvedPluginConfig } from './types.ts';

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

	constructor(ctx: Context, config: ResolvedPluginConfig, modeStore: ModeStore, logger: { info(message: string): unknown; warn(message: string): unknown }) {
		super(ctx);
		this.config = config;
		this.modeStore = modeStore;
		this.store = new IncognitoSessionStore();
		this.logger = logger;
	}

	/** Construct the inner durable backend on a child context. Failure enters degraded mode. */
	attachInner(): void {
		const childCtx = this.ctx.extend();
		try {
			this.inner = new JsonlSessionPersistence(childCtx as never, {
				root: this.config.root,
				...(this.config.compression !== undefined ? { compression: this.config.compression } : {}),
			}) as JsonlSessionPersistence;
		} catch (error) {
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
			return this.store.create({ header, inheritedEventCount: SessionLogOffset(inheritedEventCount ?? 0), prefix });
		}
		return this.inner.create(header, options);
	}

	async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
		if (this.store.owns(id)) return this.store.open(id, access);
		if (this.inner === null) throw new SessionPersistenceNotFoundError(id);
		return this.inner.open(id, access, options);
	}

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
