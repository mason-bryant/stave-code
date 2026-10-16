import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { BridgeError, StaveBridge } from '../bridge'
import { DEFAULT_ORIGINS, originAllowed } from '../config'
import { CLOSE_CODES, ERROR_CODES } from '../protocol'
import { dial, until } from './fakePage'

const TOKEN = 'test-token-0123456789abcdef'
const DEV = 'http://localhost:3000'

let bridges: StaveBridge[] = []
let blockers: Server[] = []

async function startBridge(opts: Partial<ConstructorParameters<typeof StaveBridge>[0]> = {}): Promise<StaveBridge> {
  const bridge = new StaveBridge({ port: 0, token: TOKEN, origins: DEFAULT_ORIGINS, ...opts })
  await bridge.start()
  bridges.push(bridge)
  return bridge
}

afterEach(async () => {
  await Promise.all(bridges.map((b) => b.close()))
  await Promise.all(blockers.map((s) => new Promise((r) => s.close(r))))
  bridges = []
  blockers = []
})

describe('originAllowed', () => {
  it('takes the hosted app and a dev server on any port, and nothing that only looks like them', () => {
    expect(originAllowed('https://stave.live', DEFAULT_ORIGINS)).toBe(true)
    expect(originAllowed('http://localhost:3000', DEFAULT_ORIGINS)).toBe(true)
    expect(originAllowed('http://localhost', DEFAULT_ORIGINS)).toBe(true)
    expect(originAllowed('http://127.0.0.1:4100', DEFAULT_ORIGINS)).toBe(true)
    expect(originAllowed('http://[::1]:3000', DEFAULT_ORIGINS)).toBe(true)

    expect(originAllowed('http://stave.live', DEFAULT_ORIGINS)).toBe(false)
    expect(originAllowed('https://stave.live.evil.example', DEFAULT_ORIGINS)).toBe(false)
    expect(originAllowed('https://evil.example', DEFAULT_ORIGINS)).toBe(false)
    expect(originAllowed('http://localhost.evil.example:3000', DEFAULT_ORIGINS)).toBe(false)
    expect(originAllowed('https://localhost:3000', DEFAULT_ORIGINS)).toBe(false)
    expect(originAllowed('null', DEFAULT_ORIGINS)).toBe(false)
    expect(originAllowed(undefined, DEFAULT_ORIGINS)).toBe(false)
    // an Origin is scheme://host[:port] and nothing more
    expect(originAllowed('https://stave.live/', DEFAULT_ORIGINS)).toBe(false)
  })
})

describe('StaveBridge — who may connect', () => {
  it('refuses a page from an origin that is not on the list, before the socket opens', async () => {
    const bridge = await startBridge()
    await expect(dial(bridge.status().port, { origin: 'https://evil.example', token: TOKEN })).rejects.toThrow('HTTP 403')
    expect(bridge.status().page).toBeNull()
  })

  it('refuses a connection with no Origin at all', async () => {
    const bridge = await startBridge()
    await expect(dial(bridge.status().port, { token: TOKEN })).rejects.toThrow('HTTP 403')
  })

  it('refuses a Host that is not this machine (DNS rebinding)', async () => {
    const bridge = await startBridge()
    const port = bridge.status().port
    await expect(dial(port, { origin: DEV, token: TOKEN, host: `rebound.example:${port}` })).rejects.toThrow('HTTP 403')
  })

  it('refuses the wrong pairing code and closes', async () => {
    const bridge = await startBridge()
    const page = await dial(bridge.status().port, { origin: DEV, token: 'not-the-token-000000' })
    expect(page.hello.error?.code).toBe(ERROR_CODES.badToken)
    expect((await page.closed()).code).toBe(CLOSE_CODES.badToken)
    expect(bridge.status().page).toBeNull()
  })

  it('refuses a tab that speaks another protocol version', async () => {
    const bridge = await startBridge()
    const page = await dial(bridge.status().port, { origin: DEV, token: TOKEN, protocol: 99 })
    expect(page.hello.error).toBeDefined()
    expect((await page.closed()).code).toBe(CLOSE_CODES.badProtocol)
  })

  it('closes a socket that never says hello', async () => {
    const bridge = await startBridge({ helloTimeoutMs: 50 })
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.status().port}/`, { origin: DEV })
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)))
    expect(code).toBe(CLOSE_CODES.helloTimeout)
  })

  it('answers plain HTTP with 426 and nothing else', async () => {
    const bridge = await startBridge()
    const res = await fetch(`http://127.0.0.1:${bridge.status().port}/`)
    expect(res.status).toBe(426)
  })
})

describe('StaveBridge — driving a paired tab', () => {
  it('pairs, reports the tab, and round-trips a call', async () => {
    const bridge = await startBridge()
    const page = await dial(bridge.status().port, {
      origin: DEV,
      token: TOKEN,
      handlers: { 'files.read': (p) => ({ path: (p as { path: string }).path, language: 'strudel', content: 's("bd")' }) },
    })
    expect(page.hello.result).toMatchObject({ server: { protocol: 1 } })
    expect(bridge.status().page).toMatchObject({ origin: DEV, project: { name: 'Test project' } })
    await expect(bridge.call('files.read', { path: 'a.strudel' })).resolves.toEqual({
      path: 'a.strudel',
      language: 'strudel',
      content: 's("bd")',
    })
  })

  it('carries the tab’s error code back to the caller', async () => {
    const bridge = await startBridge()
    await dial(bridge.status().port, {
      origin: DEV,
      token: TOKEN,
      handlers: {
        'files.read': () => {
          throw Object.assign(new Error('No file "x.strudel"'), { code: ERROR_CODES.notFound })
        },
      },
    })
    const err = await bridge.call('files.read', { path: 'x.strudel' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BridgeError)
    expect((err as BridgeError).code).toBe(ERROR_CODES.notFound)
    expect((err as BridgeError).message).toBe('No file "x.strudel"')
  })

  it('times out a call the tab never answers', async () => {
    const bridge = await startBridge()
    await dial(bridge.status().port, { origin: DEV, token: TOKEN, handlers: { 'files.list': () => new Promise(() => {}) } })
    await expect(bridge.call('files.list', {}, { timeoutMs: 50 })).rejects.toThrow('did not answer files.list')
  })

  it('fails a call at once when no tab is paired', async () => {
    const bridge = await startBridge()
    await expect(bridge.call('files.list', {})).rejects.toThrow('No Stave tab is connected')
  })

  it('a second tab replaces the first, which is told so', async () => {
    const bridge = await startBridge()
    const port = bridge.status().port
    const first = await dial(port, { origin: DEV, token: TOKEN, project: { id: 'a', name: 'First' } })
    await dial(port, { origin: 'https://stave.live', token: TOKEN, project: { id: 'b', name: 'Second' } })
    expect((await first.closed()).code).toBe(CLOSE_CODES.replaced)
    expect(first.notifications.map((n) => n.method)).toContain('bridge.replaced')
    expect(bridge.status().page).toMatchObject({ origin: 'https://stave.live', project: { name: 'Second' } })
  })

  it('follows the tab’s project when the user switches', async () => {
    const bridge = await startBridge()
    const page = await dial(bridge.status().port, { origin: DEV, token: TOKEN })
    page.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'bridge.project', params: { project: { id: 'q', name: 'Other song' } } }))
    await until(() => bridge.status().page?.project?.name === 'Other song')
  })

  it('forgets the tab, and fails its pending calls, when it disconnects', async () => {
    const bridge = await startBridge()
    const page = await dial(bridge.status().port, { origin: DEV, token: TOKEN, handlers: { 'files.list': () => new Promise(() => {}) } })
    const pending = bridge.call('files.list', {})
    page.close()
    await expect(pending).rejects.toThrow('disconnected')
    await until(() => bridge.status().page === null)
  })
})

describe('StaveBridge — a busy port', () => {
  it('reports the port busy, keeps retrying, and takes the port once it is free', async () => {
    const blocker = createServer()
    blockers.push(blocker)
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    const port = (blocker.address() as AddressInfo).port

    const bridge = await startBridge({ port, retryBindMs: 30 })
    expect(bridge.status()).toMatchObject({ listening: false, portBusy: true, port })

    await new Promise((r) => blocker.close(r))
    blockers = []
    await until(() => bridge.status().listening)
    expect(bridge.status().portBusy).toBe(false)
    const page = await dial(port, { origin: DEV, token: TOKEN })
    expect(page.hello.result).toBeDefined()
  })
})
