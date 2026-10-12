// Vendored from ~/nix-config/skills/new-dsh-plugin/scripts/mock-llm.mjs
// (nix-config commit 6a7e613 "5.3 FLASH: new-dsh-plugin: SemVer release procedure
// and public plugin repos", skill copied verbatim below this header).
// Provenance per the new-dsh-plugin skill: importing the rig from ~/.agents broke
// nix-config CI (red on main since 949b844), so every plugin repo vendors its own
// copy. Update by re-copying from the skill, keeping this header.
// Local OpenAI-compatible model server for DSH plugin tests: no network, no
// credentials, no cost. Point a pi-ai provider row at it (rig.mjs does this)
// with `api: openai-completions` and `baseURL: <mock.baseURL>`.
//
//   import { startMockLlm } from './mock-llm.mjs';
//   const mock = await startMockLlm({ script: (req) => ({ text: 'pong' }) });
//   ... drive dsh ...; mock.requests  -> every request body, in arrival order
//   mock.hold(true) keeps matching streams open (after the role chunk) until
//   mock.hold(false); title-generation requests are never held.
//
// script(req, index) returns { text } or { toolCalls: [{ name, arguments }] }
// (arguments: object or JSON string). Default: echo "pong from <model>".
// CLI: `node mock-llm.mjs [port]` prints the base URL and logs each request.
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Last user message text, flattening content parts. */
export function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    return typeof m.content === 'string' ? m.content
      : (m.content ?? []).map((p) => p?.text ?? '').join('');
  }
  return '';
}

/** Text of every message (system, user, assistant, tool), for searching a prompt. */
export function allText(messages = []) {
  return messages.map((m) => (typeof m?.content === 'string' ? m.content
    : (m?.content ?? []).map((p) => p?.text ?? '').join(''))).join('\n');
}

/** DSH asks for a session title in a separate request at the same time as the turn. */
export function isTitleRequest(req) {
  const system = (req.messages ?? []).filter((m) => m.role === 'system').map((m) => allText([m])).join('\n');
  return /\btitle\b/i.test(system) && !(req.tools?.length);
}

export async function startMockLlm({ port = 0, script } = {}) {
  const requests = [];
  const held = [];
  let holdWhen = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      if (!req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
      let json;
      try { json = JSON.parse(body || '{}'); } catch { res.writeHead(400).end(); return; }
      const record = { ...json, receivedAt: Date.now(), title: false };
      record.title = isTitleRequest(record);
      const index = requests.push(record) - 1;
      const plan = record.title ? { text: 'Mock title' }
        : (script ? script(record, index) : null) ?? { text: `pong from ${json.model}` };
      const frame = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({
        id: `mock-${index}`, object: 'chat.completion.chunk', created: 0, model: json.model,
        choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
      })}\n\n`;
      if (json.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `mock-${index}`, object: 'chat.completion', created: 0, model: json.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: plan.text ?? '' } }],
          usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(frame({ role: 'assistant', content: '' }));
      const finish = () => {
        if (plan.toolCalls?.length) {
          plan.toolCalls.forEach((call, i) => res.write(frame({ tool_calls: [{ index: i, id: call.id ?? `call_${index}_${i}`, type: 'function',
            function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments
              : JSON.stringify(call.arguments === undefined ? {} : call.arguments) } }] })));
          res.write(frame({}, 'tool_calls'));
        } else {
          if (plan.text) res.write(frame({ content: plan.text }));
          res.write(frame({}, 'stop'));
        }
        res.write(`data: ${JSON.stringify({ id: `mock-${index}`, object: 'chat.completion.chunk', created: 0, model: json.model, choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      };
      if (!record.title && holdWhen && holdWhen(record)) held.push(finish); else finish();
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;
  return {
    port: actual,
    baseURL: `http://127.0.0.1:${actual}/v1`,
    requests,
    /** Turn requests only (title generation filtered out). */
    turns() { return requests.filter((r) => !r.title); },
    /** true / predicate: hold matching streams open; false: release everything held. */
    hold(on) {
      holdWhen = on === true ? () => true : typeof on === 'function' ? on : null;
      if (!holdWhen) while (held.length) held.shift()();
    },
    held() { return held.length; },
    async close() { this.hold(false); await new Promise((resolve) => server.close(resolve)); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const mock = await startMockLlm({ port: Number(process.argv[2] ?? 0) });
  console.log(mock.baseURL);
  setInterval(() => {
    while (mock.requests.logged !== mock.requests.length) {
      const i = mock.requests.logged ?? 0;
      const r = mock.requests[i];
      console.log(JSON.stringify({ i, model: r.model, title: r.title, tools: r.tools?.length ?? 0, last: lastUserText(r.messages).slice(0, 120) }));
      mock.requests.logged = i + 1;
    }
  }, 200);
}
