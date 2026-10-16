import type { Plugin } from '@opencode/plugin/tui';
import { PredictionController } from './prediction/controller.mjs';
import { createInlineGhost } from './editor/ghost';
import { insertPrediction, promptSnapshot, watchPrompt } from './editor/adapter.mjs';
import { readOptions } from './opencode/options.mjs';
import { completionStatus } from './opencode/diagnostics.mjs';
import { completionSnapshot, INVALIDATING_EVENTS } from './opencode/snapshot.mjs';
import { PredictionScheduler } from './opencode/scheduler.mjs';
import { registerPromptCommands, registerGlobalCommands } from './opencode/commands';
import { nextWordChunk } from './prediction/word.mjs';

type TuiRuntime = Pick<typeof import('@opentui/core'), 'Renderable' | 'Yoga'> & {
    createEffect: typeof import('solid-js').createEffect;
    createSignal: typeof import('solid-js').createSignal;
    usePlugin: typeof import('@opencode/plugin/tui').usePlugin;
    renderObserver: (observer: () => null) => null;
};

export function setupPromptCompletion(context: Plugin.Context, runtime: TuiRuntime) {
    const { Renderable, Yoga, createEffect, createSignal, usePlugin } = runtime;
    const options = readOptions(context.options);
    const [revision, setRevision] = createSignal(0);
    let disposed = false,
        broken = false,
        synchronizing = false,
        foreground = true;
    let lastSnapshot: ReturnType<typeof snapshot> | undefined;
    let controller: PredictionController;
    let scheduler: PredictionScheduler;
    const fail = () => {
        if (broken || disposed) return;
        broken = true;
        scheduler?.dispose();
        // Never let plugin exceptions escape into the shared session-event stream.
        queueMicrotask(() => {
            controller?.dispose();
            try {
                ghost.dispose();
            } catch {
                /* The failed render adapter is already isolated. */
            }
            if (!disposed)
                context.ui.toast.show({
                    message: 'Prompt completion stopped after an error. Open "Completion status".',
                    variant: 'warning'
                });
        });
    };
    const safe = (run: () => void) => {
        if (disposed || broken) return;
        try {
            run();
        } catch {
            fail();
        }
    };
    const ghost = createInlineGhost({ Renderable, Yoga }, context.renderer, fail);
    controller = new PredictionController({
        automatic: options.automatic,
        timeoutMs: options.timeoutMs,
        generate: (request, options) =>
            context.client.generate.text({ model: request.model, prompt: request.prompt }, options),
        onChange: () => queueMicrotask(() => safe(refresh))
    });

    const snapshot = () => completionSnapshot(context, foreground);
    scheduler = new PredictionScheduler({
        options,
        controller,
        snapshot,
        run: safe,
        onFailure: fail,
        onUnavailable: () => context.ui.toast.show({
            message: 'Focus a prompt with the cursor at the end and an available model.',
            variant: 'info',
        }),
    });

    function refresh() {
        if (synchronizing || disposed || broken) return;
        synchronizing = true;
        try {
            const current = snapshot();
            lastSnapshot = current;
            controller.update(current);
            const state = controller.state;
            ghost.update(
                current.presentable ? current.editor : undefined,
                current.prefix,
                state.status === 'ready' && state.sessionID === current.sessionID && state.prefix === current.prefix
                    ? state.suggestion
                    : undefined,
                context.theme.text.muted
            );
            scheduler.schedule(current);
            setRevision((value) => value + 1);
        } finally {
            synchronizing = false;
        }
    }

    const stopEditor = watchPrompt(context.renderer, () => safe(refresh));
    const focus = () => {
        foreground = true;
        safe(refresh);
    };
    const blur = () => {
        foreground = false;
        safe(refresh);
    };
    const resize = () => safe(refresh);
    context.renderer.on('focus', focus);
    context.renderer.on('blur', blur);
    context.renderer.on('resize', resize);
    const stopEvents = context.data.listen(({ details }) =>
        safe(() => {
            const active = promptSnapshot(context).sessionID;
            const data = details.data as { sessionID?: string };
            if (data.sessionID && data.sessionID !== active) return;
            if (data.sessionID === active && INVALIDATING_EVENTS.has(details.type)) controller.invalidate();
            refresh();
        })
    );

    function Observer() {
        const local = usePlugin();
        createEffect(() => safe(refresh));
        const accept = (byWord: boolean, event?: { preventDefault(): void; stopPropagation(): void }): void | false => {
            let accepted = false;
            safe(() => {
                refresh();
                if (!ghost.visible || controller.state.status !== 'ready') return;
                const state = controller.state;
                const suggestion = byWord ? nextWordChunk(state.suggestion) : state.suggestion;
                if (!suggestion) return;
                controller.dismiss();
                ghost.clear();
                accepted = insertPrediction(local, { ...state, suggestion });
                if (accepted) {
                    event?.preventDefault();
                    event?.stopPropagation();
                }
            });
            return accepted ? undefined : false;
        };
        registerPromptCommands(local, {
            revision,
            canAccept: () => !broken && ghost.visible && controller.state.status === 'ready',
            canDismiss: () => !broken && ghost.visible,
            accept,
            dismiss: (event) => safe(() => {
                scheduler.cancelAutomatic();
                controller.dismiss();
                ghost.clear();
                event?.preventDefault();
                event?.stopPropagation();
            }),
        });
        return null;
    }
    const stopSlot = context.ui.slot({ append: 'app', render: () => runtime.renderObserver(Observer) });
    registerGlobalCommands(context, {
        generate() {
            const route = context.ui.router.current();
            if (route.type === 'session' && !broken) scheduler.requestManual(route.sessionID);
        },
        async status() {
            await context.ui.dialog.alert({
                title: 'Completion status',
                message: completionStatus({
                    automatic: options.automatic,
                    broken,
                    state: controller.state,
                    stats: controller.diagnostics,
                    snapshot: lastSnapshot,
                    timeoutMs: options.timeoutMs,
                }),
            });
        },
    });
    return () => {
        disposed = true;
        scheduler.dispose();
        stopEvents();
        stopEditor();
        stopSlot();
        context.renderer.off('focus', focus);
        context.renderer.off('blur', blur);
        context.renderer.off('resize', resize);
        controller.dispose();
        ghost.dispose();
    };
}
