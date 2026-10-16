# OpenCode Prompt Completion

An OpenCode V2 plugin that shows a grey continuation directly in the prompt
field. `Tab` accepts the whole continuation, `Option+→` on macOS or `Ctrl+→` on
Linux/Windows accepts the next word, and `Esc` hides the hint. Until you accept
it, the hint is not part of the prompt text, and messages are never sent
automatically.

**Automatic mode is on by default: drafts are sent to the selected model before
Enter and requests consume quota or paid tokens.** Set `automatic: false` for
manual-only requests; see [Configuration](#configuration).

## Requirements

- OpenCode V2 with the CLI plugin API. The adapter is built against OpenCode
  `2.0.27` and OpenTUI `0.5.17`; other versions need separate verification.
- A configured provider and an available model in OpenCode.
- A current OpenCode V2 CLI with `opencode plugin add`.

This is a CLI-only plugin: it attaches through the global `cli.json`, including
when you work with a remote server. OpenCode V1 is not supported.

## Installation

```sh
opencode plugin add github:pank-su/opencode-prompt-completion
```

OpenCode downloads the package and registers its CLI-only entry. No cloning,
separate installer, npm account or manual dependency installation is needed.
OpenCode supplies the host modules and manages package caching and updates.

You can also add the package directly to `~/.config/opencode/cli.json`
(or `$XDG_CONFIG_HOME/opencode/cli.json`):

```json
{
  "plugins": ["github:pank-su/opencode-prompt-completion"]
}
```

Merge the entry into your existing `plugins` array; do not replace other plugins.
Use `cli.json`, not `opencode.json`, so the plugin stays local with remote servers.
GitHub installation uses the repository; no npm release is required.

After installing, open a session, type at least three characters and leave the
cursor at the end. After a pause and a model response, grey text may appear. If
the plugin did not load into an already open TUI, restart the client.

When migrating from the old installer, replace its absolute-path plugin entry
with the GitHub package entry and carry over any `options`. Do not keep both
entries. Old release directories can remain on disk.

## Updating

```sh
opencode plugin check
opencode plugin update github:pank-su/opencode-prompt-completion
```

To pin a revision, append `#<full-commit-hash>` to the GitHub package specifier.
Pinned revisions are not updated automatically by `plugin update`.

## Controls

| Action | Keys |
| --- | --- |
| Accept the whole continuation | `Tab` |
| Accept the next word | `Option+→` on macOS, `Ctrl+→` on Linux/Windows |
| Alternative word acceptance on macOS | `Option+F`, for terminals that send `Esc+f` |
| Hide the shown hint | `Esc` |
| Request a hint manually | `<leader>j`, or the "Suggest or complete the prompt" command palette entry |
| Open diagnostics | The "Completion status" command palette entry |

`Enter` and `Shift+Tab` keep their usual behaviour. With matching input,
Backspace and word-wise acceptance reuse the cached suffix without a new request.
A word is the fragment up to the next space, including a leading separator and
punctuation.

## Configuration

For manual mode use an object instead of the string in `cli.json`:

```json
{
  "package": "github:pank-su/opencode-prompt-completion",
  "options": {
    "automatic": false,
    "typingDebounceMs": 500,
    "cooldownMs": 1500,
    "timeoutMs": 7000
  }
}
```

| Option | Default | Range |
| --- | --- | --- |
| `automatic` | `true` | `true` or `false` |
| `typingDebounceMs` | `500` | 100–5000 ms |
| `cooldownMs` | `1500` | 0–10000 ms |
| `timeoutMs` | `7000` | 1000–15000 ms |

By default the plugin uses the model from the prompt field with a supported
`minimal` or `low` variant. The session's selected model and variant are not
switched. The `predictionModel` option takes an object with `providerID`, `id`
and an optional `variant` of a model available to you.

### Disable

Remove the plugin with:

```sh
opencode plugin remove github:pank-su/opencode-prompt-completion
```

To disable it without removing its package entry, append
`"-panksup.prompt-completion"` after that entry in `plugins`.

## Data and limitations

- The plugin uses stateless `generate.text`, without creating sessions or
  calling tools.
- A request contains the draft and at most four recent user and assistant text
  messages. Tool output, reasoning, system instructions, images and file
  attachments are not added separately. Text already included in a normal
  message may still enter the context.
- The context is limited to 10000 UTF-16 units and the whole prompt to 13000
  UTF-16 units. Reduction keeps the JSON valid.
- The plugin keeps no log of drafts or responses. This is not a guarantee that
  OpenCode or the provider does not log. The plugin cache is in memory: up to 16
  contexts of 32 candidates each.
- At most one client request is in flight at a time. A timeout and cancellation
  do not guarantee that the provider stops generating and charging tokens.
- Commands (`/…`, `!…`), child sessions and drafts longer than 2000 UTF-16 units
  are not completed. The prompt needs focus, no selection and the cursor at the
  end.
- Losing focus, shell mode or an open autocomplete menu hides the hint. An
  incomplete reply from a running agent is not included in the context.
- `null`, an error or hiding with `Esc` never triggers automatic retries for the
  same draft. A prediction may be unavailable.

## Architecture

- `src/tui.tsx` — the plugin entry point.
- `src/prediction/` — the prediction core: controller, prompt and context
  building, word chunking.
- `src/editor/` — the editor adapter and the inline ghost renderer.
- `src/opencode/` — OpenCode integration: options, scheduler, commands and
  snapshot.

## Development

Requires Node.js `26.4.0+` and Bun `1.3.14`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`check` runs the Node tests, the renderer tests and TypeScript. The tests use a
stub model and the real native textarea and need no API keys. GitHub Actions is
configured for Ubuntu, macOS and Windows; the presence of a workflow does not
replace the result of an actual run, and runtime support on Linux and Windows is
not confirmed here.

## License

[MIT](LICENSE). The author of this implementation is
[pank-su](https://github.com/pank-su). This is an independent plugin, not an
official OpenCode component. OpenCode, OpenTUI and SolidJS retain their own
copyrights and licenses; their source and binaries are not vendored here.
