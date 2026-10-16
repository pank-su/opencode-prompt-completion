#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'panksup.prompt-completion';
const FILES = [
    'package.json',
    'tui.tsx',
    'ghost.ts',
    'editor.mjs',
    'controller.mjs',
    'context.mjs',
    'prediction.mjs',
    'word.mjs',
    'README.md',
    'LICENSE'
];
const hash = (value) => createHash('sha256').update(value).digest('hex');

function packagePath(entry) {
    const value = typeof entry === 'string' ? entry : entry?.package;
    if (typeof value !== 'string' || value.startsWith('-')) return undefined;
    return value.startsWith('file://') ? fileURLToPath(value) : path.resolve(value);
}

export function installPromptCompletion({
    source = SOURCE,
    configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode'),
    apply = false
} = {}) {
    source = path.resolve(source);
    configDir = path.resolve(configDir);
    const cli = path.join(configDir, 'cli.json');
    if (fs.existsSync(cli) && fs.lstatSync(cli).isSymbolicLink())
        throw new Error('Symlinked cli.json requires explicit review; not replacing it');
    const before = fs.existsSync(cli) ? fs.readFileSync(cli, 'utf8') : '{}';
    const config = JSON.parse(before);
    if (config.plugins !== undefined && !Array.isArray(config.plugins))
        throw new Error('cli.json plugins must be an array');
    const contents = Object.fromEntries(FILES.map((name) => [name, fs.readFileSync(path.join(source, name))]));
    const pkg = JSON.parse(contents['package.json'].toString());
    if (pkg.name !== 'panksup-prompt-completion' || pkg.exports?.['./tui'] !== './tui.tsx')
        throw new Error('Unexpected prompt-completion package');
    const checksums = Object.fromEntries(FILES.map((name) => [name, hash(contents[name])]));
    const digest = hash(JSON.stringify(checksums)).slice(0, 16);
    const releases = path.join(configDir, 'tui-plugins', 'panksup-prompt-completion', 'releases');
    const runtime = path.join(releases, `${pkg.version}-${digest}`);
    const own = (entry) => {
        const value = packagePath(entry);
        return value === source || (value !== undefined && value.startsWith(releases + path.sep));
    };
    const previous = (config.plugins ?? []).find(own);
    const options = previous && typeof previous === 'object' ? previous.options : undefined;
    const plugins = (config.plugins ?? []).filter((entry) => !own(entry) && entry !== `-${ID}`);
    plugins.push(options ? { package: runtime, options } : runtime);
    const next = { ...config, plugins };
    const changed = JSON.stringify(config) !== JSON.stringify(next);
    const newRelease = !fs.existsSync(runtime);
    if (!newRelease) {
        if (fs.lstatSync(runtime).isSymbolicLink()) throw new Error('Runtime release is a symlink; not modifying it');
        for (const name of FILES) {
            if (
                !fs.existsSync(path.join(runtime, name)) ||
                hash(fs.readFileSync(path.join(runtime, name))) !== checksums[name]
            ) {
                throw new Error(`Runtime release was modified: ${name}; preserving it`);
            }
        }
    }
    const result = { apply, changed, newRelease, runtime };
    if (!apply || (!changed && !newRelease)) return result;

    let stage, pending;
    try {
        if (newRelease) {
            fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
            stage = path.join(releases, `.stage-${randomUUID()}`);
            fs.mkdirSync(stage, { mode: 0o700 });
            for (const name of FILES) fs.writeFileSync(path.join(stage, name), contents[name], { mode: 0o600 });
            fs.writeFileSync(
                path.join(stage, 'release.json'),
                JSON.stringify({ id: ID, digest, checksums }, null, 2) + '\n',
                { mode: 0o600 }
            );
            // The old release is never overwritten. Publish a whole new directory,
            // then switch cli.json once, so imports cannot mix controller versions.
            fs.renameSync(stage, runtime);
            stage = undefined;
        }
        if (changed) {
            fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
            if (fs.existsSync(cli) && fs.readFileSync(cli, 'utf8') !== before)
                throw new Error('cli.json changed during preparation; preserving newer edits');
            if (fs.existsSync(cli)) {
                const backup = path.join(
                    configDir,
                    `cli.json.before-prompt-release-${Date.now()}-${randomUUID().slice(0, 8)}.bak`
                );
                fs.writeFileSync(backup, before, { mode: 0o600 });
            }
            pending = path.join(configDir, `.cli.json-${randomUUID()}`);
            fs.writeFileSync(pending, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
            fs.renameSync(pending, cli);
            pending = undefined;
        }
    } finally {
        if (pending) fs.unlinkSync(pending);
        // Only discard the staging files created by this invocation, never a release.
        if (stage) {
            for (const name of [...FILES, 'release.json']) {
                const file = path.join(stage, name);
                if (fs.existsSync(file)) fs.unlinkSync(file);
            }
            fs.rmdirSync(stage);
        }
    }
    return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    let configDir,
        apply = false;
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--apply') apply = true;
        else if (args[index] === '--dry-run') apply = false;
        else if (args[index] === '--config-dir' && args[index + 1]) configDir = args[++index];
        else throw new Error(`Unknown argument: ${args[index]}`);
    }
    console.log(JSON.stringify(installPromptCompletion({ configDir, apply }), null, 2));
}
