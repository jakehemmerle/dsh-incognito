import type { IncognitoMode } from './types.ts';

/**
 * Parse the initial mode from an env-style value. Truthy spellings
 * (1/true/yes/on, case-insensitive) select incognito; anything else
 * (including absence) selects persist. Parsed once at `apply()` time.
 */
export function parseIncognitoEnv(value: string | undefined): IncognitoMode {
	if (value === undefined) return 'persist';
	return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()) ? 'incognito' : 'persist';
}

/**
 * Single owner of the persistence mode enum. `create()` stamps the current
 * mode onto a session at call time. Toggling ON also converts the current
 * live session to in-memory (facade-driven); toggling OFF only affects
 * sessions created afterwards.
 */
export class ModeStore {
	private mode: IncognitoMode;

	constructor(initial: IncognitoMode = 'persist') {
		this.mode = initial;
	}

	/** The current mode. */
	get(): IncognitoMode {
		return this.mode;
	}

	isIncognito(): boolean {
		return this.mode === 'incognito';
	}

	/** Toggle persist ↔ incognito and return the new mode. */
	toggle(): IncognitoMode {
		this.mode = this.mode === 'incognito' ? 'persist' : 'incognito';
		return this.mode;
	}
}
