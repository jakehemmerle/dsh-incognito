import type { Context } from '@deepseek-ai/cordis';
import { JsonlCompressionSchema } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { applyIncognitoCommand } from './command.ts';
import { ModeStore, parseIncognitoEnv } from './mode.ts';
import { createFacade } from './service.ts';
import type { IncognitoPluginConfig } from './types.ts';

export { parseIncognitoEnv, ModeStore } from './mode.ts';
export { IncognitoSessionStore } from './incognito-store.ts';
export { IncognitoSessionHandle } from './incognito-handle.ts';
export { IncognitoSessionPersistence } from './service.ts';
export type { IncognitoMode, IncognitoPluginConfig } from './types.ts';

const name = 'dsh-incognito';
const inject = ['commands'];

/**
 * dsh-incognito plugin entry. Wires the mode store (initial value parsed once
 * from `DSH_INCOGNITO`), the ownership-routed facade, and the `/incognito`
 * command. Exactly one `sessionPersistence` provider exists per context: the
 * base `session-persistence-jsonl` row must be disabled.
 */
function apply(ctx: Context, config: IncognitoPluginConfig): void {
	const root = config.root;
	if (typeof root !== 'string' || root.length === 0) {
		throw new TypeError('dsh-incognito: config.root (durable sessions root) is required');
	}
	const compression = JsonlCompressionSchema(config.compression) ?? undefined;
	const modeStore = new ModeStore(parseIncognitoEnv(process.env.DSH_INCOGNITO));
	const logger = {
		info: (message: string) => ctx.logger?.info?.(message),
		warn: (message: string) => ctx.logger?.warn?.(message),
	};
	const facade = createFacade(ctx, { root, ...(compression !== undefined ? { compression } : {}) }, modeStore, logger);
	applyIncognitoCommand(ctx, modeStore);
	void facade;
}

export { apply, inject, name };
