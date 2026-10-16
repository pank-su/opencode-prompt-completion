import type { Plugin } from '@opencode/plugin/tui';
import { focusedPrompt } from '../editor/adapter.mjs';
import { PLUGIN_ID } from '../identity.mjs';

type KeyEvent = { preventDefault(): void; stopPropagation(): void };

interface PromptActions {
    revision(): number;
    canAccept(): boolean;
    canDismiss(): boolean;
    accept(byWord: boolean, event?: KeyEvent): void | false;
    dismiss(event?: KeyEvent): void;
}

export function registerPromptCommands(context: Plugin.Context, actions: PromptActions) {
    context.keymap.layer(() => ({
        target: () => {
            actions.revision();
            return focusedPrompt(context.renderer);
        },
        priority: 10,
        commands: [
            {
                id: `${PLUGIN_ID}.accept`,
                title: 'Accept prompt completion',
                group: 'Prompt',
                bind: 'tab',
                enabled: actions.canAccept,
                run: (_input, event) => actions.accept(false, event),
            },
            {
                id: `${PLUGIN_ID}.accept-word`,
                title: 'Accept next completion word',
                group: 'Prompt',
                // Some macOS terminals translate Option+Right into Esc+f.
                bind: process.platform === 'darwin' ? 'alt+right,alt+f' : 'ctrl+right',
                enabled: actions.canAccept,
                run: (_input, event) => actions.accept(true, event),
            },
            {
                id: `${PLUGIN_ID}.dismiss`,
                title: 'Dismiss prompt completion',
                group: 'Prompt',
                bind: 'escape',
                enabled: actions.canDismiss,
                run: (_input, event) => actions.dismiss(event),
            },
        ],
    }));
}

export function registerGlobalCommands(context: Plugin.Context, actions: { generate(): void; status(): Promise<void> }) {
    context.keymap.layer(() => ({
        mode: 'global',
        commands: [
            {
                id: `${PLUGIN_ID}.generate`,
                title: 'Suggest or complete the prompt',
                group: 'Prompt',
                palette: true,
                bind: '<leader>j',
                run: actions.generate,
            },
            {
                id: `${PLUGIN_ID}.status`,
                title: 'Completion status',
                group: 'Prompt',
                palette: true,
                bind: false,
                run: actions.status,
            },
        ],
    }));
}
