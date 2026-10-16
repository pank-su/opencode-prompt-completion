import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PredictionScheduler } from '../src/opencode/scheduler.mjs';

function fixture(options = {}) {
  let now = 0, id = 0, unavailable = 0;
  let current = { sessionID: 's1', revision: 'r1', model: { id: 'fast' }, prefix: 'Check', requestable: true, context: '[]', running: false };
  const timers = new Map(), requests = [], failures = [];
  const controller = {
    needsRequest: true,
    update() {},
    async request(snapshot, source, requestOptions) {
      requests.push({ snapshot, source, ...requestOptions });
      controller.needsRequest = false;
      return true;
    },
  };
  const scheduler = new PredictionScheduler({
    options: { automatic: true, debounceMs: 500, cooldownMs: 1500, ...options },
    controller,
    snapshot: () => current,
    run: callback => callback(),
    onFailure: error => failures.push(error),
    onUnavailable: () => unavailable++,
    timer: {
      now: () => now,
      setTimeout(callback, delay) { const key = ++id; timers.set(key, { at: now + delay, callback }); return key; },
      clearTimeout(key) { timers.delete(key); },
    },
  });
  const tick = amount => {
    const end = now + amount;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    now = end;
  };
  return { scheduler, controller, requests, timers, failures, tick,
    update(changes) { current = { ...current, ...changes }; },
    schedule() { scheduler.schedule(current); },
    unavailable: () => unavailable,
  };
}

test('automatic scheduling debounces changed drafts but not repeated notifications', () => {
  const f = fixture();
  f.schedule(); f.tick(200); f.schedule(); f.tick(299);
  assert.equal(f.requests.length, 0);
  f.tick(1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].manual, false);
  f.controller.needsRequest = true;
  f.update({ prefix: 'Check new' }); f.schedule(); f.tick(300);
  f.update({ prefix: 'Check newer' }); f.schedule(); f.tick(1199);
  assert.equal(f.requests.length, 1);
  f.tick(1);
  assert.equal(f.requests[1].snapshot.prefix, 'Check newer');
});

test('expired timers recheck identity and controller eligibility', () => {
  for (const change of [{ sessionID: 's2' }, { prefix: 'Other' }, { revision: 'r2' }, { model: { id: 'other' } }]) {
    const f = fixture(); f.schedule(); f.update(change); f.tick(500);
    assert.equal(f.requests.length, 0);
  }
  const f = fixture(); f.schedule(); f.controller.needsRequest = false; f.tick(500);
  assert.equal(f.requests.length, 0);
});

test('short drafts and a running empty prompt do not request; completed context can prefetch', () => {
  for (const changes of [{ prefix: ' a ' }, { prefix: '', context: '[]' }, { prefix: '', context: '[{}]', running: true }, { requestable: false }]) {
    const f = fixture(); f.update(changes); f.schedule(); f.tick(1000);
    assert.equal(f.requests.length, 0);
  }
  const f = fixture(); f.update({ prefix: '', context: '[{}]' }); f.schedule(); f.tick(500);
  assert.equal(f.requests.length, 1);
});

test('manual mode is explicit, deferred for focus and deduplicates palette invocations', () => {
  const f = fixture({ automatic: false });
  f.schedule(); f.tick(1000); assert.equal(f.requests.length, 0);
  f.scheduler.requestManual('s1'); f.tick(50); f.scheduler.requestManual('s1'); f.tick(99);
  assert.equal(f.requests.length, 0);
  f.tick(1); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].manual, true);
});

test('manual request validates current session and prompt availability', () => {
  for (const changes of [{ sessionID: 's2' }, { requestable: false }]) {
    const f = fixture(); f.scheduler.requestManual('s1'); f.update(changes); f.tick(100);
    assert.equal(f.requests.length, 0); assert.equal(f.unavailable(), 1);
  }
});

test('cancel and dispose remove pending timers and disposal is idempotent', () => {
  const f = fixture(); f.schedule(); f.scheduler.cancelAutomatic(); f.tick(1000);
  assert.equal(f.requests.length, 0);
  f.schedule(); f.scheduler.requestManual('s1'); f.scheduler.dispose(); f.scheduler.dispose();
  f.schedule(); f.scheduler.requestManual('s1'); f.tick(1000);
  assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0);
});

test('request rejection is forwarded to the failure boundary', async () => {
  const f = fixture(); const error = new Error('failed');
  f.controller.request = async () => { throw error; };
  f.schedule(); f.tick(500); await Promise.resolve();
  assert.deepEqual(f.failures, [error]);
});
