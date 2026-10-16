/**
 * A stand-in for a Stave tab: dials the bridge the way the app's connector does
 * and answers requests from a handler table. Node's `ws` client can set any
 * Origin and Host, which is exactly what lets these tests prove the bridge
 * refuses the ones it should.
 */

import { WebSocket } from 'ws'

import { PROTOCOL_VERSION } from '../protocol'

export type Handler = (params: unknown) => unknown | Promise<unknown>

export interface FakePage {
  readonly ws: WebSocket
  readonly hello: { result?: unknown; error?: { code: number; message: string } }
  readonly notifications: Array<{ method: string; params?: unknown }>
  closed(): Promise<{ code: number; reason: string }>
  close(): void
}

export interface DialOptions {
  readonly origin?: string
  readonly token: string
  readonly host?: string
  readonly protocol?: number
  readonly handlers?: Record<string, Handler>
  readonly project?: { id: string; name: string } | null
}

/** Open a socket and send hello. Resolves after the hello answer (or a refusal). */
export function dial(port: number, opts: DialOptions): Promise<FakePage> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.host !== undefined ? { headers: { host: opts.host } } : {}),
    })
    const notifications: FakePage['notifications'] = []
    let closeInfo: { code: number; reason: string } | null = null
    const closeWaiters: Array<(v: { code: number; reason: string }) => void> = []
    const page: FakePage = {
      ws,
      hello: {},
      notifications,
      closed: () => (closeInfo ? Promise.resolve(closeInfo) : new Promise((r) => closeWaiters.push(r))),
      close: () => ws.close(),
    }
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    ws.on('error', (err) => reject(err))
    ws.on('close', (code, reason) => {
      closeInfo = { code, reason: reason.toString() }
      for (const w of closeWaiters) w(closeInfo)
      resolve(page)
    })
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'bridge.hello',
          params: {
            token: opts.token,
            protocol: opts.protocol ?? PROTOCOL_VERSION,
            app: { version: 'test' },
            project: opts.project === undefined ? { id: 'p1', name: 'Test project' } : opts.project,
          },
        }),
      )
    })
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        id?: number
        method?: string
        params?: unknown
        result?: unknown
        error?: { code: number; message: string }
      }
      if (msg.id === 0 && msg.method === undefined) {
        ;(page.hello as { result?: unknown; error?: unknown }).result = msg.result
        ;(page.hello as { result?: unknown; error?: unknown }).error = msg.error
        resolve(page)
        return
      }
      if (msg.method && msg.id === undefined) {
        notifications.push({ method: msg.method, params: msg.params })
        return
      }
      if (msg.method && msg.id !== undefined) {
        const handler = opts.handlers?.[msg.method]
        if (!handler) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no ${msg.method}` } }))
          return
        }
        try {
          const result = await handler(msg.params)
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
        } catch (err) {
          const e = err as { code?: number; message?: string }
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32000, message: e.message ?? 'error' } }))
        }
      }
    })
  })
}

/** Wait until `predicate` holds, polling. */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}
