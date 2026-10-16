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

// OpenCode config selectors use provider/model#variant or {providerID, model}.
// generate.text expects the same selection normalized to {providerID, id}.
function modelReference(selection) {
  let providerID, id, variant;
  if (typeof selection === 'string') {
    const separator = selection.indexOf('/');
    if (separator < 1) return undefined;
    const variantStart = selection.indexOf('#', separator + 1);
    providerID = selection.slice(0, separator);
    id = selection.slice(separator + 1, variantStart < 0 ? undefined : variantStart);
    variant = variantStart < 0 ? undefined : selection.slice(variantStart + 1);
  } else if (selection && typeof selection === 'object' && !Array.isArray(selection)) {
    providerID = selection.providerID;
    // Keep the original plugin shape compatible, but prefer OpenCode's field.
    id = Object.hasOwn(selection, 'model') ? selection.model : selection.id;
    variant = selection.variant;
  }
  if (typeof providerID !== 'string' || !providerID || providerID.includes('/') || providerID.includes('#')) return undefined;
  if (typeof id !== 'string' || !id || id.includes('#')) return undefined;
  if (variant !== undefined && (typeof variant !== 'string' || !variant || variant.includes('#'))) return undefined;
  return { providerID, id, variant };
}

export function predictionModel(context) {
  const configured = context.options.predictionModel;
  if (configured != null) return modelReference(configured);
  const selected = context.ui.model.current();
  if (!selected) return undefined;
  const variants = context.ui.model.variant.list();
  const variant = ['minimal', 'low'].find(value => variants.includes(value));
  return { providerID: selected.providerID, id: selected.modelID, variant };
}
