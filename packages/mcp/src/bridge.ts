/**
 * The WebSocket side of stave-mcp: one paired Stave tab, driven by JSON-RPC.
 *
 * Security model, in the order a connection meets it:
 *  1. The socket is bound to 127.0.0.1, so nothing off this machine reaches it.
 *  2. The Host header must name this machine, which stops DNS-rebinding pages.
 *  3. The Origin header must be on the allow-list, so an arbitrary website the
 *     user visits cannot even open the socket. Browsers always send Origin on a
 *     WebSocket handshake and a page cannot forge it.
 *  4. The first message must be `bridge.hello` with the pairing token, within a
 *     few seconds. Local programs that are not browsers can forge an Origin, so
 *     the token is what actually proves the tab was paired by the user.
 * Only the most recently paired tab is driven; an older one is told it was
 * replaced and stops reconnecting.
 */

import { timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { WebSocketServer, WebSocket, type RawData } from 'ws'

import { originAllowed } from './config'
import {
  CLOSE_CODES,
  ERROR_CODES,
  PROTOCOL_VERSION,
  type HelloParams,
  type HelloResult,
  type ParamsOf,
  type ProjectChangedParams,
  type ProjectInfo,
  type ResultOf,
  type RpcError,
  type StaveMethod,
} from './protocol'

export interface BridgeOptions {
  /** 0 picks a free port (tests). */
  readonly port: number
  readonly token: string
  readonly origins: readonly string[]
  readonly host?: string
  readonly serverName?: string
  readonly serverVersion?: string
  /** Per-request timeout unless a call passes its own. */
  readonly requestTimeoutMs?: number
  readonly helloTimeoutMs?: number
  /** How often to retry the port while another process holds it. */
  readonly retryBindMs?: number
  readonly pingIntervalMs?: number
  readonly log?: (message: string) => void
}

export interface PageInfo {
  readonly origin: string
  readonly appVersion: string
  readonly project: ProjectInfo | null
  readonly connectedAt: number
}

export interface BridgeStatus {
  readonly listening: boolean
  readonly port: number
  /** Another process holds the port (usually another Claude Code session's stave-mcp). */
  readonly portBusy: boolean
  readonly page: PageInfo | null
}

/** A failed call, carrying the tab's JSON-RPC error code when it sent one. */
export class BridgeError extends Error {
  readonly code: number | null
  readonly data: unknown
  constructor(message: string, code: number | null = null, data?: unknown) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.data = data
  }
}

/** The part of the bridge the MCP tools use; tests substitute their own. */
export interface BridgeLike {
  status(): BridgeStatus
  call<M extends StaveMethod>(method: M, params: ParamsOf<M>, opts?: { timeoutMs?: number }): Promise<ResultOf<M>>
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (err: Error) => void
  readonly timer: NodeJS.Timeout
  readonly method: string
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false
  const i = host.lastIndexOf(':')
  const name = i > 0 && !host.endsWith(']') ? host.slice(0, i) : host
  const hostPort = i > 0 && !host.endsWith(']') ? host.slice(i + 1) : ''
  return LOOPBACK_HOSTS.has(name) && (hostPort === '' || hostPort === String(port))
}

function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

export class StaveBridge extends EventEmitter implements BridgeLike {
  private readonly opts: Required<Omit<BridgeOptions, 'log'>> & { log: (m: string) => void }
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private boundPort: number
  private portBusy = false
  private retryTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private active: { ws: WebSocket; info: PageInfo; alive: boolean } | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false

  constructor(options: BridgeOptions) {
    super()
    this.opts = {
      host: '127.0.0.1',
      serverName: 'stave-mcp',
      serverVersion: '0.0.0',
      requestTimeoutMs: 15_000,
      helloTimeoutMs: 5_000,
      retryBindMs: 5_000,
      pingIntervalMs: 20_000,
      log: () => {},
      ...options,
    } as StaveBridge['opts']
    this.boundPort = options.port
  }

  /**
   * Start listening. Resolves once bound — or once the port turned out to be
   * busy, in which case the bridge keeps retrying in the background and
   * `status().portBusy` is true until it gets the port.
   */
  async start(): Promise<void> {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req))
    await this.bind()
    this.pingTimer = setInterval(() => this.ping(), this.opts.pingIntervalMs)
    this.pingTimer.unref()
  }

  private bind(): Promise<void> {
    return new Promise((resolve) => {
      const http = createServer((_req, res) => {
        res.writeHead(426, { 'Content-Type': 'text/plain' })
        res.end('stave-mcp: WebSocket only\n')
      })
      http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
      const onError = (err: NodeJS.ErrnoException): void => {
        http.close()
        if (err.code === 'EADDRINUSE') {
          if (!this.portBusy) {
            this.opts.log(
              `port ${this.opts.port} is in use (another stave-mcp, probably from another Claude Code session); retrying every ${this.opts.retryBindMs / 1000}s`,
            )
          }
          this.portBusy = true
          this.emit('status')
          if (!this.closed) {
            this.retryTimer = setTimeout(() => void this.bind(), this.opts.retryBindMs)
            this.retryTimer.unref()
          }
          resolve()
          return
        }
        this.opts.log(`could not listen: ${err.message}`)
        resolve()
      }
      http.once('error', onError)
      http.listen(this.opts.port, this.opts.host, () => {
        http.off('error', onError)
        http.on('error', (err) => this.opts.log(`server error: ${err.message}`))
        if (this.closed) {
          http.close()
          resolve()
          return
        }
        this.http = http
        this.portBusy = false
        this.boundPort = (http.address() as AddressInfo).port
        this.opts.log(`listening on ws://${this.opts.host}:${this.boundPort}`)
        this.emit('status')
        resolve()
      })
    })
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = req.headers.origin
    if (!hostAllowed(req.headers.host, this.boundPort)) {
      this.opts.log(`refused a connection with Host "${req.headers.host ?? ''}"`)
      refuseUpgrade(socket, 403, 'Forbidden')
      return
    }
    if (!originAllowed(origin, this.opts.origins)) {
      this.opts.log(`refused a connection from origin "${origin ?? '(none)'}" (not in STAVE_MCP_ORIGINS)`)
      refuseUpgrade(socket, 403, 'Forbidden')
      return
    }
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit('connection', ws, req))
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const origin = req.headers.origin ?? ''
    let paired = false
    const helloTimer = setTimeout(() => {
      if (!paired) ws.close(CLOSE_CODES.helloTimeout, 'no hello')
    }, this.opts.helloTimeoutMs)

    ws.on('message', (raw: RawData) => {
      let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!paired) {
        if (msg.method !== 'bridge.hello') {
          ws.close(CLOSE_CODES.badToken, 'hello first')
          return
        }
        clearTimeout(helloTimer)
        const params = (msg.params ?? {}) as Partial<HelloParams>
        const id = msg.id as number | string
        if (typeof params.token !== 'string' || !tokensEqual(params.token, this.opts.token)) {
          this.opts.log(`refused a tab from ${origin}: wrong pairing code`)
          this.send(ws, { jsonrpc: '2.0', id, error: { code: ERROR_CODES.badToken, message: 'pairing code refused' } })
          ws.close(CLOSE_CODES.badToken, 'bad token')
          return
        }
        if (params.protocol !== PROTOCOL_VERSION) {
          this.send(ws, {
            jsonrpc: '2.0',
            id,
            error: { code: -32600, message: `protocol ${String(params.protocol)} not supported (want ${PROTOCOL_VERSION})` },
          })
          ws.close(CLOSE_CODES.badProtocol, 'protocol')
          return
        }
        paired = true
        this.adopt(ws, {
          origin,
          appVersion: params.app?.version ?? 'unknown',
          project: params.project ?? null,
          connectedAt: Date.now(),
        })
        const result: HelloResult = {
          server: { name: this.opts.serverName, version: this.opts.serverVersion, protocol: PROTOCOL_VERSION },
        }
        this.send(ws, { jsonrpc: '2.0', id, result })
        return
      }
      if (this.active?.ws !== ws) return
      if (msg.method === 'bridge.project') {
        const p = (msg.params ?? {}) as ProjectChangedParams
        this.active = { ...this.active, info: { ...this.active.info, project: p.project ?? null } }
        this.emit('status')
        return
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.error) {
          const e = msg.error as RpcError
          pending.reject(new BridgeError(e.message ?? 'error', typeof e.code === 'number' ? e.code : null, e.data))
        } else {
          pending.resolve(msg.result)
        }
      }
    })

    ws.on('pong', () => {
      if (this.active?.ws === ws) this.active.alive = true
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      if (this.active?.ws === ws) {
        this.opts.log(`tab disconnected (${this.active.info.origin})`)
        this.active = null
        this.failPending('The Stave tab disconnected before answering.')
        this.emit('status')
      }
    })
    ws.on('error', () => {
      /* 'close' follows */
    })
  }

  private adopt(ws: WebSocket, info: PageInfo): void {
    const previous = this.active
    this.active = { ws, info, alive: true }
    if (previous) {
      this.failPending('Another Stave tab paired and replaced this one.')
      this.send(previous.ws, { jsonrpc: '2.0', method: 'bridge.replaced' })
      previous.ws.close(CLOSE_CODES.replaced, 'replaced')
    }
    const project = info.project ? ` — project "${info.project.name}"` : ''
    this.opts.log(`tab paired from ${info.origin}${project}`)
    this.emit('status')
  }

  private ping(): void {
    const a = this.active
    if (!a) return
    if (!a.alive) {
      this.opts.log('tab stopped answering pings; dropping it')
      a.ws.terminate()
      return
    }
    a.alive = false
    try {
      a.ws.ping()
    } catch {
      /* close follows */
    }
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  private failPending(message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new BridgeError(message))
      this.pending.delete(id)
    }
  }

  status(): BridgeStatus {
    return {
      listening: this.http !== null,
      port: this.boundPort,
      portBusy: this.portBusy,
      page: this.active?.info ?? null,
    }
  }

  call<M extends StaveMethod>(method: M, params: ParamsOf<M>, opts: { timeoutMs?: number } = {}): Promise<ResultOf<M>> {
    const a = this.active
    if (!a) {
      return Promise.reject(new BridgeError('No Stave tab is connected.'))
    }
    const id = this.nextId++
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError(`The Stave tab did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method })
      this.send(a.ws, { jsonrpc: '2.0', id, method, params })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.failPending('stave-mcp is shutting down.')
    for (const client of this.wss?.clients ?? []) client.terminate()
    this.active = null
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()))
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()))
    this.http = null
  }
}
