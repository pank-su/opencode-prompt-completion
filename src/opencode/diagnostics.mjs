function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function modelLabel(model) {
  if (model == null || typeof model !== 'object') return 'not selected';
  const provider = text(model.providerID);
  const id = text(model.id);
  if (provider == null || id == null) return 'not selected';
  return `${provider}/${id} · ${text(model.variant) ?? 'default'}`;
}

/**
 * Build the English-only body of the Completion status dialog.
 *
 * Pure formatter: it reads availability flags, the prediction model, counter
 * metadata and lengths only. A prompt prefix, a suggestion or the assembled
 * context body therefore cannot leak into the report, and the only
 * controller-provided text surfaced is the sanitized reason/error label.
 *
 * @param {{
 *   automatic?: boolean,
 *   broken?: boolean,
 *   state?: {status?: string, reason?: string, error?: string},
 *   stats?: {requests?: number, cacheHits?: number, errors?: number, latencyMs?: number|null},
 *   snapshot?: {presentable?: boolean, requestable?: boolean, model?: object|null, context?: string},
 *   timeoutMs?: number,
 * }} input
 * @returns {string}
 */
export function completionStatus({ automatic, broken, state, stats, snapshot, timeoutMs } = {}) {
  const current = state ?? {};
  const counters = stats ?? {};
  const lines = [
    `Mode: ${broken ? 'stopped after an error' : automatic === false ? 'manual' : 'automatic'}`,
    `State: ${broken ? 'error' : text(current.status) ?? 'idle'}`,
  ];
  const reason = broken ? 'ui-runtime-error' : text(current.reason);
  if (reason != null) lines.push(`Reason: ${reason}`);
  const error = broken ? 'The completion UI stopped after an error.' : text(current.error);
  if (error != null) lines.push(`Error: ${error}`);
  lines.push(
    `Prompt: ${snapshot?.presentable ? 'available' : 'hidden'} · requests: ${snapshot?.requestable ? 'available' : 'blocked'}`,
    `Model: ${modelLabel(snapshot?.model)}`,
    `Requests: ${counters.requests ?? 0} · cache: ${counters.cacheHits ?? 0} · errors: ${counters.errors ?? 0}`,
    `Last latency: ${counters.latencyMs ?? '—'} ms · context: ${snapshot?.context?.length ?? 0} UTF-16 units`,
    `Timeout: ${timeoutMs} ms`,
  );
  return lines.join('\n');
}
