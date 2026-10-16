import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { StaveBridge } from '../bridge'
import { DEFAULT_ORIGINS, pairingCode } from '../config'
import { ERROR_CODES, type Diagnostics, type WriteResult } from '../protocol'
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
        'edit_file',
        'get_diagnostics',
        'list_files',
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
})
