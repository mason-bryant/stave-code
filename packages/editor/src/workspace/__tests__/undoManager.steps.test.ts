/**
 * Each project undo step is named, and says what it removed or brought back.
 *
 * Undoing a file's creation removes the file and everything typed into it. Edit →
 * Undo ran that silently, and a song typed into a new file vanished. The app now
 * names the step in the menu ("Undo Create song.strudel"), asks before removing
 * written work, and offers the way back — which this suite pins at the source.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  __resetWorkspaceFilesForTests,
  createWorkspaceFile,
  deleteWorkspaceFile,
  getFile,
  renameWorkspaceFile,
  setChildOrder,
  setContent,
  setTrackMeta,
} from '../WorkspaceFile'
import {
  canRedo,
  describeFileChange,
  nextFileStep,
  redo,
  resetUndoManager,
  undo,
  undoFiles,
  withStructBatch,
} from '../undoManager'

const label = (which: 'undo' | 'redo') => nextFileStep(which)?.label ?? null

/**
 * A fresh, empty history. Changes within the manager's capture window (300ms)
 * join one step, so a test that wants the next change as a step of its own
 * starts over — and makes the manager before the change, as the app does.
 */
function freshHistory(): void {
  resetUndoManager()
  nextFileStep('undo')
}

describe('describeFileChange', () => {
  const paths = (...entries: Array<[string, string]>) => new Map(entries)

  it('names one file, and counts several', () => {
    expect(describeFileChange(paths(), paths(['a', 'song.strudel']))).toBe('Create song.strudel')
    expect(describeFileChange(paths(), paths(['a', 'x.strudel'], ['b', 'y.p5']))).toBe('Create 2 files')
    expect(describeFileChange(paths(['a', 'dir/old.strudel']), paths())).toBe('Delete old.strudel')
  })

  it('tells a rename from a move from a folder rename', () => {
    expect(describeFileChange(paths(['a', 'a.strudel']), paths(['a', 'b.strudel']))).toBe('Rename a.strudel')
    expect(describeFileChange(paths(['a', 'a.strudel']), paths(['a', 'beats/a.strudel']))).toBe('Move a.strudel')
    expect(
      describeFileChange(
        paths(['a', 'drums/a.strudel'], ['b', 'drums/b.strudel']),
        paths(['a', 'beats/a.strudel'], ['b', 'beats/b.strudel']),
      ),
    ).toBe('Rename folder drums')
  })

  it('a reorder, a mix, and nothing a file list shows', () => {
    const same = paths(['a', 'a.strudel'])
    expect(describeFileChange(same, same, true)).toBe('Reorder files')
    expect(describeFileChange(paths(['a', 'a.strudel']), paths(['b', 'b.strudel']))).toBe('Change 2 files')
    expect(describeFileChange(same, same)).toBeNull()
  })
})

describe('project undo steps', () => {
  beforeEach(() => {
    __resetWorkspaceFilesForTests()
    freshHistory()
  })

  it('undoing a creation says it removed the file; redo brings it back WITH what was typed into it', () => {
    createWorkspaceFile('s', 'song.strudel', '', 'strudel')
    // Typing is not a step of the project undo (Monaco keeps its own history).
    setContent('s', '$: s("bd sd")\n$: note("c3 e3")')
    expect(label('undo')).toBe('Create song.strudel')
    expect(nextFileStep('undo')?.removes).toEqual([
      { id: 's', path: 'song.strudel', content: '$: s("bd sd")\n$: note("c3 e3")' },
    ])

    const undone = undoFiles('undo')
    expect(undone).toMatchObject({ label: 'Create song.strudel', removed: ['song.strudel'], restored: [] })
    expect(getFile('s')).toBeUndefined()
    // The redo of it carries the same name, and removes nothing.
    expect(label('redo')).toBe('Create song.strudel')
    expect(nextFileStep('redo')?.removes).toEqual([])

    const redone = undoFiles('redo', undone!.reverse!)
    expect(redone).toMatchObject({ removed: [], restored: ['song.strudel'] })
    expect(getFile('s')?.content).toBe('$: s("bd sd")\n$: note("c3 e3")')
    expect(label('undo')).toBe('Create song.strudel')
  })

  it('a delete: undo brings the file back, and its redo is the step that removes it', () => {
    createWorkspaceFile('a', 'a.strudel', 'note("c")', 'strudel')
    freshHistory()
    deleteWorkspaceFile('a')
    expect(label('undo')).toBe('Delete a.strudel')
    expect(nextFileStep('undo')?.removes).toEqual([])

    expect(undoFiles('undo')).toMatchObject({ removed: [], restored: ['a.strudel'] })
    expect(nextFileStep('redo')).toMatchObject({
      label: 'Delete a.strudel',
      removes: [{ id: 'a', path: 'a.strudel', content: 'note("c")' }],
    })
  })

  it('a step only goes when it is still the next one', () => {
    createWorkspaceFile('a', 'a.strudel', '', 'strudel')
    const undone = undoFiles('undo')!
    // Something else changes the files: the redo stack is cleared.
    createWorkspaceFile('b', 'b.strudel', '', 'strudel')
    expect(canRedo()).toBe(false)
    expect(undoFiles('redo', undone.reverse!)).toBeNull()
    // …and an undo told to take a step that is no longer next leaves the stack alone.
    expect(undoFiles('undo', undone.reverse!)).toBeNull()
    expect(getFile('b')).toBeDefined()
  })

  it('names renames, moves and reorders; a batch is one step with one name', () => {
    createWorkspaceFile('a', 'lead.strudel', '', 'strudel')
    createWorkspaceFile('b', 'b.strudel', '', 'strudel')
    expect(label('undo')).toBe('Create 2 files')
    freshHistory()

    renameWorkspaceFile('a', 'a2.strudel')
    expect(label('undo')).toBe('Rename lead.strudel')
    freshHistory()

    withStructBatch(() => {
      renameWorkspaceFile('b', 'beats/b.strudel')
      setChildOrder('beats', ['f:b'])
    })
    expect(label('undo')).toBe('Move b.strudel')
    freshHistory()

    withStructBatch(() => setChildOrder('', ['f:a2', 'd:beats']))
    expect(label('undo')).toBe('Reorder files')
    expect(nextFileStep('undo')?.removes).toEqual([])
    freshHistory()

    setTrackMeta('a', 'drums', { color: '#f00' })
    expect(nextFileStep('undo')).toMatchObject({ label: null, removes: [] })
  })

  it('the boolean undo/redo still work, and keep the names on both stacks', () => {
    createWorkspaceFile('a', 'a.strudel', '', 'strudel')
    expect(undo()).toBe(true)
    expect(label('redo')).toBe('Create a.strudel')
    expect(redo()).toBe(true)
    expect(label('undo')).toBe('Create a.strudel')
    expect(getFile('a')).toBeDefined()
  })
})
