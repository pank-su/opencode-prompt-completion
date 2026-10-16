function milliseconds(value, fallback, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

export function readOptions(options) {
  return {
    automatic: options.automatic !== false,
    debounceMs: milliseconds(options.typingDebounceMs, 500, 100, 5000),
    cooldownMs: milliseconds(options.cooldownMs, 1500, 0, 10000),
    timeoutMs: milliseconds(options.timeoutMs, 7000, 1000, 15000),
  };
}

export function predictionModel(context) {
  const configured = context.options.predictionModel;
  if (configured && typeof configured === 'object') {
    if (configured.providerID && configured.id) {
      return { providerID: configured.providerID, id: configured.id, variant: configured.variant };
    }
    return undefined;
  }
  const selected = context.ui.model.current();
  if (!selected) return undefined;
  const variants = context.ui.model.variant.list();
  const variant = ['minimal', 'low'].find(value => variants.includes(value));
  return { providerID: selected.providerID, id: selected.modelID, variant };
}
