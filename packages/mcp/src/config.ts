/**
 * Where stave-mcp listens, which pages may connect, and the pairing token.
 *
 * The token is generated once and kept in a 0600 file under the user's config
 * directory, so a paired tab stays paired across Claude Code sessions (Claude
 * Code starts a fresh stave-mcp for each session). STAVE_MCP_TOKEN overrides it,
 * which is how the tests run without touching the user's home directory.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { DEFAULT_PORT } from './protocol'

/**
 * Pages allowed to connect, when STAVE_MCP_ORIGINS does not say otherwise: the
 * hosted app, and a dev server on this machine at any port (the dev port varies;
 * see STAVE_E2E_PORT). A page from any other origin is refused before the
 * WebSocket opens. The token is still required from an allowed origin.
 */
export const DEFAULT_ORIGINS: readonly string[] = [
  'https://stave.live',
  'http://localhost:*',
  'http://127.0.0.1:*',
  'http://[::1]:*',
]

export interface BridgeConfig {
  readonly port: number
  readonly token: string
  readonly origins: readonly string[]
  /** Where the token came from, for the status tool and the CLI. */
  readonly tokenSource: 'env' | 'file'
  readonly tokenFile: string
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(homedir(), '.config')
  return join(base, 'stave-mcp')
}

export function tokenFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'pairing.json')
}

export function newToken(): string {
  return randomBytes(16).toString('hex')
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

/** Read the saved token, creating (or, with `reset`, replacing) it when needed. */
export function loadOrCreateToken(file: string, opts: { reset?: boolean } = {}): string {
  if (!opts.reset) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown }
      if (isToken(saved.token)) return saved.token
    } catch {
      // missing or unreadable: make a new one below
    }
  }
  const token = newToken()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify({ token }, null, 2) + '\n', { mode: 0o600 })
  // writeFileSync's mode only applies when it creates the file
  chmodSync(file, 0o600)
  return token
}

export function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`STAVE_MCP_PORT must be a port number (0-65535), got "${raw}"`)
  }
  return port
}

export function parseOrigins(raw: string | undefined): readonly string[] | null {
  if (raw === undefined || raw.trim() === '') return null
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env, opts: { resetToken?: boolean } = {}): BridgeConfig {
  const tokenFile = tokenFilePath(env)
  const envToken = env.STAVE_MCP_TOKEN
  if (envToken !== undefined && envToken !== '' && !isToken(envToken)) {
    throw new Error('STAVE_MCP_TOKEN must be 16-128 characters of letters, digits, "-" or "_"')
  }
  const fromEnv = envToken !== undefined && envToken !== ''
  return {
    port: parsePort(env.STAVE_MCP_PORT) ?? DEFAULT_PORT,
    token: fromEnv ? envToken : loadOrCreateToken(tokenFile, { reset: opts.resetToken }),
    origins: parseOrigins(env.STAVE_MCP_ORIGINS) ?? DEFAULT_ORIGINS,
    tokenSource: fromEnv ? 'env' : 'file',
    tokenFile,
  }
}

/** What the user pastes into Stave: the port and the token in one string. */
export function pairingCode(port: number, token: string): string {
  return `${port}-${token}`
}

/**
 * Does `origin` match one of the patterns? A pattern is an exact origin, or an
 * origin whose port is `*` (any port, including none).
 */
export function originAllowed(origin: string | undefined, patterns: readonly string[]): boolean {
  if (!origin) return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  // An Origin header is scheme://host[:port] and nothing else.
  if (url.origin !== origin) return false
  for (const pattern of patterns) {
    if (pattern === origin) return true
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -2)
      if (`${url.protocol}//${url.host}` === prefix) return true
      if (`${url.protocol}//${url.hostname}` === prefix) return true
      // [::1] keeps its brackets in `host` but `hostname` drops them in some runtimes
      if (`${url.protocol}//[${url.hostname}]` === prefix) return true
    }
  }
  return false
}
