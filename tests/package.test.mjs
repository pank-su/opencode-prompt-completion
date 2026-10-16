import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installPromptCompletion } from '../scripts/install.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const roots = new Set();
afterEach(() => {
  for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
  roots.clear();
});

function configDirectory() {
  const directory = fs.mkdtempSync(path.join(process.env.OPENCODE_TEST_TEMP || os.tmpdir(), 'completion-package-'));
  roots.add(directory);
  return directory;
}

test('public package metadata, license and allowlisted files are self-contained', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.2.3');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.author, 'pank-su');
  assert.equal(pkg.private, true);
  assert.match(pkg.repository.url, /github\.com\/pank-su\/opencode-prompt-completion\.git$/);
  assert.equal(pkg.exports['./tui'], './tui.tsx');
  for (const file of pkg.files) {
    const resolved = path.resolve(root, file);
    assert.ok(resolved.startsWith(root + path.sep));
    assert.ok(fs.statSync(resolved).isFile(), file);
  }
  for (const version of Object.values(pkg.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 pank-su/);
  for (const file of ['bun.lock', 'tsconfig.json', '.github/workflows/ci.yml', 'tests/fixtures/theme.ts']) {
    assert.ok(fs.statSync(path.join(root, file)).isFile(), file);
  }
});

test('lockfile has no private registry or machine-local dependency URLs', () => {
  const lock = fs.readFileSync(path.join(root, 'bun.lock'), 'utf8');
  assert.doesNotMatch(lock, /"(?:file:|link:|workspace:)/);
  for (const match of lock.matchAll(/https?:\/\/[^"\s]+/g)) {
    const url = new URL(match[0]);
    assert.ok(url.protocol === 'https:' && url.hostname === 'registry.npmjs.org'
      && !url.username && !url.password, 'lockfile URLs must use the public npm registry without credentials');
  }
});

test('real package installs a complete immutable release without developer dependencies', () => {
  const configDir = configDirectory();
  const before = { theme: { name: 'github' }, tabs: { mode: 'off' }, plugins: ['/other/plugin'] };
  fs.writeFileSync(path.join(configDir, 'cli.json'), JSON.stringify(before));
  const result = installPromptCompletion({ configDir, apply: true });
  assert.equal(result.newRelease, true);
  const config = JSON.parse(fs.readFileSync(path.join(configDir, 'cli.json'), 'utf8'));
  assert.deepEqual(config, { ...before, plugins: [...before.plugins, result.runtime] });
  const release = JSON.parse(fs.readFileSync(path.join(result.runtime, 'release.json'), 'utf8'));
  assert.equal(release.id, 'panksup.prompt-completion');
  for (const file of Object.keys(release.checksums)) {
    assert.deepEqual(fs.readFileSync(path.join(result.runtime, file)), fs.readFileSync(path.join(root, file)));
  }
  assert.ok(fs.existsSync(path.join(result.runtime, 'LICENSE')));
  assert.equal(fs.existsSync(path.join(result.runtime, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(result.runtime, 'tests')), false);
  assert.equal(installPromptCompletion({ configDir, apply: true }).changed, false);
});

test('documented installer CLI dry run does not create config or release files', () => {
  const configDir = configDirectory();
  const output = spawnSync(process.execPath, [path.join(root, 'scripts/install.mjs'), '--dry-run', '--config-dir', configDir], {
    encoding: 'utf8',
    cwd: root,
  });
  assert.equal(output.status, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.apply, false);
  assert.equal(result.newRelease, true);
  assert.equal(fs.existsSync(result.runtime), false);
  assert.deepEqual(fs.readdirSync(configDir), []);
});
