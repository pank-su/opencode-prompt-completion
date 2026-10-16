import { makePredictionPrompt, parsePrediction } from './prompt.mjs';

const MAX_ATTEMPTS = 200;
const TIMEOUT = Symbol('prediction-timeout');
const CANCELLED = Symbol('prediction-cancelled');
const TIMEOUT_ERROR = 'Prediction timed out. Try again or increase timeoutMs.';
const FAILURE_ERROR = 'Prediction request failed.';
const RESPONSE_ERROR = 'The model returned an invalid completion.';

/** @typedef {{providerID: string, id: string, variant?: string}} PredictionModel */

function isModel(model) {
  return model != null
    && typeof model.providerID === 'string' && model.providerID.length > 0
    && typeof model.id === 'string' && model.id.length > 0;
}

function modelKey(model) {
  if (!isModel(model)) return null;
  const variant = typeof model.variant === 'string' && model.variant.length > 0 ? model.variant : '';
  return `${model.providerID}\u0000${model.id}\u0000${variant}`;
}

// Cache scope: session + completed-context revision + model. An editor swap does
// not change the scope, and a draft edit never does.
function scopeKey(snapshot) {
  if (snapshot == null || snapshot.sessionID == null) return null;
  const key = modelKey(snapshot.model);
  if (key == null) return null;
  return `${String(snapshot.sessionID)}\u0000${snapshot.revision}\u0000${key}`;
}

function hasIdentity(snapshot) {
  return snapshot != null && snapshot.sessionID != null && snapshot.editor != null && isModel(snapshot.model);
}

function normalize(snapshot) {
  if (snapshot == null || typeof snapshot !== 'object') return null;
  return {
    sessionID: snapshot.sessionID ?? null,
    editor: snapshot.editor ?? null,
    prefix: typeof snapshot.prefix === 'string' ? snapshot.prefix : '',
    presentable: snapshot.presentable === true,
    requestable: snapshot.requestable === true,
    revision: typeof snapshot.revision === 'string' ? snapshot.revision : '',
    model: isModel(snapshot.model)
      ? {
        providerID: snapshot.model.providerID,
        id: snapshot.model.id,
        ...(typeof snapshot.model.variant === 'string' ? { variant: snapshot.model.variant } : {}),
      }
      : null,
    context: typeof snapshot.context === 'string' ? snapshot.context : '',
  };
}

function sameState(a, b) {
  return a.status === b.status
    && a.sessionID === b.sessionID
    && a.prefix === b.prefix
    && a.suggestion === b.suggestion
    && a.reason === b.reason
    && a.error === b.error;
}

/**
 * Holds the prediction state for the focused prompt. Completed full candidates
 * are cached per session/revision/model scope, so matching typing and backspace
 * reuse a cached suffix without a new generation. Requests are bounded to one
 * in flight, built from the recent conversation context supplied by the caller.
 */
export class PredictionController {
  #generate;
  #onChange;
  #timeoutMs;
  #automatic;
  #maxContexts;
  #now;
  /** @type {{status: string, sessionID?: string|null, prefix?: string, suggestion?: string, reason?: string, error?: string}} */
  #state = { status: 'idle' };
  #snapshot = null;
  /** @type {Map<string, {candidates: string[], attempts: Set<string>, dismissed: Set<string>, none: Set<string>, mismatches: Set<string>, errors: Map<string, {message: string, reason: string}>}>} */
  #contexts = new Map();
  #inflight = null;
  #abortController = null;
  #timer = null;
  #cancelWait = null;
  #token = 0;
  #disposed = false;
  #requests = 0;
  #cacheHits = 0;
  #cancelled = 0;
  #errors = 0;
  #latencyMs = null;

  /**
   * @param {{
   *   generate: (request: {model: PredictionModel, prefix: string, context: string, prompt: string}, options: {signal: AbortSignal}) => Promise<{text: string}>,
   *   onChange?: (state: object) => void,
   *   timeoutMs?: number,
   *   automatic?: boolean,
   *   maxContexts?: number,
   *   now?: () => number,
   * }} options
   */
  constructor({ generate, onChange = () => {}, timeoutMs = 7000, automatic = true, maxContexts = 16, now = Date.now } = {}) {
    if (typeof generate !== 'function') throw new TypeError('generate must be a function');
    this.#generate = generate;
    this.#onChange = onChange;
    this.#timeoutMs = timeoutMs;
    this.#automatic = automatic;
    this.#maxContexts = Number.isInteger(maxContexts) && maxContexts > 0 ? maxContexts : 16;
    this.#now = typeof now === 'function' ? now : Date.now;
  }

  get state() {
    return { ...this.#state };
  }

  /** Metadata counters only, never any prefix, suggestion or context text. */
  get diagnostics() {
    return {
      requests: this.#requests,
      cacheHits: this.#cacheHits,
      cancelled: this.#cancelled,
      errors: this.#errors,
      latencyMs: this.#latencyMs,
    };
  }

  /**
   * True when the UI should debounce-and-request: a requestable snapshot with a
   * valid identity/model, no in-flight work, no compatible cached full candidate
   * (an exact candidate means the draft is already complete) and no attempt yet
   * recorded for this scope+prefix. Dismissed prefixes never request again.
   */
  get needsRequest() {
    if (this.#disposed) return false;
    const snapshot = this.#snapshot;
    if (snapshot == null || !snapshot.requestable || !hasIdentity(snapshot)) return false;
    const scope = scopeKey(snapshot);
    if (scope == null) return false;
    if (this.#inflight != null) return false;
    const ctx = this.#contexts.get(scope);
    if (ctx == null) return true;
    const prefix = snapshot.prefix;
    if (ctx.dismissed.has(prefix)) return false;
    if (ctx.attempts.has(prefix)) return false;
    if (this.#hasCompatible(ctx, prefix)) return false;
    return true;
  }

  /** Store the latest editor snapshot and refresh the projection. */
  update(snapshot) {
    const next = normalize(snapshot);
    const prev = this.#snapshot;
    const prevScope = scopeKey(prev);
    const nextScope = scopeKey(next);
    this.#snapshot = next;
    if (nextScope != null) this.#touch(nextScope);

    if (prevScope !== nextScope) {
      // A new scope cancels in-flight work and projects the new scope cache.
      this.#cancelInflight();
    } else if (nextScope != null && prev != null && next != null && prev.prefix !== next.prefix) {
      const ctx = this.#contexts.get(nextScope);
      if (ctx != null && this.#hasCompatible(ctx, next.prefix)) this.#cacheHits += 1;
    }
    this.#render();
  }

  /**
   * Start a prediction when the snapshot requests it. Returns true when a
   * request was accepted, false otherwise. Automatic requests obey the
   * automatic flag and the scope+prefix dedup; manual requests may retry a
   * failed, null or dismissed prefix but never spawn concurrent work.
   */
  async request(snapshot, sourceID, { manual = false } = {}) {
    if (snapshot !== undefined) this.update(snapshot);
    if (this.#disposed) return false;

    const current = this.#snapshot;
    if (current == null || !current.requestable || !hasIdentity(current)) return false;
    const scope = scopeKey(current);
    if (scope == null) return false;
    if (this.#inflight != null) return false;
    if (!manual && !this.#automatic) return false;

    const ctx = this.#context(scope);
    const prefix = current.prefix;
    if (!manual) {
      if (ctx.dismissed.has(prefix)) return false;
      if (ctx.attempts.has(prefix)) return false;
      if (this.#hasCompatible(ctx, prefix)) return false;
    }

    this.#remember(ctx.attempts, prefix);
    ctx.dismissed.delete(prefix);
    ctx.errors.delete(prefix);
    ctx.none.delete(prefix);
    ctx.mismatches.delete(prefix);
    this.#start(current, scope, prefix);
    return true;
  }

  /** Dismiss the current scope+prefix, cancel in-flight work and keep the cache. */
  dismiss() {
    const snapshot = this.#snapshot;
    const scope = scopeKey(snapshot);
    this.#cancelInflight();
    if (snapshot != null && scope != null) {
      const ctx = this.#context(scope);
      this.#remember(ctx.dismissed, snapshot.prefix);
    }
    this.#render();
  }

  /** Clear the active scope cache and attempts, and cancel in-flight work. */
  invalidate() {
    const scope = scopeKey(this.#snapshot);
    this.#cancelInflight();
    if (scope != null) this.#contexts.delete(scope);
    this.#render();
  }

  /** Stop all callbacks. */
  dispose() {
    this.#disposed = true;
    this.#cancelInflight();
  }

  #start(snapshot, scope, prefix) {
    const token = ++this.#token;
    const controller = new AbortController();
    const startedAt = this.#now();
    this.#inflight = { token, scopeKey: scope, prefix };
    this.#abortController = controller;
    this.#requests += 1;
    this.#setState({ status: 'loading', sessionID: snapshot.sessionID, prefix });

    const prompt = makePredictionPrompt(prefix, snapshot.context);
    const request = { model: snapshot.model, prefix, context: snapshot.context, prompt };
    let generation;
    try {
      generation = Promise.resolve(this.#generate(request, { signal: controller.signal }));
    } catch (error) {
      generation = Promise.reject(error);
    }

    const timer = new Promise((resolve) => {
      this.#timer = setTimeout(() => {
        // Settle the timeout before abort can synchronously reject the client request.
        resolve(TIMEOUT);
        controller.abort();
      }, this.#timeoutMs);
    });
    const cancellation = new Promise(resolve => { this.#cancelWait = () => resolve(CANCELLED); });
    void this.#run(token, generation, timer, cancellation, scope, prefix, startedAt);
  }

  async #run(token, generation, timer, cancellation, scope, requestedPrefix, startedAt) {
    let outcome;
    let failure = false;
    try {
      outcome = await Promise.race([generation, timer, cancellation]);
    } catch {
      failure = true;
      outcome = undefined;
    }

    // Superseded by a newer scope/request: never touch the newer request state.
    if (token !== this.#token) return;

    this.#clearTimer();
    this.#abortController = null;
    this.#cancelWait = null;
    this.#inflight = null;
    this.#latencyMs = Math.max(0, this.#now() - startedAt);

    if (outcome === CANCELLED) return;

    if (failure || outcome === TIMEOUT) {
      this.#fail(scope, requestedPrefix,
        outcome === TIMEOUT ? TIMEOUT_ERROR : FAILURE_ERROR,
        outcome === TIMEOUT ? 'request-timeout' : 'request-failed');
      return;
    }

    const text = outcome != null && typeof outcome.text === 'string' ? outcome.text : '';
    let suggestion;
    try {
      suggestion = parsePrediction(text, { continuation: requestedPrefix.length > 0 });
    } catch {
      this.#fail(scope, requestedPrefix, RESPONSE_ERROR, 'invalid-response');
      return;
    }

    if (suggestion == null) {
      const ctx = this.#context(scope);
      this.#remember(ctx.none, requestedPrefix);
      this.#render();
      return;
    }

    // A "suffix" that repeats the whole requested draft would duplicate it.
    if (requestedPrefix.length > 0 && suggestion.startsWith(requestedPrefix)) {
      this.#fail(scope, requestedPrefix, RESPONSE_ERROR, 'repeated-draft');
      return;
    }

    const candidate = requestedPrefix + suggestion;
    const ctx = this.#context(scope);
    if (!ctx.candidates.includes(candidate)) ctx.candidates.push(candidate);
    while (ctx.candidates.length > 32) ctx.candidates.shift();
    const latest = this.#snapshot;
    if (latest != null && scopeKey(latest) === scope && !candidate.startsWith(latest.prefix)) {
      this.#remember(ctx.mismatches, latest.prefix);
    }
    this.#render();
  }

  #fail(scope, prefix, message, reason) {
    const ctx = this.#context(scope);
    if (!ctx.errors.has(prefix)) ctx.errors.set(prefix, { message, reason });
    while (ctx.errors.size > MAX_ATTEMPTS) ctx.errors.delete(ctx.errors.keys().next().value);
    this.#errors += 1;
    this.#render();
  }

  #resolve() {
    const snapshot = this.#snapshot;
    if (snapshot == null) return { status: 'idle' };
    const base = { sessionID: snapshot.sessionID, prefix: snapshot.prefix };
    const scope = scopeKey(snapshot);
    if (scope == null) return { status: 'none', ...base, reason: 'ineligible' };

    const ctx = this.#contexts.get(scope);
    if (ctx != null) {
      const prefix = snapshot.prefix;
      if (ctx.dismissed.has(prefix)) return { status: 'dismissed', ...base };
      const match = this.#matchCandidate(ctx, prefix);
      if (match != null) {
        if (snapshot.presentable) return { status: 'ready', ...base, suggestion: match.slice(prefix.length) };
        return { status: 'none', ...base, reason: 'hidden' };
      }
      if (ctx.candidates.includes(prefix)) return { status: 'none', ...base, reason: 'complete' };
      const failure = ctx.errors.get(prefix);
      if (failure) return { status: 'error', ...base, error: failure.message, reason: failure.reason };
      if (ctx.mismatches.has(prefix)) return { status: 'none', ...base, reason: 'prefix-mismatch' };
      if (ctx.none.has(prefix)) return { status: 'none', ...base, reason: 'no-suggestion' };
    }

    if (this.#inflight != null && this.#inflight.scopeKey === scope) {
      return { status: 'loading', ...base };
    }
    if (!snapshot.requestable || !hasIdentity(snapshot)) {
      return { status: 'none', ...base, reason: 'ineligible' };
    }
    return { status: 'idle' };
  }

  #render() {
    this.#setState(this.#resolve());
  }

  #hasCompatible(ctx, prefix) {
    for (const candidate of ctx.candidates) {
      if (candidate.startsWith(prefix)) return true;
    }
    return false;
  }

  #matchCandidate(ctx, prefix) {
    let best = null;
    for (const candidate of ctx.candidates) {
      if (candidate.length > prefix.length && candidate.startsWith(prefix)) {
        if (best == null || candidate.length > best.length) best = candidate;
      }
    }
    return best;
  }

  #context(scope) {
    let ctx = this.#contexts.get(scope);
    if (ctx == null) {
      ctx = {
        candidates: [],
        attempts: new Set(),
        dismissed: new Set(),
        none: new Set(),
        mismatches: new Set(),
        errors: new Map(),
      };
      this.#contexts.set(scope, ctx);
      this.#prune();
    } else {
      this.#touch(scope);
    }
    return ctx;
  }

  #touch(scope) {
    const ctx = this.#contexts.get(scope);
    if (ctx == null) return;
    this.#contexts.delete(scope);
    this.#contexts.set(scope, ctx);
  }

  #prune() {
    while (this.#contexts.size > this.#maxContexts) {
      const oldest = this.#contexts.keys().next().value;
      this.#contexts.delete(oldest);
    }
  }

  #remember(set, value) {
    if (set.has(value)) set.delete(value);
    set.add(value);
    while (set.size > MAX_ATTEMPTS) set.delete(set.values().next().value);
  }

  #cancelInflight() {
    this.#token += 1;
    this.#cancelWait?.();
    this.#cancelWait = null;
    if (this.#abortController != null) {
      this.#abortController.abort();
      this.#abortController = null;
    }
    this.#clearTimer();
    if (this.#inflight != null) {
      this.#inflight = null;
      this.#cancelled += 1;
    }
  }

  #clearTimer() {
    if (this.#timer != null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #setState(next) {
    if (sameState(this.#state, next)) return;
    this.#state = next;
    if (this.#disposed) return;
    try {
      const result = this.#onChange({ ...next });
      if (result != null && typeof result.then === 'function') result.then(undefined, () => {});
    } catch {
      // A subscriber error must never break the controller or leak a rejection.
    }
  }
}
