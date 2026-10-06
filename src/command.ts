import '@deepseek-ai/dsh-commands';
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand';
import type { Context } from '@deepseek-ai/cordis';
import type { ModeStore } from './mode.ts';
import type { IncognitoSessionPersistence } from './service.ts';

/**
 * Register `/incognito` on every composed human-command adapter. Toggling ON
 * converts the CURRENT session: its on-disk log is wiped and the session
 * continues in memory for the rest of its life. Toggling OFF makes no
 * durability promise for the current session; only sessions created
 * afterwards persist to disk again.
 */
export function applyIncognitoCommand(ctx: Context, modeStore: ModeStore, facade: IncognitoSessionPersistence): void {
	ctx.effect(function* () {
		yield ctx.commands.register({
			definitionId: CommandDefinitionId('dsh-incognito'),
			name: 'incognito',
			description: 'Toggle incognito persistence (wipes the current session from disk)',
			handler: async () => {
				const { mode, outcome } = await facade.toggle();
				if (mode === 'persist') {
					return {
						kind: 'success' as const,
						text: 'Incognito off: sessions created from now on persist to disk again. The current session stays in memory.',
					};
				}
				const text = outcome === 'converted'
					? 'Incognito on: the current session was wiped from disk and continues in memory.'
					: outcome === 'in-memory'
						? 'Incognito on: the current session is already in memory and will never touch disk.'
						: 'Incognito on: sessions created from now on will not be written to disk.';
				return { kind: 'success' as const, text };
			},
		});
	}, 'dsh-incognito command lifecycle');
}
