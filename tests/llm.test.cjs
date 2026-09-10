const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');

// Feeds the module a response body split at the given byte boundaries, so the
// SSE parser is exercised the way a real socket delivers it.
function bodyOf(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < chunks.length
        ? { done: false, value: encoder.encode(chunks[i++]) }
        : { done: true, value: undefined }),
    }),
  };
}

async function harness(chunks, settings = {}) {
  const requests = [];
  const { streamChat } = await load('assistant/llm.js', {
    TextDecoder,
    fetch: (url, options) => {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      return Promise.resolve({ ok: true, body: bodyOf(chunks) });
    },
  });
  const deltas = [];
  const full = await streamChat([{ role: 'user', content: 'hi' }], settings, { onDelta: d => deltas.push(d) });
  return { requests, deltas, full };
}

test('the browser calls the configured endpoint directly, with the key only when there is one', async () => {
  const anonymous = await harness([], { customLLMBaseUrl: 'http://localhost:11434/v1/', customLLMModel: 'llama3' });
  assert.equal(anonymous.requests[0].url, 'http://localhost:11434/v1/chat/completions', 'trailing slash is trimmed');
  assert.equal(anonymous.requests[0].headers.Authorization, undefined, 'a local server needs no key');
  assert.equal(anonymous.requests[0].body.model, 'llama3');
  assert.equal(anonymous.requests[0].body.stream, true);

  const keyed = await harness([], { customLLMApiKey: 'sk-test' });
  assert.equal(keyed.requests[0].headers.Authorization, 'Bearer sk-test');
  assert.equal(keyed.requests[0].url, 'http://localhost:11434/v1/chat/completions', 'defaults to a local Ollama');
});

test('SSE frames split across network chunks are reassembled', async () => {
  const frame = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;
  const stream = frame('Hello') + frame(' there') + 'data: [DONE]\n';
  // Cut mid-frame, mid-JSON and mid-newline.
  const cut = [stream.slice(0, 20), stream.slice(20, 47), stream.slice(47, 100), stream.slice(100)];
  const h = await harness(cut);
  assert.deepEqual(h.deltas, ['Hello', ' there']);
  assert.equal(h.full, 'Hello there');
});

test('keep-alives, comments and malformed frames are skipped rather than throwing', async () => {
  const h = await harness([
    ': ping\n\n',
    'data: {"choices":[{"delta":{}}]}\n',           // a role-only opening frame
    'data: not json\n',
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
    'data: [DONE]\n',
  ]);
  assert.deepEqual(h.deltas, ['ok']);
  assert.equal(h.full, 'ok');
});

test('an error response reports the status and the body', async () => {
  const { streamChat } = await load('assistant/llm.js', {
    TextDecoder,
    fetch: async () => ({ ok: false, status: 404, text: async () => 'model "llama3" not found' }),
  });
  await assert.rejects(streamChat([], {}), /404.*llama3.*not found/s);
});
