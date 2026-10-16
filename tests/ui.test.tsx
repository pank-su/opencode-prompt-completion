/** @jsxImportSource @opentui/solid */
import { test, expect, mock } from 'bun:test';
import { testRender, useRenderer } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { registerManagedTextareaLayer } from '@opentui/keymap/addons/opentui';
import { testTheme } from './fixtures/theme';

let mountedContext;
mock.module('@opencode/plugin/tui', () => ({ Plugin: { define: (value) => value }, usePlugin: () => mountedContext }));
const { default: plugin } = await import('../tui');
const pause = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
const wordModifiers = process.platform === 'darwin' ? { meta: true } : { ctrl: true };

test.skipIf(process.platform !== 'darwin')(
    'macOS uses Option shortcuts and supports terminals sending Esc+f',
    async () => {
        const f = await fixture();
        try {
            const command = f.command('.accept-word');
            expect(command.bind).toBe('alt+right,alt+f');
            expect(command.bind).not.toContain('ctrl');
            f.editor.insertText('Проверь');
            await f.ui.renderOnce();
            await pause();
            await f.finish('{"suggestion":" изменения и тесты"}');
            f.ui.mockInput.pressKey('f', { meta: true });
            await f.ui.renderOnce();
            await f.ui.renderOnce();
            expect(f.editor.plainText).toBe('Проверь изменения');
            expect(f.ui.captureCharFrame()).toContain('Проверь изменения и тесты');
            expect(f.requests).toHaveLength(1);
        } finally {
            f.stop();
        }
    }
);

test('platform word shortcut accepts one word at a time from cache and Tab still accepts the rest', async () => {
    const f = await fixture();
    try {
        f.editor.insertText('Проверь');
        await f.ui.renderOnce();
        await pause();
        await f.finish('{"suggestion":" изменения и тесты"}');
        f.ui.mockInput.pressArrow('right', wordModifiers);
        await f.ui.renderOnce();
        await f.ui.renderOnce();
        expect(f.editor.plainText).toBe('Проверь изменения');
        expect(f.ui.captureCharFrame()).toContain('Проверь изменения и тесты');
        expect(f.requests).toHaveLength(1);
        f.ui.mockInput.pressArrow('right', wordModifiers);
        await f.ui.renderOnce();
        await f.ui.renderOnce();
        expect(f.editor.plainText).toBe('Проверь изменения и');
        f.ui.mockInput.pressTab();
        await f.ui.renderOnce();
        expect(f.editor.plainText).toBe('Проверь изменения и тесты');
        expect(f.requests).toHaveLength(1);
        expect(f.submitted()).toBe(0);
    } finally {
        f.stop();
    }
});

test('platform word shortcut keeps native word navigation when no ghost is available', async () => {
    const f = await fixture('dark', { automatic: false });
    try {
        f.editor.insertText('Проверь тесты');
        f.editor.gotoBufferHome();
        await f.ui.renderOnce();
        f.ui.mockInput.pressArrow('right', wordModifiers);
        await f.ui.renderOnce();
        expect(f.editor.logicalCursor.col).toBeGreaterThan(0);
        expect(f.editor.plainText).toBe('Проверь тесты');
        expect(f.requests).toHaveLength(0);
        expect(f.submitted()).toBe(0);
    } finally {
        f.stop();
    }
});

async function fixture(mode = 'dark', options = {}) {
    const slots = [],
        layers = [],
        requests = [],
        stops = [],
        toasts = [];
    let context, editor, stop, events, keymap, stopManaged, setSession, setMessages, setRunning;
    let hostText = '',
        submitted = 0;
    const ui = await testRender(
        () => {
            const [sessionID, updateSession] = createSignal('s1');
            setSession = updateSession;
            const [messages, updateMessages] = createSignal([]);
            setMessages = updateMessages;
            const [running, updateRunning] = createSignal(false);
            setRunning = updateRunning;
            const renderer = useRenderer();
            keymap = createDefaultOpenTuiKeymap(renderer);
            stopManaged = registerManagedTextareaLayer(keymap, renderer, { enabled: () => true });
            const theme = testTheme(mode);
            context = {
                app: { version: '2.0.27' },
                options: { typingDebounceMs: 100, cooldownMs: 0, ...options },
                renderer,
                theme,
                client: {
                    generate: {
                        text: (input, requestOptions) => {
                            let resolve, reject;
                            const promise = new Promise((done, fail) => {
                                resolve = done;
                                reject = fail;
                            });
                            requests.push({ input, options: requestOptions, resolve, reject });
                            return promise;
                        }
                    },
                    session: {
                        generate: () => {
                            throw new Error('Full session generation forbidden');
                        },
                        prompt: () => {
                            throw new Error('Must never submit');
                        },
                        switchModel: () => {
                            throw new Error('Do not change session model');
                        }
                    }
                },
                data: {
                    listen: (handler) => {
                        events = handler;
                        return () => {
                            events = undefined;
                        };
                    },
                    session: {
                        get: (id) => ({ id, location: { directory: '/project' } }),
                        status: () => (running() ? 'running' : 'idle'),
                        message: { list: () => messages() },
                        pending: { list: () => [] },
                        permission: { list: () => [] },
                        form: { list: () => [] }
                    }
                },
                keymap: {
                    layer: (factory) => {
                        layers.push(factory);
                        const layer = factory();
                        stops.push(
                            keymap.registerLayer({
                                target: layer.target?.(),
                                priority: layer.priority,
                                commands: layer.commands.map((command) => ({
                                    name: command.id,
                                    enabled: command.enabled,
                                    run: (invocation) => command.run(undefined, invocation.event)
                                })),
                                bindings: layer.commands.flatMap((command) =>
                                    typeof command.bind === 'string'
                                        ? command.bind
                                              .split(',')
                                              .filter((key) =>
                                                  ['tab', 'escape', 'ctrl+right', 'alt+right', 'alt+f'].includes(key)
                                              )
                                              .map((key) => ({ key, cmd: command.id }))
                                        : []
                                )
                            })
                        );
                    }
                },
                ui: {
                    model: {
                        current: () => ({ providerID: 'openai', modelID: 'fast', variant: 'high' }),
                        variant: { list: () => ['low', 'high'] }
                    },
                    router: { current: () => ({ type: 'session', sessionID: sessionID() }) },
                    slot: (spec) => {
                        slots.push(spec);
                        return () => {};
                    },
                    toast: { show: (value) => toasts.push(value) },
                    dialog: {
                        alert: async (value) => {
                            toasts.push(value);
                        }
                    }
                }
            };
            mountedContext = context;
            stop = plugin.setup(context);
            return (
                <box width="100%" height="100%" backgroundColor={theme.background.base}>
                    <box paddingLeft={2} paddingTop={1} width="100%" backgroundColor={theme.background.raised.base}>
                        <textarea
                            minHeight={1}
                            maxHeight={6}
                            width="100%"
                            backgroundColor="transparent"
                            focusedBackgroundColor="transparent"
                            textColor={theme.text.base}
                            focusedTextColor={theme.text.base}
                            placeholder="Введите запрос"
                            ref={(node) => {
                                editor = node;
                                node.traits = { owner: 'opencode', role: 'prompt', capture: ['tab'] } as any;
                                node.focus();
                            }}
                            onContentChange={() => {
                                hostText = editor.plainText;
                            }}
                            onSubmit={() => {
                                submitted++;
                            }}
                        />
                        <text>MODEL · STATUS</text>
                    </box>
                    {slots.find((slot) => slot.append === 'app').render({})}
                </box>
            );
        },
        { width: 60, height: 12 }
    );
    await ui.renderOnce();
    const finish = async (text, index = requests.length - 1) => {
        requests[index].resolve({ text });
        await ui.renderOnce();
        await ui.renderOnce();
        await ui.renderOnce();
    };
    return {
        ui,
        context,
        editor,
        requests,
        toasts,
        keymap,
        finish,
        event: (type, sessionID = 's1') => events?.({ details: { type, id: `event-${type}`, data: { sessionID } } }),
        command: (suffix) =>
            layers.flatMap((factory) => factory().commands ?? []).find((command) => command.id.endsWith(suffix)),
        setSession,
        setMessages,
        setRunning,
        hostText: () => hostText,
        submitted: () => submitted,
        stop: () => {
            stop();
            stops.reverse().forEach((dispose) => dispose());
            stopManaged();
            ui.renderer.destroy();
        }
    };
}

test.each(['light', 'dark'])('inline suffix is virtual until real Tab accepts it in %s mode', async (mode) => {
    const f = await fixture(mode);
    try {
        await f.ui.mockInput.typeText('Проверь');
        await f.ui.renderOnce();
        await pause();
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0].input.model).toEqual({ providerID: 'openai', id: 'fast', variant: 'low' });
        expect(f.context.ui.model.current().variant).toBe('high');
        await f.finish('{"suggestion":" тесты"}');
        expect(f.ui.captureCharFrame()).toContain('Проверь тесты');
        expect(f.ui.captureCharFrame()).not.toContain('→');
        expect(f.editor.plainText).toBe('Проверь');
        f.ui.mockInput.pressTab();
        await f.ui.renderOnce();
        expect(f.editor.plainText).toBe('Проверь тесты');
        expect(f.hostText()).toBe('Проверь тесты');
        expect(f.submitted()).toBe(0);
        f.editor.undo();
        await f.ui.renderOnce();
        expect(f.editor.plainText).toBe('Проверь');
    } finally {
        f.stop();
    }
});

test('matching typing and backspace reuse the candidate without another model call', async () => {
    const f = await fixture();
    try {
        f.editor.insertText('Проверь');
        await f.ui.renderOnce();
        await pause();
        await f.finish('{"suggestion":" изменения и тесты"}');
        await f.ui.mockInput.typeText(' изменения');
        await f.ui.renderOnce();
        await pause();
        expect(f.requests).toHaveLength(1);
        expect(f.ui.captureCharFrame()).toContain('Проверь изменения и тесты');
        f.editor.deleteCharBackward();
        await f.ui.renderOnce();
        await pause();
        expect(f.requests).toHaveLength(1);
        expect(f.ui.captureCharFrame()).toContain('Проверь изменения и тесты');
    } finally {
        f.stop();
    }
});

test('typing while a request runs does not abort it and compatible reply is projected against latest prefix', async () => {
    const f = await fixture();
    try {
        f.editor.insertText('Проверь');
        await f.ui.renderOnce();
        await pause();
        f.editor.insertText(' из');
        await f.ui.renderOnce();
        expect(f.requests[0].options.signal.aborted).toBe(false);
        await f.finish('{"suggestion":" изменения"}');
        expect(f.ui.captureCharFrame()).toContain('Проверь изменения');
        expect(f.editor.plainText).toBe('Проверь из');
        expect(f.requests).toHaveLength(1);
    } finally {
        f.stop();
    }
});

test('stateless completion works while the main agent is running and excludes its partial output', async () => {
    const f = await fixture();
    try {
        f.setRunning(true);
        f.setMessages([
            { type: 'user', text: 'Fix the bug' },
            { type: 'assistant', content: [{ type: 'text', text: 'PARTIAL_PRIVATE_OUTPUT' }] }
        ]);
        f.editor.insertText('Добавь');
        await f.ui.renderOnce();
        await pause();
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0].input.prompt).toContain('Fix the bug');
        expect(f.requests[0].input.prompt).not.toContain('PARTIAL_PRIVATE_OUTPUT');
        await f.finish('{"suggestion":" тесты"}');
        f.ui.mockInput.pressTab();
        await f.ui.renderOnce();
        expect(f.editor.plainText).toBe('Добавь тесты');
        expect(f.submitted()).toBe(0);
    } finally {
        f.stop();
    }
});

test('context is bounded even when session messages contain huge tool output', async () => {
    const f = await fixture();
    try {
        f.setMessages([
            { type: 'user', text: 'My task' },
            {
                type: 'assistant',
                content: [
                    { type: 'tool', text: 'TOOL_SECRET'.repeat(50000) },
                    { type: 'reasoning', text: 'REASONING_SECRET' },
                    { type: 'text', text: 'Final answer'.repeat(5000) }
                ]
            }
        ]);
        f.editor.insertText('Проверь');
        await f.ui.renderOnce();
        await pause();
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0].input.prompt.length).toBeLessThanOrEqual(13000);
        expect(f.requests[0].input.prompt).not.toContain('TOOL_SECRET');
        expect(f.requests[0].input.prompt).not.toContain('REASONING_SECRET');
    } finally {
        f.stop();
    }
});

test('Escape dismisses without repeat requests and regular Tab/Shift+Tab fall through', async () => {
    const f = await fixture();
    let tabs = 0,
        shifts = 0;
    const fallback = f.keymap.registerLayer({
        priority: -1,
        bindings: [
            {
                key: 'tab',
                cmd: () => {
                    tabs++;
                }
            },
            {
                key: 'shift+tab',
                cmd: () => {
                    shifts++;
                }
            }
        ]
    });
    try {
        f.ui.mockInput.pressTab();
        await f.ui.renderOnce();
        expect(tabs).toBe(1);
        f.editor.insertText('Проверь');
        await f.ui.renderOnce();
        await pause();
        await f.finish('{"suggestion":" тесты"}');
        f.ui.mockInput.pressTab({ shift: true });
        await f.ui.renderOnce();
        expect(shifts).toBe(1);
        f.ui.mockInput.pressEscape();
        await f.ui.renderOnce();
        await pause();
        expect(f.editor.plainText).toBe('Проверь');
        expect(f.ui.captureCharFrame()).not.toContain('Проверь тесты');
        expect(f.requests).toHaveLength(1);
        f.ui.mockInput.pressTab();
        await f.ui.renderOnce();
        expect(tabs).toBe(2);
    } finally {
        fallback();
        f.stop();
    }
});

test('session switch aborts old work and a late response never appears in the new session', async () => {
    const f = await fixture();
    try {
        f.editor.insertText('Проверь');
        await f.ui.renderOnce();
        await pause();
        f.setSession('s2');
        await f.ui.renderOnce();
        expect(f.requests[0].options.signal.aborted).toBe(true);
        await f.finish('{"suggestion":" OLD_SESSION"}', 0);
        expect(f.ui.captureCharFrame()).not.toContain('OLD_SESSION');
        expect(f.editor.plainText).toBe('Проверь');
    } finally {
        f.stop();
    }
});

test('editor and event failures are isolated rather than escaping into session updates', async () => {
    const f = await fixture();
    try {
        f.context.data.session.message.list = () => {
            throw new Error('broken host');
        };
        expect(() => f.event('session.execution.succeeded')).not.toThrow();
        await f.ui.renderOnce();
        expect(f.toasts.some((value) => value.variant === 'warning')).toBe(true);
        expect(f.requests).toHaveLength(0);
    } finally {
        f.stop();
    }
});

test('disabling and reloading plugin cleans up listeners, ghost and layout without dangling callbacks', async () => {
    const f = await fixture('dark', { automatic: false });
    f.editor.insertText('Проверь');
    await f.ui.renderOnce();
    f.command('.generate').run();
    await pause();
    expect(f.requests).toHaveLength(1);
    await f.finish('{"suggestion":" тесты"}');
    expect(f.ui.captureCharFrame()).toContain('Проверь тесты');
    f.stop();
    expect(f.context.renderer.listenerCount('focused_editor')).toBe(0);
});
