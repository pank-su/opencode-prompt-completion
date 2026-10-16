export function nextWordChunk(suffix) {
  if (typeof suffix !== 'string') return '';
  // Keep the leading separator and punctuation attached to the word; do not
  // split paths, identifiers, emoji or combining-character sequences.
  return suffix.match(/^\s*\S+/u)?.[0] ?? '';
}
