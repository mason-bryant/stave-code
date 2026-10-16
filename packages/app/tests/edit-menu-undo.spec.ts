/**
 * Edit → Undo acts where the user was working, and never removes a file silently.
 *
 * A user lost a song this way. Edit → Undo always undid the last FILE change
 * (create, delete, rename, move), never typing — and the last file change was
 * creating the file they were typing the song into. So it removed the file and the
 * song with it, with no question and no notice. ⌘Z did the same whenever focus was
 * outside a code editor.
 *
 * Now the menu acts where ⌘Z would have just before it was opened: in the code
 * editor the user was typing in. Elsewhere it names the file change it will undo,
 * asks before removing a file with something written in it, and says what it
 * removed, with Redo on the notice.
 */
import { test, expect, type Page } from '@playwright/test'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const SONG = '$: s("bd sd hh sd")'

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('[data-bottom-panel="root"]').waitFor({ timeout: 20_000 })
  await page.waitForFunction(
    () => ((window as any).monaco?.editor?.getEditors?.()?.length ?? 0) > 0,
    { timeout: 20_000 },
  )
  await page.waitForTimeout(400)
}

/** Create a file through the tab bar's "+", as a user does; returns its row in the Files panel. */
async function newFile(page: Page, name: string) {
  await page.locator('[data-testid^="tab-new-file-"]').first().click()
  await page.locator('input[placeholder="sketch.strudel"]').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  const row = page.locator('[data-file-tree-item]', { hasText: name })
  await expect(row).toBeVisible({ timeout: 4000 })
  return row
}

/** Open the file from its row and type into its code editor. */
async function typeInto(page: Page, row: ReturnType<Page['locator']>, text: string): Promise<string> {
  const id = (await row.getAttribute('data-file-tree-item'))!
  await row.click()
  const editor = page.locator(`[data-workspace-view="editor"][data-file-id="${id}"] .monaco-editor`)
  await editor.waitFor({ timeout: 10_000 })
  await editor.click()
  await page.keyboard.type(text)
  await page.waitForTimeout(300)
  return id
}

/** What the code editor showing file `id` holds. */
const editorText = (page: Page, id: string): Promise<string | null> =>
  page.evaluate((fileId) => {
    const host = document.querySelector(`[data-workspace-view="editor"][data-file-id="${fileId}"]`)
    const ed = (window as any).monaco.editor
      .getEditors()
      .find((e: any) => host?.contains(e.getDomNode()))
    return ed ? ed.getModel().getValue() : null
  }, id)

/** The Edit menu's Undo item: open the menu, find the item whose label starts "Undo". */
async function openEditMenu(page: Page) {
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  return page.locator('[data-stave-menu-item]').filter({ hasText: /^Undo/ })
}

test('Edit → Undo after typing in a new file undoes the typing, and the file stays', async ({ page }) => {
  await boot(page)
  const name = `menu-undo-${Date.now()}.strudel`
  const row = await newFile(page, name)
  // One word: the code editor undoes typing a word at a time.
  const id = await typeInto(page, row, 'drums')
  expect(await editorText(page, id)).toBe('drums')

  const undo = await openEditMenu(page)
  // It acts on the code editor the user was typing in, so it does not name a file change.
  await expect(undo).toHaveText(/^Undo\s*⌘Z$/)
  await undo.click()
  await page.waitForTimeout(300)

  expect(await editorText(page, id)).toBe('')
  await expect(row).toBeVisible()
  await expect(page.getByText(`Remove ${name}?`)).toHaveCount(0)
  // Focus is back in the editor: the next key lands in the code.
  await page.keyboard.type('x')
  await page.waitForTimeout(200)
  expect(await editorText(page, id)).toBe('x')

  // With the editor's history used up, Undo is greyed out — it never reaches
  // past the editor to remove the file.
  await page.keyboard.press(`${MOD}+z`)
  await page.waitForTimeout(200)
  expect(await editorText(page, id)).toBe('')
  await expect(await openEditMenu(page)).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(row).toBeVisible()
})

test('⌘Z outside any editor asks before removing a file with a song, says so, and Redo brings the song back', async ({ page }) => {
  await boot(page)
  const name = `cmdz-undo-${Date.now()}.strudel`
  const row = await newFile(page, name)
  const id = await typeInto(page, row, SONG)
  // A file row leaves focus on the page, outside every surface that edits code.
  await row.click()
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)

  // No: the file and the song stay.
  await page.keyboard.press(`${MOD}+z`)
  await expect(page.getByText(`Remove ${name}?`)).toBeVisible({ timeout: 4000 })
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(row).toBeVisible()

  // Yes: removed, and the notice names it with the way back.
  await page.keyboard.press(`${MOD}+z`)
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(row).toHaveCount(0, { timeout: 4000 })
  const toast = page.getByTestId('toast').filter({ hasText: `Removed ${name}` })
  await expect(toast).toBeVisible()
  await toast.getByTestId('toast-action').filter({ hasText: 'Redo' }).click()

  await expect(row).toBeVisible({ timeout: 4000 })
  await expect(page.getByTestId('toast').filter({ hasText: `Brought back ${name}` })).toBeVisible()
  await row.click()
  await expect.poll(() => editorText(page, id), { timeout: 10_000 }).toBe(SONG)
})

test('Edit → Undo outside any editor names the file change, and does the same as ⌘Z', async ({ page }) => {
  await boot(page)
  const name = `menu-files-${Date.now()}.strudel`
  const row = await newFile(page, name)
  await row.click()

  const undo = await openEditMenu(page)
  await expect(undo).toContainText(`Undo Create ${name}`)
  await undo.click()
  // An empty file goes without a question; the notice still names it.
  await expect(row).toHaveCount(0, { timeout: 4000 })
  await expect(page.getByTestId('toast').filter({ hasText: `Removed ${name}` })).toBeVisible()

  // The menu's Redo is named too, and brings it back.
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const redo = page.locator('[data-stave-menu-item]').filter({ hasText: /^Redo/ })
  await expect(redo).toContainText(`Redo Create ${name}`)
  await redo.click()
  await expect(row).toBeVisible({ timeout: 4000 })
})
