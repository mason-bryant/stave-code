import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { StaveBridge } from '../bridge'
import { DEFAULT_ORIGINS, pairingCode } from '../config'
import { ERROR_CODES, type Diagnostics, type ProjectOpened, type WriteResult } from '../protocol'
import { createStaveMcpServer } from '../server'
import { dial, type Handler } from './fakePage'

const TOKEN = 'tools-test-token-0123456789'
const DEV = 'http://localhost:3000'

let bridge: StaveBridge
let client: Client

beforeEach(async () => {
  bridge = new StaveBridge({ port: 0, token: TOKEN, origins: DEFAULT_ORIGINS })
  await bridge.start()
  const server = createStaveMcpServer(bridge, { pairingCode: () => pairingCode(bridge.status().port, TOKEN) })
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
})

afterEach(async () => {
  await client.close()
  await bridge.close()
})

type ToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

function textOf(r: ToolResult): string {
  return r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

const NO_ERRORS: Diagnostics = { path: 'a.strudel', language: 'strudel', evaluated: 'live', errors: [], warnings: [] }

function pageWith(handlers: Record<string, Handler>) {
  return dial(bridge.status().port, { origin: DEV, token: TOKEN, handlers })
}

describe('Stave MCP tools', () => {
  it('lists the tools Claude Code will see', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'capture_canvas',
        'create_file',
        'create_project',
        'edit_file',
        'get_diagnostics',
        'list_files',
        'list_projects',
        'open_project',
        'read_file',
        'rename_file',
        'stave_status',
        'write_file',
      ].sort(),
    )
  })

  it('tells the agent how to pair when no tab is connected', async () => {
    const r = await callTool('list_files')
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('No Stave tab is connected')
    expect(textOf(r)).toContain(`${bridge.status().port}-${TOKEN}`)

    const status = await callTool('stave_status')
    expect(status.isError).toBeFalsy()
    expect(textOf(status)).toContain('Settings → Claude Code')
  })

  it('stave_status describes the paired tab', async () => {
    await pageWith({
      'project.status': () => ({
        project: { id: 'p1', name: 'Test project' },
        ready: true,
        timeTravel: false,
        files: 3,
        openFiles: ['a.strudel'],
        playing: ['a.strudel'],
      }),
    })
    const t = textOf(await callTool('stave_status'))
    expect(t).toContain('Connected to a Stave tab at http://localhost:3000')
    expect(t).toContain('Project: "Test project" (3 files)')
    expect(t).toContain('Playing: a.strudel')
  })

  it('list_files and read_file pass through', async () => {
    await pageWith({
      'files.list': () => ({
        project: { id: 'p1', name: 'Test project' },
        files: [
          { path: 'a.strudel', language: 'strudel', lines: 4, chars: 40, open: true, playing: false },
          { path: 'v.hydra', language: 'hydra', lines: 1, chars: 10, open: false, playing: false },
        ],
      }),
      'files.read': (p) => ({ path: (p as { path: string }).path, language: 'strudel', content: 's("bd sd")\n' }),
    })
    const list = textOf(await callTool('list_files'))
    expect(list).toContain('a.strudel — strudel, 4 lines [open]')
    expect(list).toContain('v.hydra — hydra, 1 line')
    expect(textOf(await callTool('read_file', { path: 'a.strudel' }))).toBe('s("bd sd")\n')
  })

  it('edit_file maps snake_case edits onto the protocol and reports the outcome', async () => {
    let received: unknown = null
    await pageWith({
      'files.edit': (p) => {
        received = p
        const r: WriteResult = {
          path: 'a.strudel',
          language: 'strudel',
          changed: true,
          regions: 1,
          appliedVia: 'editor',
          commit: 'c1',
          diagnostics: {
            ...NO_ERRORS,
            errors: [{ message: 'Unexpected token', line: 2, column: 5, suggestion: 'sound' }],
          },
        }
        return r
      },
    })
    const r = await callTool('edit_file', {
      path: 'a.strudel',
      edits: [{ old_text: 'bd', new_text: 'hh', replace_all: true }],
    })
    expect(received).toEqual({ path: 'a.strudel', edits: [{ oldText: 'bd', newText: 'hh', replaceAll: true }] })
    const t = textOf(r)
    expect(t).toContain('Edited a.strudel: 1 region changed, applied in the open editor')
    expect(t).toContain('recorded in History')
    expect(t).toContain('1 error')
    expect(t).toContain('line 2:5: Unexpected token (did you mean sound?)')
  })

  it('a tab-side refusal becomes a tool error with the tab’s message', async () => {
    await pageWith({
      'files.write': () => {
        throw Object.assign(new Error('Stave is showing a past version from History; exit it to edit.'), { code: ERROR_CODES.readOnly })
      },
    })
    const r = await callTool('write_file', { path: 'a.strudel', content: 'x' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('past version')
  })

  it('capture_canvas returns the picture as image content', async () => {
    await pageWith({
      'canvas.capture': () => ({
        path: 'v.hydra',
        source: 'preview',
        width: 320,
        height: 180,
        mimeType: 'image/png',
        data: 'iVBORw0KGgo=',
        blank: false,
      }),
    })
    const r = await callTool('capture_canvas', { path: 'v.hydra' })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('Snapshot of v.hydra (preview), 320×180.')
    expect(r.content.find((c) => c.type === 'image')).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' })
  })

  it('get_diagnostics says how the file was checked', async () => {
    await pageWith({
      'diagnostics.get': () => ({ ...NO_ERRORS, path: 'v.hydra', language: 'hydra', evaluated: 'compile', note: 'Open its preview to see draw-time errors.' }),
    })
    const t = textOf(await callTool('get_diagnostics', { path: 'v.hydra' }))
    expect(t).toContain('v.hydra: no errors — compiled only')
    expect(t).toContain('Open its preview')
  })

  it('list_projects shows each project, the open one marked', async () => {
    const at = Date.UTC(2026, 9, 16, 19, 1)
    await pageWith({
      'projects.list': () => ({
        projects: [
          { id: 'p1', name: 'Night drive', open: true, createdAt: at, lastOpenedAt: at },
          { id: 'p2', name: 'Sketch', open: false, createdAt: at, lastOpenedAt: at - 86_400_000 },
        ],
      }),
    })
    const t = textOf(await callTool('list_projects'))
    expect(t).toContain('2 projects, most recently opened first:')
    expect(t).toContain('- "Night drive" [open] — id p1, last opened 2026-10-16 19:01 UTC')
    expect(t).toContain('- "Sketch" — id p2, last opened 2026-10-15 19:01 UTC')
  })

  it('create_project passes the name and says the project is ready for files', async () => {
    let received: unknown = null
    await pageWith({
      'projects.create': (p) => {
        received = p
        const r: ProjectOpened = { project: { id: 'p9', name: 'Song for Ada' }, switched: true, ready: true, files: 8 }
        return r
      },
    })
    const t = textOf(await callTool('create_project', { name: '  Song for Ada ' }))
    expect(received).toEqual({ name: 'Song for Ada' })
    expect(t).toContain('Created project "Song for Ada" (id p9) and switched the Stave tab to it.')
    expect(t).toContain('only Stave\'s bundled visuals under preset/ (8 files)')
    expect(t).toContain('The file tools now act on this project.')

    const blank = await callTool('create_project', { name: '   ' })
    expect(blank.isError).toBe(true)
  })

  it('a project that has not finished loading says to wait before writing', async () => {
    await pageWith({
      'projects.create': () => ({ project: { id: 'p9', name: 'Slow' }, switched: true, ready: false, files: 0 }),
    })
    expect(textOf(await callTool('create_project', { name: 'Slow' }))).toContain('has not finished loading yet; call stave_status')
  })

  it('open_project takes an id or a name, not both or neither', async () => {
    const received: unknown[] = []
    await pageWith({
      'projects.open': (p) => {
        received.push(p)
        const already = (p as { id?: string }).id === 'p1'
        return { project: { id: already ? 'p1' : 'p2', name: already ? 'Night drive' : 'Sketch' }, switched: !already, ready: true, files: 3 }
      },
    })
    expect(textOf(await callTool('open_project', { name: 'Sketch' }))).toContain('Switched the Stave tab to project "Sketch" (id p2, 3 files).')
    expect(textOf(await callTool('open_project', { id: 'p1' }))).toContain('"Night drive" (id p1, 3 files) was already open; nothing changed.')
    expect(received).toEqual([{ name: 'Sketch' }, { id: 'p1' }])

    for (const args of [{}, { id: 'p1', name: 'Sketch' }]) {
      const r = await callTool('open_project', args)
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('either `id` or `name`')
    }
    expect(received).toHaveLength(2)
  })

  it('a project refusal from the tab comes back as a tool error with its message', async () => {
    await pageWith({
      'projects.create': () => {
        throw Object.assign(new Error('Storage is full and the open project has changes the browser could not save'), { code: ERROR_CODES.unsaved })
      },
    })
    const r = await callTool('create_project', { name: 'New' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('Storage is full')
  })

  it('a tab from before the project tools says to reload it', async () => {
    await pageWith({}) // answers every request with -32601, as an older tab does
    const r = await callTool('list_projects')
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('older Stave that cannot do this yet')
    expect(textOf(r)).toContain('reload the tab')
  })
})
