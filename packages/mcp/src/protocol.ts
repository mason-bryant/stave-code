/**
 * The wire protocol between stave-mcp (a local process) and a paired Stave tab.
 *
 * JSON-RPC 2.0 over one WebSocket. The TAB is the client: it dials
 * ws://127.0.0.1:<port>/ and opens with `bridge.hello`, carrying the pairing
 * token. After that the SERVER sends the requests (the methods in
 * `StaveMethods`) and the tab answers each one by calling its own workspace
 * API — the same functions its editor calls when the user types. That is why
 * there is no second Yjs peer here: the tab's history only records LOCAL
 * transactions, and an edit that arrived as a remote Yjs update would never be
 * snapshotted, so the user could not roll it back.
 *
 * This module is shared with the app as TypeScript source and holds types plus
 * a few constants. The app imports it with `import type` only, so nothing here
 * ends up in the app's bundle.
 */

/** Bumped when a method changes shape. A tab speaking another version is refused. */
export const PROTOCOL_VERSION = 1 as const

/** Where stave-mcp listens unless STAVE_MCP_PORT says otherwise. */
export const DEFAULT_PORT = 47883

/** WebSocket close codes this protocol uses (4000–4999 are application codes). */
export const CLOSE_CODES = {
  /** Another tab paired after this one; only one tab is driven at a time. */
  replaced: 4001,
  /** The pairing token did not match. */
  badToken: 4003,
  /** The tab speaks a different protocol version. */
  badProtocol: 4004,
  /** No `bridge.hello` arrived in time. */
  helloTimeout: 4008,
} as const

/** JSON-RPC error codes the tab returns (beside the standard -326xx ones). */
export const ERROR_CODES = {
  /** No file at that path. */
  notFound: 1001,
  /** A file already exists at that path. */
  conflict: 1002,
  /** The tab is showing a past version (History time-travel) and is read-only. */
  readOnly: 1003,
  /** The project is still loading, or is switching. */
  notReady: 1004,
  /** An edit's `oldText` is not in the file. */
  noMatch: 1005,
  /** An edit's `oldText` appears more than once and `replaceAll` was not set. */
  ambiguous: 1006,
  /** Nothing to capture (no visual on screen for that file). */
  noCanvas: 1007,
  /** The path's extension is not a file type Stave knows. */
  badPath: 1008,
  /** The pairing token did not match (answer to `bridge.hello`). */
  badToken: 1009,
} as const

// ── Shared shapes ──────────────────────────────────────────────────────────

export type StaveLanguage =
  | 'strudel'
  | 'sonicpi'
  | 'hydra'
  | 'p5js'
  | 'glsl'
  | 'markdown'
  | (string & {})

export interface ProjectInfo {
  readonly id: string
  readonly name: string
}

export interface FileSummary {
  readonly path: string
  readonly language: StaveLanguage
  readonly lines: number
  readonly chars: number
  /** An editor for this file is mounted in the tab. */
  readonly open: boolean
  /** A runtime for this file is playing (songs only). */
  readonly playing: boolean
}

export interface DiagnosticEntry {
  readonly message: string
  readonly line?: number
  readonly column?: number
  /** "Did you mean …" from the friendly-error formatter, when there is one. */
  readonly suggestion?: string
}

/**
 * How the errors below were obtained:
 *  - `live`     the file is playing and was re-evaluated by the engine
 *  - `check`    the song is not playing; it was evaluated silently, without sound
 *  - `preview`  a visual file with a preview on screen; it recompiled and is drawing
 *  - `compile`  a visual file with nothing on screen; it was only compiled
 *  - `none`     this kind of file is not evaluated (markdown)
 */
export type EvaluationKind = 'live' | 'check' | 'preview' | 'compile' | 'none'

export interface Diagnostics {
  readonly path: string
  readonly language: StaveLanguage
  readonly evaluated: EvaluationKind
  readonly errors: readonly DiagnosticEntry[]
  readonly warnings: readonly DiagnosticEntry[]
  /** Plain-language caveat about what was or was not checked. */
  readonly note?: string
}

export interface TextEdit {
  /** Exact text to find. Must occur exactly once unless `replaceAll`. */
  readonly oldText: string
  readonly newText: string
  readonly replaceAll?: boolean
}

export interface WriteResult {
  readonly path: string
  readonly language: StaveLanguage
  /** False when the content was already exactly this. */
  readonly changed: boolean
  /** Number of separate changed regions applied. */
  readonly regions: number
  /**
   * `editor`: applied to the open editor as minimal edits, so the user's
   * cursor stays put and Ctrl+Z undoes it there. `document`: written to the
   * project document directly (no editor open for the file).
   */
  readonly appliedVia: 'editor' | 'document' | 'none'
  /** The History commit that records this change, when one was made. */
  readonly commit: string | null
  readonly diagnostics: Diagnostics
}

export interface CanvasCapture {
  readonly path: string | null
  /** Which surface was captured. */
  readonly source: 'preview' | 'backdrop' | 'inline'
  readonly width: number
  readonly height: number
  readonly mimeType: 'image/png' | 'image/jpeg'
  /** Base64, no data: prefix. */
  readonly data: string
  /** Every sampled pixel was the same colour (the visual may not be drawing). */
  readonly blank: boolean
}

export interface ProjectStatus {
  readonly project: ProjectInfo | null
  readonly ready: boolean
  /** The tab is showing a past version from History and will refuse writes. */
  readonly timeTravel: boolean
  readonly files: number
  readonly openFiles: readonly string[]
  readonly playing: readonly string[]
}

// ── Handshake (tab → server) ───────────────────────────────────────────────

export interface HelloParams {
  readonly token: string
  readonly protocol: typeof PROTOCOL_VERSION
  readonly app: { readonly version: string }
  readonly project: ProjectInfo | null
}

export interface HelloResult {
  readonly server: { readonly name: string; readonly version: string; readonly protocol: number }
}

/** Tab → server notification when the user switches projects. */
export interface ProjectChangedParams {
  readonly project: ProjectInfo | null
}

// ── Requests (server → tab) ────────────────────────────────────────────────

export interface StaveMethods {
  'project.status': { params: Record<string, never>; result: ProjectStatus }
  'files.list': { params: Record<string, never>; result: { project: ProjectInfo | null; files: FileSummary[] } }
  'files.read': { params: { path: string }; result: { path: string; language: StaveLanguage; content: string } }
  'files.write': { params: { path: string; content: string }; result: WriteResult }
  'files.edit': { params: { path: string; edits: TextEdit[] }; result: WriteResult }
  'files.create': { params: { path: string; content?: string }; result: WriteResult }
  'files.rename': { params: { path: string; newPath: string }; result: { path: string; newPath: string } }
  'diagnostics.get': { params: { path: string }; result: Diagnostics }
  'canvas.capture': { params: { path?: string; maxWidth?: number }; result: CanvasCapture }
}

export type StaveMethod = keyof StaveMethods
export type ParamsOf<M extends StaveMethod> = StaveMethods[M]['params']
export type ResultOf<M extends StaveMethod> = StaveMethods[M]['result']

// ── JSON-RPC envelopes ─────────────────────────────────────────────────────

export interface RpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number | string
  readonly method: string
  readonly params?: unknown
}

export interface RpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

export interface RpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export type RpcResponse =
  | { readonly jsonrpc: '2.0'; readonly id: number | string; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: number | string | null; readonly error: RpcError }
