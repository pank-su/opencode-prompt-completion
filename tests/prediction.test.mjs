import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PREDICTION_PROMPT,
  makePredictionPrompt,
  parsePrediction,
} from '../src/prediction/prompt.mjs';
import { PredictionController } from '../src/prediction/controller.mjs';
import { INVALIDATING_EVENTS } from '../src/opencode/snapshot.mjs';

const flush = async (ticks = 4) => {
  for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const editor1 = { id: 'editor-1' };
const model1 = { providerID: 'p', id: 'm' };

const snapshot = (overrides = {}) => ({
  sessionID: 's1',
  editor: editor1,
  prefix: '',
  presentable: true,
  requestable: true,
  revision: 'r1',
  model: model1,
  context: '[]',
  ...overrides,
});

const text = (suggestion) => ({ text: JSON.stringify({ suggestion }) });

// --- parsing ---------------------------------------------------------------

test('PREDICTION_PROMPT is an English instruction with the strict JSON shape', () => {
  assert.equal(typeof PREDICTION_PROMPT, 'string');
  assert.match(PREDICTION_PROMPT, /\{"suggestion": string\|null\}/);
  assert.match(PREDICTION_PROMPT, /do not call tools/i);
  assert.match(PREDICTION_PROMPT, /same language/i);
  assert.match(PREDICTION_PROMPT, /return null/i);
  assert.doesNotMatch(PREDICTION_PROMPT, /context above/i);
});

test('INVALIDATING_EVENTS is conservative and excludes execution.succeeded', () => {
  assert.ok(INVALIDATING_EVENTS instanceof Set);
  for (const type of [
    'session.inbox.enqueued',
    'session.execution.started',
    'session.execution.failed',
    'session.execution.interrupted',
    'session.model.selected',
    'session.agent.selected',
    'session.moved',
    'session.revert.staged',
    'session.revert.committed',
    'session.compaction.started',
    'session.deleted',
  ]) {
    assert.ok(INVALIDATING_EVENTS.has(type), type);
  }
  assert.ok(!INVALIDATING_EVENTS.has('session.execution.succeeded'));
});

test('parsePrediction accepts strict JSON and trims the suggestion', () => {
  assert.equal(parsePrediction('{"suggestion":"run the tests"}'), 'run the tests');
  assert.equal(parsePrediction('  {"suggestion":"  spaced  "}  '), 'spaced');
  assert.equal(parsePrediction('{"suggestion":null}'), null);
  assert.equal(parsePrediction('{"suggestion":"   "}'), null);
});

test('parsePrediction accepts a sole fenced json block', () => {
  assert.equal(parsePrediction('```json\n{"suggestion":"fenced"}\n```'), 'fenced');
  assert.equal(parsePrediction('```\n{"suggestion":"plain fence"}\n```'), 'plain fence');
  assert.equal(parsePrediction('```JSON\n{"suggestion":"upper"}\n```'), 'upper');
});

test('parsePrediction rejects arbitrary extracted JSON and stray fences', () => {
  assert.throws(() => parsePrediction('Here you go: {"suggestion":"x"}'), /Invalid prediction response/);
  assert.throws(() => parsePrediction('{"suggestion":"x"}\nDone'), /Invalid prediction response/);
  assert.throws(() => parsePrediction('```json\n{"suggestion":"x"}\n```\nextra'), /Invalid prediction response/);
  assert.throws(() => parsePrediction('text ```json\n{"suggestion":"x"}\n```'), /Invalid prediction response/);
});

test('parsePrediction rejects invalid JSON and wrong schema', () => {
  for (const raw of ['', '   ', '{', 'not json', 'null', '[]', '"str"', '42', 'true',
    '{}', '{"other":"x"}', '{"suggestion":1}', '{"suggestion":"x","extra":1}',
    '{"suggestion":["x"]}']) {
    assert.throws(() => parsePrediction(raw), /Invalid prediction response/, JSON.stringify(raw));
  }
});

test('parsePrediction rejects control characters and overlong suggestions', () => {
  assert.throws(() => parsePrediction('{"suggestion":"line1\\nline2"}'), /Invalid prediction response/);
  assert.throws(() => parsePrediction('{"suggestion":"tab\\there"}'), /Invalid prediction response/);
  assert.throws(() => parsePrediction(JSON.stringify({ suggestion: 'a'.repeat(401) })), /Invalid prediction response/);
  assert.equal(parsePrediction(JSON.stringify({ suggestion: 'a'.repeat(400) })), 'a'.repeat(400));
});

test('parsePrediction never leaks the raw response in the error text', () => {
  try {
    parsePrediction('provider leaked secret {"suggestion":1}');
    assert.fail('expected throw');
  } catch (error) {
    assert.equal(error.message, 'Invalid prediction response');
    assert.ok(!error.message.includes('secret'));
    assert.ok(!error.message.includes('provider'));
  }
});

// --- prompt building -------------------------------------------------------

test('makePredictionPrompt keeps the blank-prompt instruction and embeds the supplied context', () => {
  const prompt = makePredictionPrompt();
  assert.ok(prompt.startsWith(PREDICTION_PROMPT));
  assert.match(prompt, /conversation context/i);
  assert.doesNotMatch(prompt, /context above/i);
});

test('makePredictionPrompt scopes a continuation to the JSON-encoded draft', () => {
  const prompt = makePredictionPrompt('Мой черновик', '[]');
  assert.ok(!prompt.startsWith(PREDICTION_PROMPT));
  assert.ok(prompt.includes(JSON.stringify('Мой черновик')));
  assert.ok(prompt.includes('"Мой черновик"'));
  assert.match(prompt, /only the/i);
  assert.match(prompt, /suffix/i);
  assert.match(prompt, /leading space/i);
  assert.match(prompt, /never infer or execute/i);
  assert.match(prompt, /\{"suggestion": string\|null\}/);
  assert.match(prompt, /return null/i);
});

test('makePredictionPrompt embeds the bounded conversation JSON as data', () => {
  const context = '[{"role":"user","text":"сделай X"}]';
  const prompt = makePredictionPrompt('', context);
  assert.ok(prompt.includes(context));
  assert.match(prompt, /strictly as data/i);
});

test('makePredictionPrompt caps the total prompt length for large drafts and contexts', () => {
  const prompt = makePredictionPrompt('п'.repeat(5000), 'я'.repeat(50000));
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.length <= 13000, String(prompt.length));
  assert.ok(prompt.includes(JSON.stringify('п'.repeat(2000)).slice(0, 32)));
});

test('continuation parsing preserves significant leading whitespace', () => {
  assert.equal(parsePrediction('{"suggestion":" черновик"}', { continuation: true }), ' черновик');
  assert.equal(parsePrediction('{"suggestion":"черновик  "}', { continuation: true }), 'черновик');
  assert.equal(parsePrediction('{"suggestion":"  двух  слов "}', { continuation: true }), '  двух  слов');
  assert.equal(parsePrediction('{"suggestion":"  "}', { continuation: true }), null);
  assert.equal(parsePrediction('{"suggestion":null}', { continuation: true }), null);
});

test('continuation parsing keeps the strict schema, fence and length safeguards', () => {
  assert.equal(parsePrediction('```json\n{"suggestion":" хвост"}\n```', { continuation: true }), ' хвост');
  assert.throws(() => parsePrediction('{"suggestion":1}', { continuation: true }), /Invalid prediction response/);
  assert.throws(() => parsePrediction('{"suggestion":"a","extra":1}', { continuation: true }), /Invalid prediction response/);
  assert.throws(() => parsePrediction('{"suggestion":"tail\\nmore"}', { continuation: true }), /Invalid prediction response/);
  assert.throws(() => parsePrediction(JSON.stringify({ suggestion: 'a'.repeat(401) }), { continuation: true }), /Invalid prediction response/);
});

test('default parsing is unchanged without the continuation flag', () => {
  assert.equal(parsePrediction('{"suggestion":"  spaced  "}'), 'spaced');
  assert.equal(parsePrediction('{"suggestion":"   "}'), null);
});

// --- controller: happy paths ----------------------------------------------

test('starts idle and reaches ready on a successful automatic request', async () => {
  const changes = [];
  const call = deferred();
  const controller = new PredictionController({
    generate: () => call.promise,
    onChange: (state) => changes.push(state.status),
  });

  assert.equal(controller.state.status, 'idle');
  assert.equal(await controller.request(snapshot(), 'src-1'), true);
  assert.equal(controller.state.status, 'loading');
  assert.equal(controller.state.sessionID, 's1');

  call.resolve(text('next step'));
  await flush();

  assert.equal(controller.state.status, 'ready');
  assert.equal(controller.state.suggestion, 'next step');
  assert.deepEqual(changes, ['loading', 'ready']);
});

test('request passes model, prefix, context, prompt and an AbortSignal to generate', async () => {
  const seen = [];
  const controller = new PredictionController({
    generate: (request, options) => {
      seen.push({ request, hasSignal: options.signal instanceof AbortSignal, aborted: options.signal.aborted });
      return Promise.resolve(text('ok'));
    },
  });
  await controller.request(snapshot({ prefix: 'draft' }), 'src-1');
  await flush();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].request.model, model1);
  assert.equal(seen[0].request.prefix, 'draft');
  assert.equal(seen[0].request.context, '[]');
  assert.ok(seen[0].request.prompt.includes(JSON.stringify('draft')));
  assert.equal(seen[0].hasSignal, true);
  assert.equal(seen[0].aborted, false);
});

test('request without identity, model or eligibility is skipped', async () => {
  let calls = 0;
  const controller = new PredictionController({ generate: () => { calls += 1; return Promise.resolve(text('x')); } });
  assert.equal(await controller.request(snapshot({ editor: null }), 'a'), false);
  assert.equal(await controller.request(snapshot({ sessionID: null }), 'b'), false);
  assert.equal(await controller.request(snapshot({ model: undefined }), 'c'), false);
  assert.equal(await controller.request(snapshot({ requestable: false }), 'd'), false);
  assert.equal(calls, 0);
});

test('a null suggestion becomes none/no-suggestion and never loops', async () => {
  let calls = 0;
  const controller = new PredictionController({ generate: () => { calls += 1; return Promise.resolve(text(null)); } });
  await controller.request(snapshot(), 'src-1');
  await flush();
  assert.equal(controller.state.status, 'none');
  assert.equal(controller.state.reason, 'no-suggestion');
  assert.equal(controller.state.suggestion, undefined);
  assert.equal(controller.needsRequest, false);
  assert.equal(await controller.request(snapshot(), 'src-2'), false);
  assert.equal(calls, 1);
});

// --- caching, typing and backspace ----------------------------------------

test('matching typing and backspace reuse the cached candidate without new calls', async () => {
  let calls = 0;
  const controller = new PredictionController({
    generate: () => { calls += 1; return Promise.resolve({ text: '{"suggestion":"cd"}' }); },
  });

  await controller.request(snapshot({ prefix: 'ab' }), 'src-1');
  await flush();
  assert.equal(controller.state.status, 'ready');
  assert.equal(controller.state.suggestion, 'cd');
  assert.equal(calls, 1);

  controller.update(snapshot({ prefix: 'abc' }));
  assert.equal(controller.state.status, 'ready');
  assert.equal(controller.state.suggestion, 'd');
  assert.equal(controller.needsRequest, false);

  controller.update(snapshot({ prefix: 'ab' }));
  assert.equal(controller.state.status, 'ready');
  assert.equal(controller.state.suggestion, 'cd');

  assert.equal(calls, 1);
  assert.ok(controller.diagnostics.cacheHits >= 2);
});

test('a mid-flight matching prefix change does not cancel and projects against the latest prefix', async () => {
  const call = deferred();
  let signal;
  const controller = new PredictionController({
    generate: (_, options) => { signal = options.signal; return call.promise; },
  });

  await controller.request(snapshot({ prefix: 'ab' }), 'src-1');
  controller.update(snapshot({ prefix: 'abc' }));
  assert.equal(signal.aborted, false);
  assert.equal(controller.state.status, 'loading');

  call.resolve({ text: '{"suggestion":"cd"}' });
  await flush();
  assert.equal(controller.state.status, 'ready');
  assert.equal(controller.state.suggestion, 'd');
});

test('an incompatible reply yields none/prefix-mismatch and needsRequest for the new prefix', async () => {
  const call = deferred();
  const controller = new PredictionController({ generate: () => call.promise });

  await controller.request(snapshot({ prefix: 'ab' }), 'src-1');
  controller.update(snapshot({ prefix: 'xyz' }));
  call.resolve({ text: '{"suggestion":"cd"}' });
  await flush();

  assert.equal(controller.state.status, 'none');
  assert.equal(controller.state.reason, 'prefix-mismatch');
  assert.equal(controller.needsRequest, true);
});

test('an exact completed candidate marks the draft complete and stops auto requests', async () => {
  const controller = new PredictionController({ generate: () => Promise.resolve(text('abc')) });
  await controller.request(snapshot(), 'src-1');
  await flush();
  assert.equal(controller.state.status, 'ready');
  assert.equal(controller.state.suggestion, 'abc');

  controller.update(snapshot({ prefix: 'abc' }));
  assert.equal(controller.state.status, 'none');
  assert.equal(controller.state.reason, 'complete');
  assert.equal(controller.needsRequest, false);
});

test('a cached scope is projected again after switching away and back', async () => {
  let calls = 0;
  const controller = new PredictionController({
    generate: () => { calls += 1; return Promise.resolve({ text: '{"suggestion":"cd"}' }); },
  });

  await controller.request(snapshot({ prefix: 'ab' }), 'src-1');
  await flush();
  assert.equal(controller.state.suggestion, 'cd');

  controller.update(snapshot({ sessionID: 's2', editor: { id: 'editor-2' } }));
  assert.equal(controller.state.status, 'idle');

  controller.update(snapshot({ prefix: 'ab' }));
  assert.equal(controller.state.status, 'ready');
  assert.equal(controller.state.suggestion, 'cd');
  assert.equal(calls, 1);
});

// --- automatic flag, dedup and manual retry --------------------------------

test('automatic=false blocks automatic requests but manual still works', async () => {
  let calls = 0;
  const controller = new PredictionController({
    automatic: false,
    generate: () => { calls += 1; return Promise.resolve(text('manual')); },
  });
  assert.equal(await controller.request(snapshot(), 'src-1'), false);
  assert.equal(calls, 0);
  assert.equal(await controller.request(snapshot(), 'src-1', { manual: true }), true);
  await flush();
  assert.equal(calls, 1);
  assert.equal(controller.state.suggestion, 'manual');
});

test('automatic requests dedupe semantically by scope+prefix, not by source id', async () => {
  let calls = 0;
  const controller = new PredictionController({ generate: () => { calls += 1; return Promise.resolve(text('x')); } });
  assert.equal(await controller.request(snapshot(), 'src-1'), true);
  assert.equal(await controller.request(snapshot(), 'src-2'), false);
  await flush();
  assert.equal(calls, 1);
});

test('manual retry recovers after a null automatic attempt', async () => {
  let calls = 0;
  const controller = new PredictionController({
    generate: () => {
      calls += 1;
      return calls === 1 ? Promise.resolve(text(null)) : Promise.resolve(text('retry ok'));
    },
  });
  await controller.request(snapshot(), 'src-1');
  await flush();
  assert.equal(controller.state.status, 'none');
  assert.equal(controller.needsRequest, false);

  assert.equal(await controller.request(snapshot(), 'src-1', { manual: true }), true);
  await flush();
  assert.equal(controller.state.status, 'ready');
  assert.equal(controller.state.suggestion, 'retry ok');
});

test('manual request is rejected while another request is in flight', async () => {
  const call = deferred();
  const controller = new PredictionController({ generate: () => call.promise });
  await controller.request(snapshot({ prefix: 'ab' }), 'src-1');
  assert.equal(await controller.request(snapshot({ prefix: 'ab' }), 'src-1', { manual: true }), false);
  controller.dispose();
  call.resolve(text('x'));
  await flush();
});

test('dismiss hides, blocks auto repeat and allows an explicit manual retry', async () => {
  let calls = 0;
  const controller = new PredictionController({
    generate: () => { calls += 1; return Promise.resolve(text('next')); },
  });
  await controller.request(snapshot(), 'src-1');
  await flush();
  assert.equal(controller.state.status, 'ready');

  controller.dismiss();
  assert.equal(controller.state.status, 'dismissed');
  assert.equal(controller.needsRequest, false);
  assert.equal(await controller.request(snapshot(), 'src-1'), false);
  assert.equal(calls, 1);

  assert.equal(await controller.request(snapshot(), 'src-1', { manual: true }), true);
  await flush();
  assert.equal(controller.state.status, 'ready');
  assert.equal(calls, 2);
});

// --- scope changes and staleness -------------------------------------------

test('a session change cancels in-flight work and ignores the late reply', async () => {
  const first = deferred();
  let signal;
  const controller = new PredictionController({
    generate: (_, options) => { signal = options.signal; return first.promise; },
  });

  await controller.request(snapshot(), 'src-1');
  assert.equal(controller.state.status, 'loading');

  controller.update(snapshot({ sessionID: 's2', editor: { id: 'editor-2' } }));
  assert.equal(signal.aborted, true);
  assert.equal(controller.state.status, 'idle');
  assert.equal(controller.diagnostics.cancelled, 1);

  first.resolve(text('stale for s1'));
  await flush();
  assert.equal(controller.state.status, 'idle');
  assert.equal(controller.state.suggestion, undefined);
});

test('a model change cancels in-flight work and ignores the late reply', async () => {
  const first = deferred();
  let signal;
  const controller = new PredictionController({
    generate: (_, options) => { signal = options.signal; return first.promise; },
  });

  await controller.request(snapshot(), 'src-1');
  controller.update(snapshot({ model: { providerID: 'p', id: 'm2' } }));
  assert.equal(signal.aborted, true);

  first.resolve(text('stale'));
  await flush();
  assert.equal(controller.state.status, 'idle');
  assert.equal(controller.state.suggestion, undefined);
});

test('an editor swap within the same scope does not cancel the in-flight request', async () => {
  const call = deferred();
  const controller = new PredictionController({ generate: () => call.promise });
  await controller.request(snapshot({ prefix: 'ab' }), 'src-1');
  controller.update(snapshot({ prefix: 'ab', editor: { id: 'editor-2' } }));
  assert.equal(controller.state.status, 'loading');
  call.resolve({ text: '{"suggestion":"c"}' });
  await flush();
  assert.equal(controller.state.status, 'ready');
  assert.equal(controller.state.suggestion, 'c');
});

test('a temporary blur keeps the same-scope candidate and restores it on focus', async () => {
  const call = deferred();
  let signal;
  const controller = new PredictionController({
    generate: (_, options) => { signal = options.signal; return call.promise; },
  });

  await controller.request(snapshot({ prefix: 'ab' }), 'src-1');
  controller.update(snapshot({ prefix: 'ab', presentable: false }));
  assert.equal(signal.aborted, false);

  call.resolve({ text: '{"suggestion":"c"}' });
  await flush();
  assert.equal(controller.state.status, 'none');
  assert.equal(controller.state.reason, 'hidden');

  controller.update(snapshot({ prefix: 'ab', presentable: true }));
  assert.equal(controller.state.status, 'ready');
  assert.equal(controller.state.suggestion, 'c');
});

test('a superseded failure never surfaces as an error', async () => {
  const first = deferred();
  const controller = new PredictionController({ generate: () => first.promise });

  await controller.request(snapshot(), 'src-1');
  controller.update(snapshot({ sessionID: 's2', editor: { id: 'e2' } }));
  first.reject(new Error('late failure for s1'));
  await flush();
  assert.equal(controller.state.status, 'idle');
  assert.equal(controller.state.error, undefined);
});

// --- invalidation, bounds and diagnostics ---------------------------------

test('invalidate clears the active scope cache and attempts and cancels work', async () => {
  let calls = 0;
  const controller = new PredictionController({
    generate: () => { calls += 1; return Promise.resolve({ text: '{"suggestion":"cd"}' }); },
  });
  await controller.request(snapshot({ prefix: 'ab' }), 'src-1');
  await flush();
  assert.equal(controller.state.status, 'ready');

  controller.invalidate();
  assert.equal(controller.state.status, 'idle');
  assert.equal(controller.needsRequest, true);
  assert.equal(await controller.request(snapshot({ prefix: 'ab' }), 'src-2'), true);
  await flush();
  assert.equal(calls, 2);
});

test('cache LRU keeps at most maxContexts scopes', async () => {
  const controller = new PredictionController({
    maxContexts: 2,
    generate: () => Promise.resolve(text('x')),
  });

  for (const sessionID of ['s1', 's2', 's3']) {
    await controller.request(snapshot({ sessionID }), `src-${sessionID}`);
    await flush(2);
  }

  controller.update(snapshot({ sessionID: 's1' }));
  assert.equal(controller.needsRequest, true);
  controller.update(snapshot({ sessionID: 's3' }));
  assert.equal(controller.needsRequest, false);
});

test('attempt memory is bounded to 200 raw prefixes per scope', async () => {
  let calls = 0;
  const controller = new PredictionController({
    generate: () => { calls += 1; return Promise.resolve(text(null)); },
  });

  for (let i = 0; i <= 200; i += 1) {
    assert.equal(await controller.request(snapshot({ prefix: `p${i}` }), `src-${i}`), true, `p${i}`);
    await flush(2);
  }
  assert.equal(calls, 201);

  controller.update(snapshot({ prefix: 'p0' }));
  assert.equal(controller.needsRequest, true);
  controller.update(snapshot({ prefix: 'p1' }));
  assert.equal(controller.needsRequest, false);
});

test('diagnostics expose counters only, never prediction text', async () => {
  const controller = new PredictionController({
    generate: () => Promise.resolve(text('secret-suggestion')),
  });
  await controller.request(snapshot({ prefix: 'draft-secret' }), 'src-1');
  await flush();

  const diagnostics = controller.diagnostics;
  assert.deepEqual(Object.keys(diagnostics).sort(), ['cacheHits', 'cancelled', 'errors', 'latencyMs', 'requests']);
  assert.equal(typeof diagnostics.requests, 'number');
  assert.equal(typeof diagnostics.cacheHits, 'number');
  assert.equal(typeof diagnostics.cancelled, 'number');
  assert.equal(typeof diagnostics.errors, 'number');
  assert.equal(typeof diagnostics.latencyMs, 'number');

  const serialized = JSON.stringify(diagnostics);
  assert.ok(!serialized.includes('secret-suggestion'));
  assert.ok(!serialized.includes('draft-secret'));
  assert.ok(!serialized.includes('context'));
});

// --- timeouts, failures and disposal --------------------------------------

test('timeout sets a distinct generic error state and aborts the signal', async () => {
  let signal;
  const controller = new PredictionController({
    timeoutMs: 10,
    generate: (_, options) => { signal = options.signal; return new Promise(() => {}); },
  });

  await controller.request(snapshot(), 'src-1');
  assert.equal(controller.state.status, 'loading');
  await delay(40);

  assert.equal(controller.state.status, 'error');
  assert.match(controller.state.error, /время ожидания/);
  assert.equal(controller.state.suggestion, undefined);
  assert.equal(signal.aborted, true);
  assert.equal(controller.diagnostics.errors, 1);
});

test('timeout resolves cleanly even when generate ignores the AbortSignal', async () => {
  const call = deferred();
  const controller = new PredictionController({ timeoutMs: 10, generate: () => call.promise });

  await controller.request(snapshot(), 'src-1');
  await delay(40);
  assert.equal(controller.state.status, 'error');
  assert.match(controller.state.error, /время ожидания/);

  call.resolve(text('too late'));
  await flush();
  assert.equal(controller.state.status, 'error');
  assert.equal(controller.state.suggestion, undefined);
});

test('timeout is still reported as timeout when the client rejects immediately on abort', async () => {
  const controller = new PredictionController({
    timeoutMs: 10,
    generate: (_, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('client aborted')), { once: true });
    }),
  });
  await controller.request(snapshot(), 'timeout-abort');
  await delay(40);
  assert.equal(controller.state.status, 'error');
  assert.match(controller.state.error, /время ожидания/);
});

test('a failed generation and an unparsable response produce the generic error', async () => {
  const failing = new PredictionController({ generate: () => Promise.reject(new Error('provider secret 500')) });
  await failing.request(snapshot(), 'src-1');
  await flush();
  assert.equal(failing.state.status, 'error');
  assert.equal(failing.state.error, 'Не удалось получить предсказание');
  assert.ok(!failing.state.error.includes('secret'));

  const unparsable = new PredictionController({ generate: () => Promise.resolve({ text: 'not json at all' }) });
  await unparsable.request(snapshot(), 'src-1');
  await flush();
  assert.equal(unparsable.state.status, 'error');
  assert.equal(unparsable.state.error, 'Не удалось получить предсказание');
});

test('a suffix that repeats the whole draft becomes a generic error without leaking text', async () => {
  const controller = new PredictionController({
    generate: () => Promise.resolve({ text: JSON.stringify({ suggestion: 'Мой черновик' }) }),
  });
  await controller.request(snapshot({ prefix: 'Мой' }), 'src-1');
  await flush();
  assert.equal(controller.state.status, 'error');
  assert.equal(controller.state.error, 'Не удалось получить предсказание');
  assert.ok(!controller.state.error.includes('черновик'));
  assert.equal(controller.state.prefix, 'Мой');
});

test('no unhandled rejections from failure, timeout and superseded failures', async () => {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const failing = new PredictionController({ generate: () => Promise.reject(new Error('boom')) });
    await failing.request(snapshot(), 'a');
    await flush();

    const ignored = deferred();
    const timingOut = new PredictionController({ timeoutMs: 10, generate: () => ignored.promise });
    await timingOut.request(snapshot(), 'b');
    await delay(40);
    ignored.reject(new Error('late rejection after timeout'));

    const superseded = deferred();
    const switching = new PredictionController({ generate: () => superseded.promise });
    await switching.request(snapshot(), 'c');
    switching.update(snapshot({ sessionID: 's2', editor: { id: 'e2' } }));
    superseded.reject(new Error('late superseded rejection'));

    await flush();
    await delay(20);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(seen, []);
});

test('a throwing or rejecting onChange never breaks the controller', async () => {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    let calls = 0;
    const controller = new PredictionController({
      generate: () => Promise.resolve(text('x')),
      onChange: () => { calls += 1; throw new Error('sync subscriber'); },
    });
    await controller.request(snapshot(), 'a');
    await flush();
    assert.ok(calls > 0);

    const asyncController = new PredictionController({
      generate: () => Promise.resolve(text('x')),
      onChange: () => Promise.reject(new Error('async subscriber')),
    });
    asyncController.update(snapshot({ requestable: false }));
    await flush();
    await delay(20);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(seen, []);
});

test('dispose stops onChange callbacks even when state would change', async () => {
  let changes = 0;
  const controller = new PredictionController({
    generate: () => Promise.resolve(text('x')),
    onChange: () => { changes += 1; },
  });

  await controller.request(snapshot(), 'src-1');
  await flush();
  const before = changes;
  assert.ok(before > 0);

  controller.dispose();
  controller.update(snapshot());
  await controller.request(snapshot(), 'src-2', { manual: true });
  controller.dismiss();
  await flush();

  assert.equal(changes, before);
});
