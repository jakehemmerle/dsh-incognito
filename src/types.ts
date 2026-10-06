import type { Context } from '@deepseek-ai/cordis';
import type { JsonlCompressionSchema } from '@deepseek-ai/dsh-session-persistence-jsonl';

/** The two persistence modes a session may be stamped with at `create()` time. */
export type IncognitoMode = 'persist' | 'incognito';

/**
 * Structurally the JSONL backend config: the facade forwards it verbatim to
 * the inner `JsonlSessionPersistence` child backend.
 */
export interface IncognitoPluginConfig {
  root: string;
  compression?: typeof JsonlCompressionSchema.prototype;
}

/** Resolved, validated plugin config plus the context it came from. */
export interface ResolvedPluginConfig {
  root: string;
  compression?: typeof JsonlCompressionSchema.prototype;
}
