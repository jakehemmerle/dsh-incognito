import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { IncognitoSessionPersistence } from '../src/service.ts';
import { ModeStore } from '../src/mode.ts';
import { applyIncognitoCommand } from '../src/command.ts';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';

/**
 * Red property for the §5 audit bug "wrong session wiped": `/incognito` runs
 * inside a real agent whose `CommandInvocation.agent.sessionId` names the
 * CURRENT session. The facade must convert THAT session, never guess "the most
 * recently issued write handle" — any other live write session in the process
 * (subagents, forks, a reopened session) would otherwise be wiped instead.
 */

const sid = (id: string): SessionId => id as SessionId;

let runCounter = 0;

function makeFacade(): { facade: IncognitoSessionPersistence; root: string } {
	const root = mkdtempSync(join(tmpdir(), `dsh-incognito-target-${++runCounter}-`));
	const facade = new IncognitoSessionPersistence(
		new Context(),
		{ root, compression: 'none' },
		new ModeStore('persist'),
		{ info() {}, warn() {} },
	);
	facade.attachInner();
	return { facade, root };
}

function headerFor(id: SessionId): SessionHeader {
	return { version: 4, id, createdAt: 1_700_000_000_000, isSeeded: false };
}

function batchAt(startSeq: number, size: number): SessionEvent[] {
	return Array.from({ length: size }, (_, i) => {
		const seq = startSeq + i;
		const turn = Math.floor(seq / 2) + 1;
		return (seq % 2 === 0
			? { seq, time: 1_700_000_000_000 + seq, type: 'turn/start', data: { turn } }
			: { seq, time: 1_700_000_000_000 + seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }) as unknown as SessionEvent;
	});
}

function filesForId(root: string, id: string): string[] {
	if (!existsSync(root)) return [];
	const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
	return walk(root).filter((path) => path.includes(`/${id}/`));
}

/** Two live durable sessions; B was created (and its handle issued) most recently. */
async function twoDurableSessions(facade: IncognitoSessionPersistence, root: string) {
	const aId = sid(`target-a-${runCounter}`);
	const bId = sid(`target-b-${runCounter}`);
	const a = await facade.create(headerFor(aId));
	await a.append(batchAt(0, 2));
	await a.flush();
	const aFiles = filesForId(root, aId);
	expect(aFiles.length).toBeGreaterThan(0);
	const b = await facade.create(headerFor(bId));
	await b.append(batchAt(0, 2));
	await b.flush();
	const bFiles = filesForId(root, bId);
	expect(bFiles.length).toBeGreaterThan(0);
	return { a, b, aId, bId, bFiles };
}

describe('toggle targets the requested session (real facade, real JSONL backend)', () => {
	it('R1: facade.toggle(currentSessionId) converts THAT session and leaves the other durable one untouched', async () => {
		const { facade, root } = makeFacade();
		const { a, b, aId, bId, bFiles } = await twoDurableSessions(facade, root);

		// The command layer knows the current session (invocation.agent.sessionId)
		// and passes it; here the current session is A, though B's handle was
		// issued most recently.
		const { mode, outcome } = await facade.toggle(aId);
		expect(mode).toBe('incognito');
		expect(outcome).toBe('converted');

		// A was wiped from disk and lives in memory with read-your-writes.
		expect(filesForId(root, aId)).toEqual([]);
		const aRead = await a.read();
		expect(aRead.events.length).toBe(2);
		// Further appends to A never touch disk.
		await a.append(batchAt(2, 2));
		await a.flush();
		expect(filesForId(root, aId)).toEqual([]);

		// B is untouched: still durable, still on disk with its artifact.
		expect(filesForId(root, bId).length).toBe(bFiles.length);
		const bStat = await facade.stat(bId);
		expect(bStat?.sizeBytes).toBeGreaterThan(0);
		const bRead = await b.read();
		expect(bRead.events.length).toBe(2);

		await a.close();
		await b.close();
	});

	it('R2: the /incognito command handler converts the invocation agent session, not the most recent handle', async () => {
		const { facade, root } = makeFacade();
		const { a, b, aId, bId, bFiles } = await twoDurableSessions(facade, root);

		let captured: { handler: (invocation: { agent: { session: { id: SessionId } } }) => Promise<unknown> } | undefined;
		const fakeCtx = {
			// cordis ctx.effect takes a generator FUNCTION; stepping it once runs
			// the body up to its first yield, which performs commands.register.
			effect(makeGen: () => Generator, _name: string) {
				makeGen().next();
			},
			commands: {
				register(definition: { handler: (invocation: { agent: { session: { id: SessionId } } }) => Promise<unknown> }) {
					captured = definition;
				},
			},
		} as unknown as Context;
		applyIncognitoCommand(fakeCtx, facade.modeStore, facade);
		expect(captured).toBeDefined();

		// The dispatching UI invokes the handler with the CURRENT session A.
		const result = await captured!.handler({ agent: { session: { id: aId } } }) as { kind: string; text: string };
		expect(result.kind).toBe('success');
		expect(result.text).toContain('wiped');

		// A was converted; B (the most recent handle) must be untouched.
		expect(filesForId(root, aId)).toEqual([]);
		expect(filesForId(root, bId).length).toBe(bFiles.length);
		expect((await facade.stat(bId))?.sizeBytes).toBeGreaterThan(0);
		expect((await facade.stat(aId))?.eventCount).toBe(2);

		await a.close();
		await b.close();
	});
});
