import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextWordChunk } from '../src/prediction/word.mjs';

test('accepts the next word with its leading space and punctuation', () => {
  assert.equal(nextWordChunk(' изменения, затем тесты'), ' изменения,');
  assert.equal(nextWordChunk('тов и тесты'), 'тов');
  assert.equal(nextWordChunk('  unit-тесты для Foo.kt'), '  unit-тесты');
});

test('does not split identifiers, paths, emoji or combining marks', () => {
  assert.equal(nextWordChunk(' Foo.kt и Bar.kt'), ' Foo.kt');
  assert.equal(nextWordChunk(' src/main/Foo.kt затем тесты'), ' src/main/Foo.kt');
  assert.equal(nextWordChunk(' 🧪 затем тесты'), ' 🧪');
  assert.equal(nextWordChunk(' е́ далее'), ' е́');
});

test('blank or missing suffix does not insert separators alone', () => {
  for (const value of ['', ' ', '   ', undefined, null]) assert.equal(nextWordChunk(value), '');
});
