import '@deepseek-ai/dsh-commands';
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand';
import type { Context } from '@deepseek-ai/cordis';
import type { ModeStore } from './mode.ts';

/**
 * Register `/incognito` on every composed human-command adapter. Toggling
 * affects only sessions created afterwards; live sessions keep their backing.
 */
export function applyIncognitoCommand(ctx: Context, modeStore: ModeStore): void {
	ctx.effect(function* () {
		yield ctx.commands.register({
			definitionId: CommandDefinitionId('dsh-incognito'),
			name: 'incognito',
			description: 'Toggle incognito persistence (new sessions stay off disk)',
			handler: () => {
				const mode = modeStore.toggle();
				return Promise.resolve({
					kind: 'success' as const,
					text: mode === 'incognito'
						? 'Incognito on: new sessions will not be written to disk.'
						: 'Incognito off: new sessions persist to disk again.',
				});
			},
		});
	}, 'dsh-incognito command lifecycle');
}
