/**
 * Run the real stave-mcp CLI and talk to it over stdio, the way Claude Code does.
 *
 * Deliberately not the MCP SDK's client: this is the whole wire exchange a
 * client makes (initialize, initialized, tools/call), written out, so a spec
 * shows exactly what Claude Code sends and gets back.
 */
import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

const MCP_DIR = resolve(__dirname, '../../mcp')
const CLI = resolve(MCP_DIR, 'dist/cli.js')

export interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

export interface StaveMcp {
  readonly port: number
  readonly pairingCode: string
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>
  /** The text parts of a call's result, joined. */
  text(name: string, args?: Record<string, unknown>): Promise<string>
  /** What the server wrote to stderr (its log). */
  log(): string
  close(): Promise<void>
}

/** A port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => ok(port))
    })
  })
}

/** Build the CLI when a fresh checkout has not built it yet. */
export function ensureBuilt(): void {
  if (!existsSync(CLI)) execSync('pnpm build', { cwd: MCP_DIR, stdio: 'inherit' })
}

export async function startStaveMcp(opts: { port?: number; token?: string; origins?: string } = {}): Promise<StaveMcp> {
  ensureBuilt()
  const port = opts.port ?? (await freePort())
  const token = opts.token ?? `e2e${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI], {
    env: {
      ...process.env,
      STAVE_MCP_PORT: String(port),
      STAVE_MCP_TOKEN: token,
      ...(opts.origins ? { STAVE_MCP_ORIGINS: opts.origins } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += String(d)))

  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } }
      if (msg.id === undefined || !pending.has(msg.id)) continue
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.error) p.fail(new Error(msg.error.message))
      else p.ok(msg.result)
    }
  })
  child.on('exit', () => {
    for (const p of pending.values()) p.fail(new Error(`stave-mcp exited:\n${stderr}`))
    pending.clear()
  })

  let nextId = 1
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((ok, fail) => {
      const id = nextId++
      pending.set(id, { ok, fail })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })

  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stave-e2e', version: '0' },
  })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  const call = (name: string, args: Record<string, unknown> = {}) =>
    request('tools/call', { name, arguments: args }) as Promise<ToolResult>

  return {
    port,
    pairingCode: `${port}-${token}`,
    call,
    async text(name, args) {
      const r = await call(name, args)
      return r.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
    },
    log: () => stderr,
    close: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null) return done()
        child.once('exit', () => done())
        child.stdin.end()
        setTimeout(() => child.kill('SIGKILL'), 2000).unref()
      }),
  }
}
