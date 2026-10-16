import type { RGBA, CliRenderer, OptimizedBuffer, TextareaRenderable } from '@opentui/core';

type Cell = { text: string; width: number };
type StyleValue = { unit: number; value: number };
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function rowsFor(cells: Cell[], start: number, width: number) {
    let row = 0,
        col = start;
    for (const cell of cells) {
        if (col >= width || col + cell.width > width) {
            row++;
            col = 0;
        }
        col += cell.width;
    }
    return row + 1;
}

export interface Ghost {
    readonly visible: boolean;
    update(editor: TextareaRenderable | undefined, prefix: string, suffix: string | undefined, color: RGBA): void;
    clear(): void;
    dispose(): void;
}

// OpenCode supplies host-only imports to the TUI entrypoint, not every nested
// module. Inject its constructors to avoid loading a second renderer runtime.
export function createInlineGhost(
    core: Pick<typeof import('@opentui/core'), 'Renderable' | 'Yoga'>,
    renderer: CliRenderer,
    failed: (error: unknown) => void = () => {}
): Ghost {
    const { Renderable, Yoga } = core;

    class GhostLayer extends Renderable {
        private editor: TextareaRenderable;
        private prefix: string;
        private suffix = '';
        private cells: Cell[] = [];
        private color: RGBA;
        private originalMinimum: StyleValue;
        private appliedMinimum?: number;
        private placeholder: TextareaRenderable['placeholder'];
        private failed: (error: unknown) => void;
        private ownerRenderer: CliRenderer;
        painted = false;
        private detachOnDestroy = () => this.destroy();

        constructor(
            renderer: CliRenderer,
            editor: TextareaRenderable,
            prefix: string,
            suffix: string,
            color: RGBA,
            failed: (error: unknown) => void
        ) {
            // Native textarea painting bypasses renderAfter. Paint beneath its transparent
            // glyph layer: unlike a foreground overlay, this does not capture mouse hits.
            super(renderer, {
                id: `panksup-prompt-ghost-${editor.num}`,
                position: 'absolute',
                width: '100%',
                height: '100%',
                zIndex: -1,
                buffered: false
            });
            this.ownerRenderer = renderer;
            this.editor = editor;
            this.prefix = prefix;
            this.color = color;
            this.failed = failed;
            this.selectable = false;
            this.focusable = false;
            this.originalMinimum = editor.getLayoutNode().getMinHeight();
            this.placeholder = editor.placeholder;
            editor.parent!.add(this);
            editor.once('destroyed', this.detachOnDestroy);
            this.onLifecyclePass = () => this.guarded(() => this.measure());
            renderer.registerLifecyclePass(this);
            this.update(prefix, suffix, color);
        }

        matches(editor: TextareaRenderable) {
            return this.editor === editor && !this.isDestroyed;
        }

        update(prefix: string, suffix: string, color: RGBA) {
            if (this.prefix === prefix && this.suffix === suffix && this.color === color) return;
            this.prefix = prefix;
            this.suffix = suffix;
            this.color = color;
            this.painted = false;
            const buffer = this.ownerRenderer.nextRenderBuffer;
            // Native grapheme IDs are reference-counted: retain only text and widths,
            // never an encoded char ID after freeUnicode or between render frames.
            this.cells = Array.from(graphemes.segment(suffix), (part) => {
                const encoded = buffer.encodeUnicode(part.segment);
                try {
                    return { text: part.segment, width: encoded?.data.reduce((sum, cell) => sum + cell.width, 0) ?? 1 };
                } finally {
                    if (encoded) buffer.freeUnicode(encoded);
                }
            });
            this.live = true;
            this.measure();
            this.requestRender();
        }

        private measure() {
            const editor = this.editor;
            if (editor.isDestroyed || editor.width <= 0) return;
            if (editor.placeholder != null) {
                this.placeholder = editor.placeholder;
                editor.placeholder = null;
            }
            const node = editor.getLayoutNode();
            const minimum = node.getMinHeight();
            // Preserve newer host layout changes instead of restoring stale settings.
            if (
                this.appliedMinimum !== undefined &&
                (minimum.unit !== Yoga.Unit.Point || minimum.value !== this.appliedMinimum)
            ) {
                this.originalMinimum = minimum;
                this.appliedMinimum = undefined;
            }
            const fixed = node.getHeight();
            const maximum = node.getMaxHeight();
            const viewport = editor.editorView.getViewport();
            const cursor = editor.visualCursor;
            const rows =
                viewport.offsetY + cursor.visualRow + rowsFor(this.cells, Math.max(0, cursor.visualCol), editor.width);
            const cap =
                fixed.unit === Yoga.Unit.Point
                    ? fixed.value
                    : maximum.unit === Yoga.Unit.Point
                      ? maximum.value
                      : Math.min(6, this.ownerRenderer.height);
            const base = this.originalMinimum.unit === Yoga.Unit.Point ? this.originalMinimum.value : 1;
            const wanted = Math.max(base, Math.min(cap, rows));
            if (minimum.unit !== Yoga.Unit.Point || minimum.value !== wanted) {
                editor.minHeight = wanted;
                this.appliedMinimum = wanted;
                this.live = true;
            } else {
                this.live = false;
            }
        }

        protected renderSelf(buffer: OptimizedBuffer) {
            this.painted = false;
            this.guarded(() => {
                const editor = this.editor;
                if (
                    editor.isDestroyed ||
                    !editor.focused ||
                    !editor.focusable ||
                    editor.hasSelection() ||
                    editor.plainText !== this.prefix ||
                    editor.width <= 0 ||
                    editor.height <= 0
                )
                    return;
                const logical = editor.logicalCursor;
                if (editor.editBuffer.getTextRangeByCoords(0, 0, logical.row, logical.col) !== editor.plainText) return;
                const viewport = editor.editorView.getViewport();
                const cursor = editor.visualCursor;
                // OpenTUI's visual cursor is already viewport-relative (logical is not).
                let row = cursor.visualRow;
                let col = cursor.visualCol;
                if (row < 0 || col < 0) return;
                buffer.pushScissorRect(editor.x, editor.y, editor.width, editor.height);
                try {
                    let line = '',
                        start = col;
                    const flush = () => {
                        if (line && row < editor.height) {
                            buffer.drawText(line, editor.x + start, editor.y + row, this.color);
                            this.painted = true;
                        }
                        line = '';
                    };
                    for (const cell of this.cells) {
                        if (col >= editor.width || col + cell.width > editor.width) {
                            flush();
                            row++;
                            col = 0;
                            start = 0;
                        }
                        if (row >= editor.height) break;
                        if (cell.width > 0 && cell.width <= editor.width) {
                            line += cell.text;
                        }
                        col += cell.width;
                    }
                    flush();
                } finally {
                    buffer.popScissorRect();
                }
            });
        }

        private guarded(run: () => void) {
            try {
                run();
            } catch (error) {
                this.painted = false;
                this.live = false;
                this.failed(error);
            }
        }

        destroy() {
            if (this.isDestroyed) return;
            this.ownerRenderer.unregisterLifecyclePass(this);
            const editor = this.editor;
            editor.off('destroyed', this.detachOnDestroy);
            if (!editor.isDestroyed) {
                if (editor.placeholder == null) editor.placeholder = this.placeholder;
                const minimum = editor.getLayoutNode().getMinHeight();
                if (
                    this.appliedMinimum !== undefined &&
                    minimum.unit === Yoga.Unit.Point &&
                    minimum.value === this.appliedMinimum
                ) {
                    editor.minHeight =
                        this.originalMinimum.unit === Yoga.Unit.Point
                            ? this.originalMinimum.value
                            : this.originalMinimum.unit === Yoga.Unit.Percent
                              ? `${this.originalMinimum.value}%`
                              : undefined;
                }
                editor.requestRender();
            }
            super.destroy();
        }
    }

    class InlineGhost {
        private layer?: GhostLayer;
        private renderer: CliRenderer;
        private failed: (error: unknown) => void;

        constructor(renderer: CliRenderer, failed: (error: unknown) => void = () => {}) {
            this.renderer = renderer;
            this.failed = failed;
        }

        get visible() {
            return Boolean(this.layer && !this.layer.isDestroyed && this.layer.painted);
        }

        update(editor: TextareaRenderable | undefined, prefix: string, suffix: string | undefined, color: RGBA) {
            if (!editor || editor.isDestroyed || !editor.parent || !suffix) {
                this.clear();
                return;
            }
            if (this.layer?.matches(editor)) this.layer.update(prefix, suffix, color);
            else {
                this.clear();
                this.layer = new GhostLayer(this.renderer, editor, prefix, suffix, color, this.failed);
            }
        }

        clear() {
            this.layer?.destroy();
            this.layer = undefined;
        }
        dispose() {
            this.clear();
        }
    }

    return new InlineGhost(renderer, failed);
}
