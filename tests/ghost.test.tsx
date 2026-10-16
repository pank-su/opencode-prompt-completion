/** @jsxImportSource @opentui/solid */
import { test, expect } from 'bun:test';
import { testRender } from '@opentui/solid';
import * as core from '@opentui/core';
import { createInlineGhost } from '../src/editor/ghost';
import { testTheme } from './fixtures/theme';

async function fixture(mode = 'dark', width = 42, height = 12) {
    let editor;
    const theme = testTheme(mode);
    const ui = await testRender(
        () => (
            <box width="100%" height="100%" backgroundColor={theme.background.base}>
                <box width="100%" paddingLeft={2} paddingTop={1} backgroundColor={theme.background.raised.base}>
                    <textarea
                        width="100%"
                        minHeight={1}
                        maxHeight={6}
                        textColor={theme.text.base}
                        focusedTextColor={theme.text.base}
                        backgroundColor="transparent"
                        focusedBackgroundColor="transparent"
                        placeholder="Введите запрос"
                        ref={(node) => {
                            editor = node;
                            node.focus();
                        }}
                    />
                    <text id="toolbar">MODEL · STATUS</text>
                </box>
            </box>
        ),
        { width, height }
    );
    await ui.renderOnce();
    const failures = [];
    const ghost = createInlineGhost(core, ui.renderer, (error) => failures.push(error));
    const show = async (prefix, suffix) => {
        editor.setText(prefix);
        editor.gotoBufferEnd();
        ghost.update(editor, prefix, suffix, theme.text.muted);
        await ui.renderOnce();
        await ui.renderOnce();
        await ui.renderOnce();
    };
    return {
        ui,
        editor,
        theme,
        ghost,
        failures,
        show,
        stop: () => {
            ghost.dispose();
            ui.renderer.destroy();
        }
    };
}

test.each(['light', 'dark'])('ghost is inside the real input and not in its buffer in %s theme', async (mode) => {
    const f = await fixture(mode);
    try {
        await f.show('Проверь', ' тесты');
        expect(f.ui.captureCharFrame()).toContain('Проверь тесты');
        expect(f.ui.captureCharFrame()).not.toContain('→');
        expect(f.editor.plainText).toBe('Проверь');
        expect(f.editor.getTextRangeByCoords(0, 0, f.editor.logicalCursor.row, f.editor.logicalCursor.col)).toBe(
            'Проверь'
        );
        expect(f.ghost.visible).toBe(true);
        expect(f.failures).toHaveLength(0);
    } finally {
        f.stop();
    }
});

test('ghost replaces the empty-field placeholder and restores it on cleanup', async () => {
    const f = await fixture();
    try {
        await f.show('', 'Добавь тесты');
        expect(f.ui.captureCharFrame()).toContain('Добавь тесты');
        expect(f.ui.captureCharFrame()).not.toContain('Введите запрос');
        expect(f.editor.plainText).toBe('');
        f.ghost.clear();
        await f.ui.renderOnce();
        expect(f.editor.placeholder).toBe('Введите запрос');
        expect(f.ui.captureCharFrame()).toContain('Введите запрос');
        expect(f.ui.captureCharFrame()).not.toContain('Добавь тесты');
    } finally {
        f.stop();
    }
});

test('the underlay does not steal mouse clicks or selections', async () => {
    const f = await fixture();
    try {
        await f.show('Проверь', ' тесты');
        await f.ui.mockMouse.click(f.editor.x + 2, f.editor.y);
        expect(f.editor.logicalCursor.col).toBe(2);
        await f.ui.renderOnce();
        expect(f.ghost.visible).toBe(false);
        expect(f.editor.plainText).toBe('Проверь');
    } finally {
        f.stop();
    }
});

test('wrapping stays inside input, handles Unicode and restores original minimum height', async () => {
    const f = await fixture('dark', 22);
    try {
        const original = { ...f.editor.getLayoutNode().getMinHeight() };
        await f.show('Проверь', ' 🧪 е́ и добавь тесты на регрессии');
        const frame = f.ui.captureCharFrame();
        expect(frame).toContain('🧪');
        expect(frame).toContain('е́');
        expect(frame).toContain('MODEL · STATUS');
        expect(f.editor.height).toBeGreaterThan(1);
        expect(f.editor.height).toBeLessThanOrEqual(6);
        expect(f.editor.plainText).toBe('Проверь');
        f.ghost.clear();
        await f.ui.renderOnce();
        await f.ui.renderOnce();
        expect(f.editor.getLayoutNode().getMinHeight()).toEqual(original);
        expect(f.editor.height).toBe(1);
        expect(f.failures).toHaveLength(0);
    } finally {
        f.stop();
    }
});

test('resize reflows ghost without changing input or painting over the toolbar', async () => {
    const f = await fixture('light', 50);
    try {
        await f.show('Проверь', ' изменения и добавь тесты');
        f.ui.resize(22, 12);
        await f.ui.renderOnce();
        await f.ui.renderOnce();
        await f.ui.renderOnce();
        expect(f.ui.captureCharFrame()).toContain('MODEL · STATUS');
        expect(f.editor.plainText).toBe('Проверь');
        expect(f.ghost.visible).toBe(true);
        expect(f.failures).toHaveLength(0);
    } finally {
        f.stop();
    }
});

test('ghost follows multiline and scrolled native cursor coordinates', async () => {
    const f = await fixture('dark', 32);
    try {
        const prefix = 'Первая строка\nВторая строка\nТретья\nЧетвёртая\nПятая\nШестая\nПроверь';
        await f.show(prefix, ' тесты');
        expect(f.ui.captureCharFrame()).toContain('Проверь тесты');
        expect(f.editor.plainText).toBe(prefix);
        expect(f.failures).toHaveLength(0);
    } finally {
        f.stop();
    }
});

test('cleanup is idempotent when the editor is destroyed first', async () => {
    const f = await fixture();
    await f.show('Проверь', ' тесты');
    f.editor.destroy();
    f.ghost.dispose();
    f.ghost.dispose();
    expect(f.failures).toHaveLength(0);
    f.ui.renderer.destroy();
});
