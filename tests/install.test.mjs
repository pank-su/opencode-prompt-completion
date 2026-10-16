import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installPromptCompletion } from '../scripts/install.mjs';

const tempRoot = process.env.OPENCODE_TEST_TEMP || os.tmpdir();
const roots = new Set();
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.existsSync(tempRoot) ? tempRoot : os.tmpdir(), 'prompt-install-'));
  roots.add(root);
  const source = path.join(root, 'source');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(source); fs.mkdirSync(configDir);
  const files = ['tui.tsx', 'ghost.ts', 'editor.mjs', 'controller.mjs', 'context.mjs', 'prediction.mjs', 'word.mjs', 'README.md', 'LICENSE'];
  for (const name of files) fs.writeFileSync(path.join(source, name), `fixture ${name}\n`);
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'panksup-prompt-completion', version: '0.2.0', exports: { './tui': './tui.tsx' } }));
  const config = { plugins: ['/another/plugin', '-panksup.prompt-completion'], theme: { name: 'github' }, keybinds: { 'diff.open': 'none' } };
  fs.writeFileSync(path.join(configDir, 'cli.json'), JSON.stringify(config));
  return { source, configDir, config };
}

test('dry run makes no changes and points to a complete immutable release', () => {
  const f = fixture();
  const result = installPromptCompletion(f);
  assert.equal(result.apply, false);
  assert.equal(fs.existsSync(result.runtime), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.configDir, 'cli.json'))), f.config);
});

test('installation preserves unrelated config, removes only own disable directive, and is idempotent', () => {
  const f = fixture();
  const first = installPromptCompletion({ ...f, apply: true });
  const config = JSON.parse(fs.readFileSync(path.join(f.configDir, 'cli.json')));
  assert.deepEqual(config, { ...f.config, plugins: ['/another/plugin', first.runtime] });
  assert.equal(fs.readFileSync(path.join(first.runtime, 'controller.mjs'), 'utf8'), 'fixture controller.mjs\n');
  assert.ok(fs.existsSync(path.join(first.runtime, 'release.json')));
  const second = installPromptCompletion({ ...f, apply: true });
  assert.equal(second.changed, false);
  assert.equal(second.newRelease, false);
});

test('updating publishes a different complete directory and leaves the loaded release untouched', () => {
  const f = fixture();
  const first = installPromptCompletion({ ...f, apply: true });
  fs.writeFileSync(path.join(f.source, 'controller.mjs'), 'new controller\n');
  fs.writeFileSync(path.join(f.source, 'tui.tsx'), 'new compatible TUI\n');
  const second = installPromptCompletion({ ...f, apply: true });
  assert.notEqual(first.runtime, second.runtime);
  assert.equal(fs.readFileSync(path.join(first.runtime, 'controller.mjs'), 'utf8'), 'fixture controller.mjs\n');
  assert.equal(fs.readFileSync(path.join(second.runtime, 'controller.mjs'), 'utf8'), 'new controller\n');
  assert.equal(fs.readFileSync(path.join(second.runtime, 'tui.tsx'), 'utf8'), 'new compatible TUI\n');
  const config = JSON.parse(fs.readFileSync(path.join(f.configDir, 'cli.json')));
  assert.deepEqual(config.plugins, ['/another/plugin', second.runtime]);
});

test('existing plugin options are preserved across a release update', () => {
  const f = fixture();
  const first = installPromptCompletion({ ...f, apply: true });
  fs.writeFileSync(path.join(f.configDir, 'cli.json'), JSON.stringify({ ...f.config,
    plugins: ['/another/plugin', { package: first.runtime, options: { automatic: false, typingDebounceMs: 900 } }] }));
  fs.writeFileSync(path.join(f.source, 'controller.mjs'), 'next\n');
  const next = installPromptCompletion({ ...f, apply: true });
  const config = JSON.parse(fs.readFileSync(path.join(f.configDir, 'cli.json')));
  assert.deepEqual(config.plugins[1], { package: next.runtime, options: { automatic: false, typingDebounceMs: 900 } });
});

test('modified runtime release is never overwritten or discarded', () => {
  const f = fixture();
  const first = installPromptCompletion({ ...f, apply: true });
  fs.writeFileSync(path.join(first.runtime, 'controller.mjs'), 'user edit');
  assert.throws(() => installPromptCompletion({ ...f, apply: true }), /was modified/);
  assert.equal(fs.readFileSync(path.join(first.runtime, 'controller.mjs'), 'utf8'), 'user edit');
});
