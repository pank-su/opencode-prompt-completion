/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal } from 'solid-js';
import { Plugin, usePlugin } from '@opencode/plugin/tui';
import { Renderable, Yoga } from '@opentui/core';
import { PredictionController } from './controller.mjs';
import { buildContext } from './context.mjs';
import { INVALIDATING_EVENTS } from './prediction.mjs';
import { createInlineGhost } from './ghost';
import { nextWordChunk } from './word.mjs';
import { focusedPrompt, insertPrediction, promptSnapshot, watchPrompt } from './editor.mjs';

const ACCEPT = 'panksup.prompt-completion.accept';
const ACCEPT_WORD = 'panksup.prompt-completion.accept-word';
const DISMISS = 'panksup.prompt-completion.dismiss';
const GENERATE = 'panksup.prompt-completion.generate';
const STATUS = 'panksup.prompt-completion.status';

function milliseconds(value: unknown, fallback: number, minimum: number, maximum: number) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function predictionModel(context: Plugin.Context) {
    const configured = context.options.predictionModel;
    if (configured && typeof configured === 'object') {
        const model = configured as { providerID?: string; id?: string; variant?: string };
        if (model.providerID && model.id) return { providerID: model.providerID, id: model.id, variant: model.variant };
        return undefined;
    }
    const selected = context.ui.model.current();
    if (!selected) return undefined;
    const variants = context.ui.model.variant.list();
    const variant = ['minimal', 'low'].find((value) => variants.includes(value));
    return { providerID: selected.providerID, id: selected.modelID, variant };
}

export function setupPromptCompletion(context: Plugin.Context) {
    const automatic = context.options.automatic !== false;
    const debounce = milliseconds(context.options.typingDebounceMs, 500, 100, 5000);
    const cooldown = milliseconds(context.options.cooldownMs, 1500, 0, 10000);
    const [revision, setRevision] = createSignal(0);
    let disposed = false,
        broken = false,
        synchronizing = false,
        foreground = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let manual: ReturnType<typeof setTimeout> | undefined;
    let nextRequestAt = 0,
        previous = '',
        serial = 0;
    let lastSnapshot: ReturnType<typeof snapshot> | undefined;
    let controller: PredictionController;
    const clearTimer = () => {
        clearTimeout(timer);
        timer = undefined;
    };
    const fail = () => {
        if (broken || disposed) return;
        broken = true;
        clearTimer();
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
                    message: 'Автодополнение отключено из-за ошибки. Открой «Статус автодополнения».',
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
        automatic,
        timeoutMs: milliseconds(context.options.timeoutMs, 7000, 1000, 15000),
        generate: (request, options) =>
            context.client.generate.text({ model: request.model as any, prompt: request.prompt }, options),
        onChange: () => queueMicrotask(() => safe(refresh))
    });

    function snapshot() {
        const field = promptSnapshot(context);
        const id = field.sessionID;
        const running = Boolean(id && context.data.session.status(id) === 'running');
        const model = predictionModel(context);
        const recent = buildContext(id ? context.data.session.message.list(id) : [], { running, maxCharacters: 10000 });
        return {
            ...field,
            presentable: field.presentable && foreground,
            requestable: field.requestable && foreground && Boolean(model),
            model,
            context: recent.text,
            revision: recent.revision,
            running
        };
    }

    function schedule(current: ReturnType<typeof snapshot>) {
        if (!automatic || !controller.needsRequest || !current.requestable) {
            clearTimer();
            return;
        }
        const blank = current.prefix === '' && current.context !== '[]' && !current.running;
        if (!blank && Array.from(current.prefix.trim()).length < 3) {
            clearTimer();
            return;
        }
        const key = JSON.stringify([current.sessionID, current.revision, current.model, current.prefix]);
        if (timer && previous === key) return;
        clearTimer();
        previous = key;
        timer = setTimeout(
            () => {
                timer = undefined;
                safe(() => {
                    const latest = snapshot();
                    controller.update(latest);
                    if (
                        JSON.stringify([latest.sessionID, latest.revision, latest.model, latest.prefix]) !== key ||
                        !controller.needsRequest
                    )
                        return;
                    nextRequestAt = Date.now() + cooldown;
                    void controller.request(latest, `prediction:${++serial}`).catch(fail);
                });
            },
            Math.max(debounce, nextRequestAt - Date.now())
        );
    }

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
            schedule(current);
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
        const accept = (byWord: boolean, event?: { preventDefault(): void; stopPropagation(): void }) => {
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
        local.keymap.layer(() => ({
            target: () => {
                revision();
                return focusedPrompt(local.renderer);
            },
            priority: 10,
            commands: [
                {
                    id: ACCEPT,
                    title: 'Принять дополнение промпта',
                    group: 'Prompt',
                    bind: 'tab',
                    enabled: () => !broken && ghost.visible && controller.state.status === 'ready',
                    run: (_input, event) => accept(false, event)
                },
                {
                    id: ACCEPT_WORD,
                    title: 'Принять следующее слово подсказки',
                    group: 'Prompt',
                    // Some macOS terminals translate Option+Right into Esc+f.
                    bind: process.platform === 'darwin' ? 'alt+right,alt+f' : 'ctrl+right',
                    enabled: () => !broken && ghost.visible && controller.state.status === 'ready',
                    run: (_input, event) => accept(true, event)
                },
                {
                    id: DISMISS,
                    title: 'Скрыть дополнение промпта',
                    group: 'Prompt',
                    bind: 'escape',
                    enabled: () => !broken && ghost.visible,
                    run(_input, event) {
                        safe(() => {
                            clearTimer();
                            controller.dismiss();
                            ghost.clear();
                            event?.preventDefault();
                            event?.stopPropagation();
                        });
                    }
                }
            ]
        }));
        return null;
    }
    const stopSlot = context.ui.slot({ append: 'app', render: () => <Observer /> });
    context.keymap.layer(() => ({
        mode: 'global',
        commands: [
            {
                id: GENERATE,
                title: 'Предложить или дополнить промпт',
                group: 'Prompt',
                palette: true,
                bind: '<leader>j',
                run() {
                    const route = context.ui.router.current();
                    if (route.type !== 'session' || broken) return;
                    clearTimer();
                    clearTimeout(manual);
                    manual = setTimeout(
                        () =>
                            safe(() => {
                                refresh();
                                const current = snapshot();
                                if (!current.requestable || current.sessionID !== route.sessionID) {
                                    context.ui.toast.show({
                                        message: 'Нужен промпт с курсором в конце и доступная модель.',
                                        variant: 'info'
                                    });
                                    return;
                                }
                                nextRequestAt = Date.now() + cooldown;
                                void controller.request(current, `manual:${++serial}`, { manual: true }).catch(fail);
                            }),
                        100
                    );
                }
            },
            {
                id: STATUS,
                title: 'Статус автодополнения',
                group: 'Prompt',
                palette: true,
                bind: false,
                async run() {
                    const value = lastSnapshot;
                    const stats = controller.diagnostics;
                    await context.ui.dialog.alert({
                        title: 'Автодополнение',
                        message: [
                            `Плагин: ${broken ? 'остановлен после ошибки' : automatic ? 'автоматический' : 'ручной режим'}`,
                            `Состояние: ${controller.state.status} · ${controller.state.reason ?? '—'}`,
                            `Поле: ${value?.presentable ? 'доступно' : 'скрыто'} · запросы: ${value?.requestable ? 'доступны' : 'заблокированы'}`,
                            `Модель: ${value?.model ? `${value.model.providerID}/${value.model.id} · ${value.model.variant ?? 'default'}` : 'не выбрана'}`,
                            `Запросов: ${stats.requests} · кеш: ${stats.cacheHits} · ошибок: ${stats.errors}`,
                            `Последнее ожидание: ${stats.latencyMs ?? '—'} мс · контекст: ${value?.context.length ?? 0} символов`
                        ].join('\n')
                    });
                }
            }
        ]
    }));
    return () => {
        disposed = true;
        clearTimer();
        clearTimeout(manual);
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

export default Plugin.define({ id: 'panksup.prompt-completion', setup: setupPromptCompletion });
