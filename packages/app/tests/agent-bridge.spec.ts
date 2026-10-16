/**
 * The Claude Code bridge, end to end: the real stave-mcp CLI over stdio (as
 * Claude Code runs it), its WebSocket on 127.0.0.1, and a dev Stave tab paired
 * through the setting.
 *
 * What only a browser can show, and so what this file is for:
 *  - an agent's edit lands in the OPEN editor without moving the user's cursor,
 *    and is one Ctrl+Z (`setContent` alone would replace the whole text and
 *    throw the cursor to the end);
 *  - it is a LOCAL change, so History records it — a remote Yjs update would not
 *    be (historyDriver listens with { localOnly: true });
 *  - a playing song re-evaluates, and a bad edit's error comes back to the agent;
 *  - a visual on screen redraws, and the agent can see it;
 *  - a project the agent creates is the one the tab switches to, and is ready
 *    when the call answers: the next file lands in it and History records it.
 * The bridge's refusals (origin, host, token) are unit-tested in packages/mcp.
 */
import { createHash } from 'node:crypto'

import { expect, test, type Page } from '@playwright/test'

import { bootApp, editorValue, evalCode, seedCode, stopCode } from './_appBoot'
import { startStaveMcp, type StaveMcp } from './_staveMcp'

const SETTINGS_KEY = 'stave:agentBridge'

const SONG = `setcps(0.5)
$: s("bd sd bd sd").gain(0.8)
$: note("c3 e3 g3 e3").s("sawtooth").lpf(1200)
$: s("hh*8").gain(0.3)
`

let mcp: StaveMcp

test.beforeAll(async () => {
  mcp = await startStaveMcp()
})

test.afterAll(async () => {
  await mcp?.close()
})

/** Turn the bridge on with `code` before the app boots. */
async function preparePairing(page: Page, code: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* private mode */
      }
    },
    [SETTINGS_KEY, JSON.stringify({ enabled: true, code })] as const,
  )
}

/** File ▸ Editor Settings… ▸ Claude Code. */
async function openClaudeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('button', { name: 'Editor Settings...' }).click()
  await page.getByTestId('settings-nav-claude').click()
}

async function waitForPairing(): Promise<void> {
  await expect.poll(() => mcp.text('stave_status'), { timeout: 15_000 }).toContain('Connected to a Stave tab')
}

/** The open song's path, from the agent's own view of the project. */
async function openSongPath(): Promise<string> {
  const list = await mcp.text('list_files')
  const line = list.split('\n').find((l) => / — strudel, .*\[open/.test(l))
  expect(line, list).toBeTruthy()
  return line!.split(' — ')[0]
}

async function cursor(page: Page): Promise<{ lineNumber: number; column: number } | null> {
  return page.evaluate(() => {
    const eds = (window as unknown as { monaco: { editor: { getEditors(): Array<{ getModel(): { getLanguageId(): string } | null; getPosition(): { lineNumber: number; column: number } | null }> } } }).monaco.editor.getEditors()
    const ed = eds.find((e) => e.getModel()?.getLanguageId() === 'strudel')
    const p = ed?.getPosition()
    return p ? { lineNumber: p.lineNumber, column: p.column } : null
  })
}

async function editorCommand(page: Page, command: 'undo' | 'redo'): Promise<void> {
  await page.evaluate((cmd) => {
    const eds = (window as unknown as { monaco: { editor: { getEditors(): Array<{ getModel(): { getLanguageId(): string } | null; trigger(src: string, id: string, payload: unknown): void }> } } }).monaco.editor.getEditors()
    eds.find((e) => e.getModel()?.getLanguageId() === 'strudel')?.trigger('spec', cmd, null)
  }, command)
}

test('pairs from Settings → Claude Code', async ({ page }) => {
  await bootApp(page)
  await openClaudeSettings(page)
  const status = page.getByTestId('agent-bridge-status')
  await expect(status).toHaveAttribute('data-state', 'off')

  await page.getByTestId('agent-bridge-enabled').click()
  await expect(status).toHaveAttribute('data-state', 'no-code')
  await page.getByTestId('agent-bridge-code').fill(mcp.pairingCode)
  await page.getByTestId('agent-bridge-pair').click()

  await expect(status).toHaveAttribute('data-state', 'connected')
  await waitForPairing()
})

test('a refused pairing code stops the tab trying, and Settings says why', async ({ page }) => {
  await preparePairing(page, `${mcp.port}-wrongtoken000000000000`)
  await bootApp(page)
  await openClaudeSettings(page)
  await expect(page.getByTestId('agent-bridge-status')).toHaveAttribute('data-state', 'refused')
  await expect(page.getByTestId('agent-bridge-status')).toContainText('refused this pairing code')
  expect(await mcp.text('stave_status')).toContain('No Stave tab is connected')
})

test('an edit lands in the open editor: the cursor stays, one undo reverts it, History records it, a bad edit reports its error', async ({ page }) => {
  await preparePairing(page, mcp.pairingCode)
  await bootApp(page)
  await seedCode(page, SONG)
  await waitForPairing()
  const path = await openSongPath()

  expect(await mcp.text('read_file', { path })).toBe(SONG)

  // The user's cursor sits on line 3, between the two lines the agent changes.
  await page.evaluate(() => {
    const eds = (window as unknown as { monaco: { editor: { getEditors(): Array<{ getModel(): { getLanguageId(): string } | null; setPosition(p: unknown): void }> } } }).monaco.editor.getEditors()
    eds.find((e) => e.getModel()?.getLanguageId() === 'strudel')?.setPosition({ lineNumber: 3, column: 9 })
  })

  const result = await mcp.text('edit_file', {
    path,
    edits: [
      { old_text: 'setcps(0.5)', new_text: 'setcps(0.6)' },
      { old_text: 's("hh*8").gain(0.3)', new_text: 's("hh*16").gain(0.25)' },
    ],
  })
  const edited = SONG.replace('setcps(0.5)', 'setcps(0.6)').replace('s("hh*8").gain(0.3)', 's("hh*16").gain(0.25)')
  expect(result).toContain(`Edited ${path}: 2 regions changed, applied in the open editor`)
  expect(result).toContain('recorded in History')
  expect(result).toContain('no errors')
  await expect.poll(() => editorValue(page)).toBe(edited)
  expect(await cursor(page)).toEqual({ lineNumber: 3, column: 9 })

  // One undo step, in the editor, like any other surface's edit.
  await editorCommand(page, 'undo')
  await expect.poll(() => editorValue(page)).toBe(SONG)
  await editorCommand(page, 'redo')
  await expect.poll(() => editorValue(page)).toBe(edited)

  // History has the agent's change, under its own label.
  await page.getByRole('button', { name: 'Version History' }).click()
  await expect(page.getByText(`Claude Code: edited ${path}`).first()).toBeVisible()

  // A bad edit: the song is not playing, so it is checked silently — and the
  // error still comes back to the agent.
  const bad = await mcp.text('edit_file', { path, edits: [{ old_text: '.lpf(1200)', new_text: '.lpf(1200).squish2()' }] })
  expect(bad).toContain('1 error — evaluated silently')
  expect(bad).toContain('squish2 is not a function')
  const fixed = await mcp.text('edit_file', { path, edits: [{ old_text: '.squish2()', new_text: '' }] })
  expect(fixed).toContain('no errors')
})

test('while the song plays, an edit is re-evaluated live and a bad one reports its error', async ({ page }) => {
  await preparePairing(page, mcp.pairingCode)
  await bootApp(page)
  await seedCode(page, SONG)
  await waitForPairing()
  const path = await openSongPath()

  await evalCode(page)
  await expect.poll(() => mcp.text('stave_status'), { timeout: 15_000 }).toContain(`Playing: ${path}`)

  const good = await mcp.text('edit_file', { path, edits: [{ old_text: 'bd sd bd sd', new_text: 'bd*2 sd bd sd' }] })
  expect(good).toContain('no errors — evaluated live (the song is playing)')

  const bad = await mcp.text('edit_file', { path, edits: [{ old_text: 'c3 e3 g3 e3")', new_text: 'c3 e3 g3 e3"' }] })
  expect(bad).toMatch(/1 error — evaluated live/)

  const check = await mcp.text('get_diagnostics', { path })
  expect(check).toMatch(/1 error — evaluated live/)
  await stopCode(page)
})

test('a new Hydra visual: created, put on screen, edited live, captured, and its errors reported', async ({ page }) => {
  await preparePairing(page, mcp.pairingCode)
  await bootApp(page)
  await waitForPairing()

  const created = await mcp.text('create_file', { path: 'visuals/agent.hydra', content: 's.osc(8, 0.1, 1.2).color(1, 0.3, 0.6).out()' })
  expect(created).toContain('Created visuals/agent.hydra')
  expect(created).toContain('compiled only')
  const offScreen = await mcp.call('capture_canvas', { path: 'visuals/agent.hydra' })
  expect(offScreen.isError).toBe(true)

  // The user opens it and presses its Play: it draws as the backdrop.
  await page.locator('[data-sidebar] [data-file-tree-item]').filter({ has: page.locator('text="agent.hydra"') }).first().click()
  await page.getByTestId('viz-chrome-open-preview').click()

  const snapshot = async (): Promise<{ text: string; hash: string }> => {
    const r = await mcp.call('capture_canvas', { path: 'visuals/agent.hydra', max_width: 320 })
    expect(r.isError, JSON.stringify(r.content[0])).toBeFalsy()
    const image = r.content.find((c) => c.type === 'image')!
    expect(image.mimeType).toBe('image/png')
    return { text: r.content[0].text ?? '', hash: createHash('md5').update(image.data!).digest('hex') }
  }
  await expect.poll(async () => (await snapshot()).text, { timeout: 15_000 }).not.toContain('same colour')
  const before = await snapshot()

  const edit = await mcp.text('edit_file', {
    path: 'visuals/agent.hydra',
    edits: [{ old_text: 's.osc(8, 0.1, 1.2).color(1, 0.3, 0.6)', new_text: 's.osc(30, 0, 1.2).kaleid(5).color(0.2, 1, 0.5)' }],
  })
  expect(edit).toContain('no errors — recompiled in its on-screen preview')
  await expect.poll(async () => (await snapshot()).hash, { timeout: 10_000 }).not.toBe(before.hash)

  const runtimeError = await mcp.text('edit_file', { path: 'visuals/agent.hydra', edits: [{ old_text: '.kaleid(5)', new_text: '.kaleidoscope(5)' }] })
  expect(runtimeError).toContain('kaleidoscope is not a function')

  const syntaxError = await mcp.text('edit_file', { path: 'visuals/agent.hydra', edits: [{ old_text: '.kaleidoscope(5)', new_text: '.kaleid(5' }] })
  expect(syntaxError).toContain('SyntaxError')
})

test('a new project: the tab switches to it, the next file lands in it, and open_project goes back', async ({ page }) => {
  await preparePairing(page, mcp.pairingCode)
  await bootApp(page)
  await waitForPairing()

  const before = await mcp.text('list_projects')
  const original = /- "(.+)" \[open\] — id (\S+),/.exec(before)
  expect(original, before).toBeTruthy()
  const [, originalName, originalId] = original!

  const name = `Agent song ${Date.now().toString(36)}`
  const created = await mcp.text('create_project', { name })
  expect(created).toContain(`Created project "${name}"`)
  expect(created).toContain('The file tools now act on this project.')
  expect(await mcp.text('stave_status')).toContain(`Project: "${name}"`)

  // Straight after: no waiting here, the call answered once the project was ready.
  const file = await mcp.text('create_file', { path: 'agent-song.strudel', content: SONG })
  expect(file).toContain('Created agent-song.strudel')
  // Its own commit, not folded into the new project's first one.
  expect(file).toContain('recorded in History')

  const files = await mcp.text('list_files')
  expect(files).toContain(`Project "${name}":`)
  expect(files).toContain('agent-song.strudel — strudel, 4 lines')
  const fileInTree = page.locator('[data-sidebar] [data-file-tree-item]').filter({ has: page.locator('text="agent-song.strudel"') })
  await expect(fileInTree).toBeVisible()

  const listed = await mcp.text('list_projects')
  expect(listed).toContain(`- "${name}" [open] — id `)
  expect(listed).toContain(`- "${originalName}" — id ${originalId},`)

  // Back to where the user was: the agent's file is not in that project.
  expect(await mcp.text('open_project', { id: originalId })).toContain(`Switched the Stave tab to project "${originalName}"`)
  expect(await mcp.text('list_files')).not.toContain('agent-song.strudel')
  await expect(fileInTree).toHaveCount(0)

  // And by name to the new one again: the file was saved with it.
  expect(await mcp.text('open_project', { name })).toContain(`Switched the Stave tab to project "${name}"`)
  expect(await mcp.text('read_file', { path: 'agent-song.strudel' })).toBe(SONG)
  await expect(fileInTree).toBeVisible()
  await page.getByRole('button', { name: 'Version History' }).click()
  await expect(page.getByText('Claude Code: created agent-song.strudel').first()).toBeVisible()
})
