import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionStatus } from '../src/opencode/diagnostics.mjs';

const snapshot = {
  presentable: true,
  requestable: true,
  model: { providerID: 'openai', id: 'fast', variant: 'high' },
  context: 'user: hello',
};

test('completion status is a complete English report', () => {
  const report = completionStatus({
    automatic: true,
    broken: false,
    state: { status: 'ready', suggestion: 'PRIVATE_SUGGESTION' },
    stats: { requests: 3, cacheHits: 1, errors: 0, latencyMs: 120 },
    snapshot,
    timeoutMs: 7000,
  });
  assert.equal(
    report,
    [
      'Mode: automatic',
      'State: ready',
      'Prompt: available · requests: available',
      'Model: openai/fast · high',
      'Requests: 3 · cache: 1 · errors: 0',
      'Last latency: 120 ms · context: 11 UTF-16 units',
      'Timeout: 7000 ms',
    ].join('\n')
  );
  assert.doesNotMatch(report, /[\u0400-\u04FF]/);
  assert.equal(report.includes('PRIVATE_SUGGESTION'), false);
});

test('mode reflects manual and stopped-after-error states', () => {
  const base = { state: { status: 'idle' }, stats: {}, snapshot, timeoutMs: 7000 };
  assert.match(completionStatus({ ...base, automatic: false }), /^Mode: manual$/m);
  assert.match(completionStatus({ ...base, automatic: true, broken: true }), /^Mode: stopped after an error$/m);
});

test('the sanitized controller error and its reason are surfaced', () => {
  const report = completionStatus({
    automatic: true,
    broken: false,
    state: { status: 'error', reason: 'request-failed', error: 'Prediction request failed.' },
    stats: { requests: 1, cacheHits: 0, errors: 1, latencyMs: 30 },
    snapshot,
    timeoutMs: 7000,
  });
  assert.match(report, /^State: error$/m);
  assert.match(report, /^Reason: request-failed$/m);
  assert.match(report, /^Error: Prediction request failed\.$/m);
  assert.match(report, /^Timeout: 7000 ms$/m);
});

test('a timeout surfaces the sanitized reason, message and configured limit', () => {
  const report = completionStatus({
    automatic: false,
    broken: false,
    state: { status: 'error', reason: 'request-timeout', error: 'Prediction timed out. Try again or increase timeoutMs.' },
    stats: { requests: 2, cacheHits: 0, errors: 1, latencyMs: 15000 },
    snapshot,
    timeoutMs: 15000,
  });
  assert.match(report, /^Mode: manual$/m);
  assert.match(report, /^Reason: request-timeout$/m);
  assert.match(report, /^Error: Prediction timed out\. Try again or increase timeoutMs\.$/m);
  assert.match(report, /^Timeout: 15000 ms$/m);
});

test('a reason without an error is still reported', () => {
  const report = completionStatus({
    automatic: true,
    broken: false,
    state: { status: 'none', reason: 'ineligible' },
    stats: {},
    snapshot: { presentable: false, requestable: false, model: null, context: '' },
    timeoutMs: 7000,
  });
  assert.match(report, /^State: none$/m);
  assert.match(report, /^Reason: ineligible$/m);
  assert.equal(/^Error:/m.test(report), false);
});

test('no prefix, suggestion or context body ever reaches the report', () => {
  const report = completionStatus({
    automatic: true,
    broken: true,
    state: {
      status: 'error',
      reason: 'invalid-response',
      error: 'Prediction request failed.',
      prefix: 'SECRET_PREFIX',
      suggestion: 'SECRET_SUGGESTION',
    },
    stats: { requests: 1, cacheHits: 0, errors: 1, latencyMs: 0 },
    snapshot: {
      presentable: false,
      requestable: false,
      model: null,
      prefix: 'SECRET_PREFIX',
      context: 'SECRET_CONTEXT_BODY',
    },
    timeoutMs: 7000,
  });
  for (const secret of ['SECRET_PREFIX', 'SECRET_SUGGESTION', 'SECRET_CONTEXT_BODY']) {
    assert.equal(report.includes(secret), false, secret);
  }
  assert.match(report, /^Mode: stopped after an error$/m);
  assert.match(report, /^Prompt: hidden · requests: blocked$/m);
  assert.match(report, /^Model: not selected$/m);
  assert.match(report, /^Last latency: 0 ms · context: 19 UTF-16 units$/m);
});

test('missing state, stats and snapshot degrade to explicit English defaults', () => {
  const report = completionStatus({ automatic: true, broken: false, timeoutMs: 7000 });
  assert.match(report, /^State: idle$/m);
  assert.match(report, /^Prompt: hidden · requests: blocked$/m);
  assert.match(report, /^Model: not selected$/m);
  assert.match(report, /^Requests: 0 · cache: 0 · errors: 0$/m);
  assert.match(report, /^Last latency: — ms · context: 0 UTF-16 units$/m);
  assert.equal(/^Reason:/m.test(report), false);
  assert.equal(/^Error:/m.test(report), false);
});
