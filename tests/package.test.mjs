import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('public package metadata, license and allowlisted files are self-contained', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.2.6');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.author, 'pank-su');
  assert.equal(pkg.private, true);
  assert.match(pkg.repository.url, /github\.com\/pank-su\/opencode-prompt-completion\.git$/);
  assert.equal(pkg.exports['./tui'], './tui.ts');
  assert.equal(pkg.exports['.'], undefined, 'CLI-only plugin must not register a server entry');
  assert.deepEqual(pkg.files, ['tui.ts', 'src', 'README.md', 'LICENSE']);
  for (const file of pkg.files) {
    const resolved = path.resolve(root, file);
    assert.ok(resolved.startsWith(root + path.sep));
    assert.ok(fs.existsSync(resolved), file);
  }
  for (const version of Object.values(pkg.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 pank-su/);
  for (const file of ['bun.lock', 'tsconfig.json', '.github/workflows/ci.yml', 'tests/fixtures/theme.ts']) {
    assert.ok(fs.statSync(path.join(root, file)).isFile(), file);
  }
});

test('renderer peers cover both tested host versions; the host SDK is development-only', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.equal(pkg.peerDependencies['@opencode/plugin'], undefined, 'the host provides the SDK; keep it development-only');
  assert.ok(pkg.devDependencies['@opencode/plugin']);
  assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), ['@opentui/core', '@opentui/solid', 'solid-js']);
  for (const name of Object.keys(pkg.peerDependencies)) {
    assert.equal(pkg.peerDependencies[name], name === 'solid-js' ? '1.9.12' : '>=0.5.17 <0.7', name);
    assert.notEqual(pkg.peerDependenciesMeta?.[name]?.optional, true, name);
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) assert.equal(pkg.scripts[hook], undefined, hook);
});

test('local directory discovery and package loading share a root TUI entry', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(root, 'tui.ts')), 'OpenCode local discovery requires a root tui.ts');
  assert.equal(pkg.exports['./tui'], './tui.ts');
  assert.ok(pkg.files.includes('tui.ts'));
  const entry = fs.readFileSync(path.join(root, 'tui.ts'), 'utf8');
  assert.match(entry, /import\s*\{\s*setupPromptCompletion\s*\}\s*from\s*['"]\.\/src\/tui['"]/);
  assert.match(entry, /from ['"]@opentui\/core['"]/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/tui.ts'), 'utf8'), /^import (?!type).*from ['"](?:solid-js|@opentui\/core|@opencode\/plugin\/tui)['"]/m);
});

test('documentation is limited to English README and LICENSE with native install instructions', () => {
  assert.deepEqual(fs.readdirSync(root).filter(file => file.endsWith('.md')).sort(), ['README.md']);
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /[\u0400-\u04FF]/u);
  assert.match(readme, /opencode plugin add github:pank-su\/opencode-prompt-completion/);
  assert.doesNotMatch(readme, /scripts\/install\.mjs/);
  for (const link of readme.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    if (!link[1].includes('://')) assert.ok(fs.existsSync(path.join(root, link[1])), link[1]);
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
