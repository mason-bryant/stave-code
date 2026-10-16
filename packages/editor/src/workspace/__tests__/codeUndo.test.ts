// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codeCanUndo,
  codeEditorForFocus,
  codeUndoForFocus,
  undoTargetFor,
  CODE_UNDO_ATTR,
  CODE_UNDO_ACTIVE,
} from '../codeUndo'
import { registerEditor, setActiveEditor, unregisterEditor } from '../editorRegistry'

function fakeEditor(dom: HTMLElement | null = null) {
  const model = { undo: vi.fn(), redo: vi.fn() }
  return { model, editor: { getModel: () => model, trigger: vi.fn(), getDomNode: () => dom } }
}

function panel(value: string | null): HTMLElement {
  const root = document.createElement('div')
  if (value !== null) root.setAttribute(CODE_UNDO_ATTR, value)
  const inner = document.createElement('button')
  root.appendChild(inner)
  document.body.appendChild(root)
  return inner
}

afterEach(() => {
  document.body.innerHTML = ''
  setActiveEditor(null)
})

describe('codeUndoForFocus (#1800)', () => {
  it('focus inside a panel marked with a file undoes THAT file, through its model', () => {
    const a = fakeEditor()
    const b = fakeEditor()
    registerEditor('a.strudel', a.editor)
    registerEditor('b.strudel', b.editor)
    setActiveEditor(b.editor)
    try {
      const el = panel('a.strudel')
      expect(codeEditorForFocus(el)).toBe(a.editor)
      expect(codeUndoForFocus(el, 'undo')).toBe(true)
      expect(codeUndoForFocus(el, 'redo')).toBe(true)
      expect(a.model.undo).toHaveBeenCalledTimes(1)
      expect(a.model.redo).toHaveBeenCalledTimes(1)
      expect(b.model.undo).not.toHaveBeenCalled()
      // Never the editor's Undo action: it would pull focus into the code.
      expect(a.editor.trigger).not.toHaveBeenCalled()
    } finally {
      unregisterEditor('a.strudel', a.editor)
      unregisterEditor('b.strudel', b.editor)
    }
  })

  it('a panel marked "active" follows the active code editor', () => {
    const a = fakeEditor()
    registerEditor('a.strudel', a.editor)
    setActiveEditor(a.editor)
    try {
      expect(codeUndoForFocus(panel(CODE_UNDO_ACTIVE), 'undo')).toBe(true)
      expect(a.model.undo).toHaveBeenCalledTimes(1)
    } finally {
      unregisterEditor('a.strudel', a.editor)
    }
  })

  it('focus outside every marked panel is not handled — the project undo runs', () => {
    expect(codeUndoForFocus(panel(null), 'undo')).toBe(false)
    expect(codeUndoForFocus(document.body, 'undo')).toBe(false)
    expect(codeUndoForFocus(null, 'undo')).toBe(false)
  })

  it('a marked panel whose file has no editor is not handled', () => {
    expect(codeUndoForFocus(panel('gone.strudel'), 'undo')).toBe(false)
  })
})

describe('undoTargetFor — one routing for ⌘Z and Edit → Undo', () => {
  it('focus in a code editor (its text, or a widget inside it) means that editor', () => {
    const dom = document.createElement('div')
    const text = document.createElement('textarea')
    dom.appendChild(text)
    document.body.appendChild(dom)
    const a = fakeEditor(dom)
    const b = fakeEditor(document.createElement('div'))
    registerEditor('a.strudel', a.editor)
    registerEditor('b.strudel', b.editor)
    setActiveEditor(b.editor)
    try {
      expect(undoTargetFor(text)).toEqual({ kind: 'code', editor: a.editor })
      expect(undoTargetFor(dom)).toEqual({ kind: 'code', editor: a.editor })
    } finally {
      unregisterEditor('a.strudel', a.editor)
      unregisterEditor('b.strudel', b.editor)
    }
  })

  it('a panel that writes code means the editor it writes to', () => {
    const a = fakeEditor()
    registerEditor('a.strudel', a.editor)
    try {
      expect(undoTargetFor(panel('a.strudel'))).toEqual({ kind: 'code', editor: a.editor })
    } finally {
      unregisterEditor('a.strudel', a.editor)
    }
  })

  it('anywhere else — a file row, a lamp, nothing focused — means file changes', () => {
    const a = fakeEditor(document.createElement('div'))
    registerEditor('a.strudel', a.editor)
    setActiveEditor(a.editor)
    try {
      expect(undoTargetFor(panel(null))).toEqual({ kind: 'files' })
      expect(undoTargetFor(document.body)).toEqual({ kind: 'files' })
      expect(undoTargetFor(null)).toEqual({ kind: 'files' })
    } finally {
      unregisterEditor('a.strudel', a.editor)
    }
  })

  it('codeCanUndo asks the model, and says yes when the model does not say', () => {
    const can = { getModel: () => ({ canUndo: () => false, canRedo: () => true }) }
    expect(codeCanUndo(can, 'undo')).toBe(false)
    expect(codeCanUndo(can, 'redo')).toBe(true)
    expect(codeCanUndo(fakeEditor().editor, 'undo')).toBe(true)
  })
})
