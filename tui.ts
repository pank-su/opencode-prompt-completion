import { Plugin, usePlugin } from '@opencode/plugin/tui';
import { Renderable, Yoga } from '@opentui/core';
import { createEffect, createSignal, untrack } from 'solid-js';
import { setupPromptCompletion } from './src/tui';
import { PLUGIN_ID } from './src/identity.mjs';

// Resolve host-owned modules at the entry point so nested modules share
// OpenCode's renderer and reactive owner instead of loading installed copies.
export default Plugin.define({
    id: PLUGIN_ID,
    setup: (context) => setupPromptCompletion(context, {
        Renderable, Yoga, createEffect, createSignal, usePlugin,
        renderObserver: (observer) => untrack(observer),
    }),
});
