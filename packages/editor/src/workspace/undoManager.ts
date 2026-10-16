/**
 * Project-level undo manager — wraps Y.UndoManager so the app can
 * offer undo/redo for STRUCTURAL operations (file create/delete/rename,
 * folder reorder). Text-content typing is NOT tracked here because
 * Monaco has its own in-editor undo stack; surfacing those here would
 * double-undo and cause confusing UX.
 *
 * The scope is the set of top-level Y maps (files / fileOrder /
 * subfolderOrder / childOrder — the last is where the Files panel writes
 * every reorder, so without it ⌘Z never undid one, #2089). The `trackedOrigins` is a sentinel Symbol — structural
 * ops wrap their `doc.transact` calls with this origin so content-typing
 * transactions (which use `null` / framework origins) are ignored.
 *
 * Each step on the stack carries a name ("Create song.strudel") and the files
 * that taking it off the stack would remove. Undoing a file's creation removes
 * the file and everything typed into it, so the app names the step in the Edit
 * menu, asks before removing written work, and says what an undo removed or
 * brought back.
 */

import * as Y from 'yjs'
import { getActiveDoc } from './projectDoc'

/** Sentinel origin for structural transactions — pass as second arg to doc.transact. */
export const STRUCT_ORIGIN = Symbol.for('stave:struct')

/**
 * Run `fn` inside a single structural transaction so every store
 * mutation it triggers (rename + folder-order updates, etc.) collapses
 * into ONE undo stack item instead of fanning into N items. Nested
 * transacts piggyback on the outer one — callers just call the
 * existing store functions as usual.
 */
export function withStructBatch<T>(fn: () => T): T {
  const doc = getActiveDoc()
  let out: T | undefined
  doc.transact(() => { out = fn() }, STRUCT_ORIGIN)
  return out as T
}

type Listener = () => void
type Which = 'undo' | 'redo'
/** file id → path */
type Paths = ReadonlyMap<string, string>

// What a step is, kept on the Y.UndoManager stack item's `meta`.
const LABEL = 'stave:label'
/** ids of the files that taking this step off its stack removes */
const REMOVES = 'stave:removes'
/** the file paths from before the step, for a step that grows (captureTimeout) */
const BEFORE = 'stave:before'
const REORDERED = 'stave:reordered'

let active: {
  um: Y.UndoManager
  files: Y.Map<Y.Map<unknown>>
  listeners: Set<Listener>
  cleanup: () => void
} | null = null

function filePaths(files: Y.Map<Y.Map<unknown>>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, file] of files) {
    if (file instanceof Y.Map) out.set(id, String(file.get('path') ?? id))
  }
  return out
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const dirName = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const someFiles = (paths: string[]): string =>
  paths.length === 1 ? baseName(paths[0]) : `${paths.length} files`

/**
 * Name a structural step from the file paths before and after it:
 * "Create song.strudel", "Delete 3 files", "Rename a.strudel", "Move b.p5",
 * "Rename folder drums", "Reorder files". Null when no file was created,
 * deleted, renamed or reordered (a track's colour, say) — the menu then says
 * plain "Undo".
 */
export function describeFileChange(before: Paths, after: Paths, reordered = false): string | null {
  const created = [...after].filter(([id]) => !before.has(id)).map(([, p]) => p)
  const deleted = [...before].filter(([id]) => !after.has(id)).map(([, p]) => p)
  const renamed = [...after].filter(([id, p]) => before.has(id) && before.get(id) !== p)
    .map(([id, p]) => ({ from: before.get(id)!, to: p }))
  const kinds = [created, deleted, renamed].filter((list) => list.length > 0).length
  if (kinds > 1) return `Change ${created.length + deleted.length + renamed.length} files`
  if (created.length) return `Create ${someFiles(created)}`
  if (deleted.length) return `Delete ${someFiles(deleted)}`
  if (renamed.length) {
    if (!renamed.every((r) => baseName(r.from) === baseName(r.to))) {
      return `Rename ${someFiles(renamed.map((r) => r.from))}`
    }
    // Every file kept its name and changed folder. When they all left one folder
    // for a sibling of it, that folder was renamed.
    const from = new Set(renamed.map((r) => dirName(r.from)))
    const to = new Set(renamed.map((r) => dirName(r.to)))
    if (from.size === 1 && to.size === 1) {
      const [f] = from
      const [t] = to
      if (f && t && dirName(f) === dirName(t)) return `Rename folder ${baseName(f)}`
    }
    return `Move ${someFiles(renamed.map((r) => r.from))}`
  }
  return reordered ? 'Reorder files' : null
}

function ensureUndoManager(): Y.UndoManager {
  if (active) return active.um
  const doc = getActiveDoc()
  const files = doc.getMap('files') as Y.Map<Y.Map<unknown>>
  const fileOrder = doc.getMap('fileOrder') as Y.Map<Y.Array<string>>
  const subfolderOrder = doc.getMap('subfolderOrder') as Y.Map<Y.Array<string>>
  const childOrder = doc.getMap('childOrder') as Y.Map<Y.Array<string>>
  const orderMaps = [fileOrder, subfolderOrder, childOrder]
  // Include every existing inner file-map in the scope so deep changes
  // to a file's `path` / `meta` fields are captured too. Y.UndoManager's
  // scope check compares `transaction.changedParentTypes` against
  // `scope` by direct match — ancestors don't auto-bubble — so we have
  // to track inner maps explicitly.
  const um = new Y.UndoManager([files, fileOrder, subfolderOrder, childOrder], {
    trackedOrigins: new Set([STRUCT_ORIGIN]),
    captureTimeout: 300,
  })
  for (const inner of files.values()) {
    if (inner instanceof Y.Map) um.addToScope(inner)
  }
  // Track new file maps as they appear.
  const filesObserver = (event: Y.YMapEvent<Y.Map<unknown>>) => {
    for (const [key, change] of event.changes.keys) {
      if (change.action === 'add' || change.action === 'update') {
        const val = files.get(key)
        if (val instanceof Y.Map) um.addToScope(val)
      }
    }
  }
  files.observe(filesObserver)

  // The paths as they were before the transaction now ending. Refreshed in an
  // afterTransaction listener registered AFTER the undo manager's own, so when a
  // new step is announced (from inside the manager's listener) this still holds
  // the paths from before it.
  let knownPaths: Paths = filePaths(files)
  const filesType: unknown = files
  const touchesPaths = (tr: Y.Transaction): boolean => {
    for (const [type, keys] of tr.changed) {
      if (type === filesType) return true
      if (type._item?.parent === filesType && keys.has('path')) return true
    }
    return false
  }
  const refreshPaths = (tr: Y.Transaction) => {
    if (touchesPaths(tr)) knownPaths = filePaths(files)
  }
  doc.on('afterTransaction', refreshPaths)

  // A new step, or one that grew (changes within captureTimeout join the step
  // before them). Steps made BY an undo or redo are named in `step` below, from
  // the step they reverse.
  type StackEvent = { stackItem: { meta: Map<unknown, unknown> }; origin: unknown; changedParentTypes: Map<unknown, unknown> }
  const recordStep = (event: StackEvent, isNew: boolean) => {
    if (event.origin === um) return
    const meta = event.stackItem.meta
    if (isNew) meta.set(BEFORE, knownPaths)
    const before = (meta.get(BEFORE) as Paths | undefined) ?? knownPaths
    const after = filePaths(files)
    const reordered = meta.get(REORDERED) === true || orderMaps.some((m) => event.changedParentTypes.has(m))
    meta.set(REORDERED, reordered)
    meta.set(LABEL, describeFileChange(before, after, reordered))
    // Undoing this step removes the files it created.
    meta.set(REMOVES, [...after.keys()].filter((id) => !before.has(id)))
  }

  const listeners = new Set<Listener>()
  const notify = () => {
    for (const l of listeners) l()
  }
  const onStackItemAdded = (event: StackEvent) => {
    recordStep(event, true)
    notify()
  }
  const onStackItemUpdated = (event: StackEvent) => {
    recordStep(event, false)
    notify()
  }
  const onStackItemPopped = () => notify()
  const onStackCleared = () => notify()
  um.on('stack-item-added', onStackItemAdded)
  um.on('stack-item-updated', onStackItemUpdated)
  um.on('stack-item-popped', onStackItemPopped)
  um.on('stack-cleared', onStackCleared)
  active = {
    um,
    files,
    listeners,
    cleanup: () => {
      um.off('stack-item-added', onStackItemAdded)
      um.off('stack-item-updated', onStackItemUpdated)
      um.off('stack-item-popped', onStackItemPopped)
      um.off('stack-cleared', onStackCleared)
      doc.off('afterTransaction', refreshPaths)
      files.unobserve(filesObserver)
      um.destroy()
    },
  }
  return um
}

/** Call when the active project Y.Doc changes so the undo stack rebuilds. */
export function resetUndoManager(): void {
  if (active) {
    active.cleanup()
    active = null
  }
}

/** Stands for one step on the stack; `undoFiles` can be told to take only that step. */
export type FileStepToken = object

/** What an undo or redo of file changes did. */
export interface FileUndoResult {
  /** The step's name ("Create song.strudel"), or null when it has none. */
  label: string | null
  /** Paths of the files it removed. */
  removed: string[]
  /** Paths of the files it brought back. */
  restored: string[]
  /** The step that reverses this one (a Redo after an Undo), now next on the other stack. */
  reverse: FileStepToken | null
}

/**
 * Undo or redo the next file change, and say what it did. With `onlyIf`, only
 * when that step is still the next one — so a toast's Redo, pressed after
 * something else changed the files, never redoes a different step. Null when
 * nothing was undone.
 */
export function undoFiles(which: Which, onlyIf?: FileStepToken): FileUndoResult | null {
  const um = ensureUndoManager()
  const { files, listeners } = active!
  const from = which === 'undo' ? um.undoStack : um.redoStack
  if (onlyIf !== undefined && from[from.length - 1] !== onlyIf) return null
  const before = filePaths(files)
  const done = which === 'undo' ? um.undo() : um.redo()
  if (!done) return null
  const after = filePaths(files)
  const removed = [...before.keys()].filter((id) => !after.has(id))
  const restored = [...after.keys()].filter((id) => !before.has(id))
  const label = (done.meta.get(LABEL) as string | null | undefined) ?? null
  // The step that reverses this one has just been pushed onto the other stack.
  const to = which === 'undo' ? um.redoStack : um.undoStack
  const reverse = to[to.length - 1] ?? null
  if (reverse) {
    reverse.meta.set(LABEL, label)
    reverse.meta.set(REMOVES, restored)
  }
  for (const l of listeners) l()
  return {
    label,
    removed: removed.map((id) => before.get(id)!),
    restored: restored.map((id) => after.get(id)!),
    reverse,
  }
}

/** The next file change Undo or Redo would make, before it is made. */
export interface NextFileStep {
  label: string | null
  /** The files it would remove, with what is written in them now. */
  removes: Array<{ id: string; path: string; content: string }>
  token: FileStepToken
}

export function nextFileStep(which: Which): NextFileStep | null {
  const um = ensureUndoManager()
  const { files } = active!
  const stack = which === 'undo' ? um.undoStack : um.redoStack
  const item = stack[stack.length - 1]
  if (!item) return null
  const removes: NextFileStep['removes'] = []
  for (const id of (item.meta.get(REMOVES) as string[] | undefined) ?? []) {
    const file = files.get(id)
    if (!(file instanceof Y.Map)) continue
    const content = file.get('content')
    removes.push({ id, path: String(file.get('path') ?? id), content: content instanceof Y.Text ? content.toString() : '' })
  }
  return { label: (item.meta.get(LABEL) as string | null | undefined) ?? null, removes, token: item }
}

export function undo(): boolean {
  return undoFiles('undo') !== null
}

export function redo(): boolean {
  return undoFiles('redo') !== null
}

export function canUndo(): boolean {
  const um = ensureUndoManager()
  return um.undoStack.length > 0
}

export function canRedo(): boolean {
  const um = ensureUndoManager()
  return um.redoStack.length > 0
}

export function subscribeToUndoState(cb: Listener): () => void {
  ensureUndoManager()
  const listeners = active!.listeners
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
