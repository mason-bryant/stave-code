/**
 * Which code editor ⌘Z means, given where focus is (#1800).
 *
 * Stave has two undo histories, and both are right. The project undo
 * (`undoManager.ts`) covers files created, deleted and renamed. Code edits live
 * in each code editor's own history — including every edit made from a panel
 * that writes code (the piano roll, the sequencer, the Song timeline), since
 * those land through the editor's model as one undo step each.
 *
 * What was missing is the routing: ⌘Z pressed in one of those panels ran the
 * project undo, and the panel's edit stayed. A panel that writes code marks its
 * root with `data-code-undo-file` — the id of the file it writes to, or
 * `active` when it always writes to the active code editor (the Pattern panel's
 * grids) — and the app's Undo/Redo ask this module before falling back to the
 * project undo.
 *
 * `undoTargetFor` is that routing, for ⌘Z and for Edit → Undo alike. The menu
 * passes where focus was before the menu was opened, so it acts where ⌘Z
 * would have. Until it did, Edit → Undo always ran the project undo: after
 * typing a new song it removed the file, and the song with it.
 */

import { getActiveEditor, getEditorForElement, getEditorForFile } from './editorRegistry'

export const CODE_UNDO_ATTR = 'data-code-undo-file'
/** Marker value for a panel that writes to whichever code editor is active. */
export const CODE_UNDO_ACTIVE = 'active'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MonacoEditor = any

/** The code editor whose history ⌘Z should walk, for focus at `el`; else undefined. */
export function codeEditorForFocus(el: Element | null | undefined): MonacoEditor | undefined {
  const host = el?.closest?.(`[${CODE_UNDO_ATTR}]`)
  const target = host?.getAttribute(CODE_UNDO_ATTR)
  if (!target) return undefined
  const editor = target === CODE_UNDO_ACTIVE ? getActiveEditor() : getEditorForFile(target)
  return editor ?? undefined
}

/** Where Undo/Redo act: one code editor's history, or the project's file changes. */
export type UndoTarget = { kind: 'code'; editor: MonacoEditor } | { kind: 'files' }

/**
 * Where Undo and Redo act for focus at `el`: the code editor it is in, the
 * code editor a panel it is in writes to, or — anywhere else — the project's
 * file changes.
 */
export function undoTargetFor(el: Element | null | undefined): UndoTarget {
  const editor = getEditorForElement(el) ?? codeEditorForFocus(el)
  return editor ? { kind: 'code', editor } : { kind: 'files' }
}

/**
 * Undo or redo in one code editor's history, through its model. The model's,
 * not the editor's Undo action: the action focuses the code editor, and the
 * next key the user types would land in the code instead of the panel they
 * are working in.
 */
export function codeUndo(editor: MonacoEditor, which: 'undo' | 'redo'): void {
  const model = editor?.getModel?.()
  if (which === 'undo') model?.undo?.()
  else model?.redo?.()
}

/** Whether that history has a step to take; true when the model does not say. */
export function codeCanUndo(editor: MonacoEditor, which: 'undo' | 'redo'): boolean {
  const model = editor?.getModel?.()
  const can = which === 'undo' ? model?.canUndo : model?.canRedo
  return typeof can === 'function' ? !!can.call(model) : true
}

/**
 * Undo or redo in the code editor that focus at `el` belongs to. Returns false
 * when focus is not in a panel that writes code — the caller's cue to use the
 * project undo. Returns true (handled) when it is, even if that history has
 * nothing left: ⌘Z in the timeline must never reach back and undo a file
 * rename instead.
 */
export function codeUndoForFocus(el: Element | null | undefined, which: 'undo' | 'redo'): boolean {
  const editor = codeEditorForFocus(el)
  if (!editor) return false
  codeUndo(editor, which)
  return true
}
