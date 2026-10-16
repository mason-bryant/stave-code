/**
 * The MCP tools Claude Code sees. Each one is a thin call through the bridge to
 * the paired Stave tab; the tab does the work with its own workspace API.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { BridgeError, type BridgeLike } from './bridge'
import type { Diagnostics, DiagnosticEntry, ProjectOpened, ProjectSummary, WriteResult } from './protocol'

export interface ToolContext {
  /** The code the user pastes into Stave → Settings → Claude Code. */
  readonly pairingCode: () => string
}

const FILE_TYPES = `File types: .strudel (Strudel pattern, JavaScript), .sonicpi (Sonic Pi, Ruby), .hydra (Hydra visual), .p5 (p5.js sketch), .glsl (ShaderToy-style fragment shader), .md (notes).`

const PATH = z
  .string()
  .min(1)
  .describe('Project-relative file path exactly as list_files shows it, e.g. "drums.strudel" or "visuals/waves.hydra".')

function text(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] }
}

function failure(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }], isError: true }
}

/** JSON-RPC "method not found": the tab runs a Stave from before this tool existed. */
const METHOD_NOT_FOUND = -32601

/** How long a project switch may take: its storage, then the editor and History starting on it. */
const PROJECT_SWITCH_TIMEOUT_MS = 25_000

function notConnectedMessage(bridge: BridgeLike, ctx: ToolContext): string {
  const s = bridge.status()
  if (s.portBusy) {
    return [
      `stave-mcp cannot listen on port ${s.port}: another stave-mcp holds it (usually another Claude Code session).`,
      'Only one session can drive Stave at a time. Close the other session, or give this one another port with the STAVE_MCP_PORT environment variable and pair the tab again.',
    ].join('\n')
  }
  return [
    'No Stave tab is connected.',
    'Ask the user to open Stave (https://stave.live, or their local dev server), then Settings → Claude Code: turn on "Let Claude Code edit this tab" and paste this pairing code:',
    '',
    `    ${ctx.pairingCode()}`,
    '',
    'Chrome asks once whether stave.live may connect to apps on this device; the user must allow it. Safari does not allow stave.live to connect to this machine at all — use Chrome, or a local dev server (pnpm dev in the Stave repo).',
  ].join('\n')
}

function formatEntry(e: DiagnosticEntry): string {
  const at = e.line !== undefined ? `line ${e.line}${e.column !== undefined ? `:${e.column}` : ''}: ` : ''
  const hint = e.suggestion ? ` (did you mean ${e.suggestion}?)` : ''
  return `  - ${at}${e.message}${hint}`
}

const EVALUATED: Record<Diagnostics['evaluated'], string> = {
  live: 'evaluated live (the song is playing)',
  check: 'evaluated silently (the song is not playing)',
  preview: 'recompiled in its on-screen preview',
  compile: 'compiled only (no preview of it is on screen, so draw-time errors cannot show)',
  none: 'not evaluated (this file type does not run)',
}

export function formatDiagnostics(d: Diagnostics): string {
  const lines: string[] = []
  if (d.errors.length === 0) {
    lines.push(`${d.path}: no errors — ${EVALUATED[d.evaluated]}.`)
  } else {
    lines.push(`${d.path}: ${d.errors.length} error${d.errors.length === 1 ? '' : 's'} — ${EVALUATED[d.evaluated]}:`)
    lines.push(...d.errors.map(formatEntry))
  }
  if (d.warnings.length > 0) {
    lines.push(`Warnings:`)
    lines.push(...d.warnings.map(formatEntry))
  }
  if (d.note) lines.push(d.note)
  return lines.join('\n')
}

/** A timestamp as UTC to the minute, e.g. "2026-10-16 19:01 UTC". */
function when(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function formatProjectRow(p: ProjectSummary): string {
  return `- "${p.name}"${p.open ? ' [open]' : ''} — id ${p.id}, last opened ${when(p.lastOpenedAt)}`
}

function formatOpened(verb: 'Created' | 'Opened', r: ProjectOpened): string {
  const files = `${r.files} file${r.files === 1 ? '' : 's'}`
  const head =
    verb === 'Created'
      ? `Created project "${r.project.name}" (id ${r.project.id}) and switched the Stave tab to it. It has no files of its own yet, only Stave's bundled visuals under preset/ (${files}). Add files with create_file.`
      : r.switched
        ? `Switched the Stave tab to project "${r.project.name}" (id ${r.project.id}, ${files}).`
        : `Project "${r.project.name}" (id ${r.project.id}, ${files}) was already open; nothing changed.`
  const tail = r.ready
    ? 'The file tools now act on this project.'
    : 'It has not finished loading yet; call stave_status and wait for it before writing to it.'
  return `${head}\n${tail}`
}

function formatWrite(verb: string, r: WriteResult): string {
  if (!r.changed) return `${r.path} already had exactly this content; nothing changed.\n${formatDiagnostics(r.diagnostics)}`
  const where =
    r.appliedVia === 'editor'
      ? 'applied in the open editor (the user can undo it there with Ctrl/Cmd+Z)'
      : 'written to the project'
  const history = r.commit ? 'recorded in History' : 'not recorded in History (history is not available in this tab)'
  return `${verb} ${r.path}: ${r.regions} region${r.regions === 1 ? '' : 's'} changed, ${where}, ${history}.\n${formatDiagnostics(r.diagnostics)}`
}

export function registerStaveTools(server: McpServer, bridge: BridgeLike, ctx: ToolContext): void {
  /** Run a bridge call, turning "no tab" and tab-side errors into tool errors. */
  const run = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    if (!bridge.status().page) return failure(notConnectedMessage(bridge, ctx))
    try {
      return await fn()
    } catch (err) {
      if (err instanceof BridgeError) {
        if (!bridge.status().page) return failure(`${err.message}\n\n${notConnectedMessage(bridge, ctx)}`)
        if (err.code === METHOD_NOT_FOUND) {
          return failure(
            `The paired Stave tab runs an older Stave that cannot do this yet (${err.message}). Ask the user to reload the tab, or update their Stave checkout and restart its dev server.`,
          )
        }
        return failure(err.message)
      }
      return failure(err instanceof Error ? err.message : String(err))
    }
  }

  server.registerTool(
    'stave_status',
    {
      title: 'Stave connection status',
      description:
        'Whether a Stave tab is paired, which project it has open, which files are open or playing, and — when no tab is connected — the pairing code and steps to give the user. Call this first if another Stave tool reports that no tab is connected.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const s = bridge.status()
      if (!s.page) return text(notConnectedMessage(bridge, ctx))
      try {
        const p = await bridge.call('project.status', {})
        const lines = [
          `Connected to a Stave tab at ${s.page.origin} (app ${s.page.appVersion}) on port ${s.port}.`,
          p.project ? `Project: "${p.project.name}" (${p.files} files).` : 'No project is open.',
        ]
        if (!p.ready) lines.push('The project is still loading; try again in a moment.')
        if (p.timeTravel) {
          lines.push('The user is viewing a past version from History, so the tab is read-only until they exit that view.')
        }
        if (p.openFiles.length > 0) lines.push(`Open in an editor: ${p.openFiles.join(', ')}.`)
        if (p.playing.length > 0) lines.push(`Playing: ${p.playing.join(', ')}.`)
        return text(lines.join('\n'))
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err))
      }
    },
  )

  server.registerTool(
    'list_files',
    {
      title: 'List Stave files',
      description: `List every file in the project open in the paired Stave tab, with its language and size, and whether it is open in an editor or playing. ${FILE_TYPES}`,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const { project, files } = await bridge.call('files.list', {})
        if (files.length === 0) return text(`Project "${project?.name ?? '?'}" has no files.`)
        const rows = files.map((f) => {
          const flags = [f.open ? 'open' : '', f.playing ? 'playing' : ''].filter(Boolean).join(', ')
          return `${f.path} — ${f.language}, ${f.lines} line${f.lines === 1 ? '' : 's'}${flags ? ` [${flags}]` : ''}`
        })
        return text(`Project "${project?.name ?? '?'}":\n${rows.join('\n')}`)
      }),
  )

  server.registerTool(
    'read_file',
    {
      title: 'Read a Stave file',
      description: 'Return the current content of one file in the paired Stave tab, exactly as the editor holds it (including edits the user has not evaluated yet).',
      inputSchema: { path: PATH },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path }) =>
      run(async () => {
        const r = await bridge.call('files.read', { path })
        return text(r.content)
      }),
  )

  server.registerTool(
    'edit_file',
    {
      title: 'Edit a Stave file',
      description: [
        'Change part of a file by exact text replacement. Each edit replaces `old_text` with `new_text`; `old_text` must appear exactly once unless `replace_all` is true. All edits apply together or not at all.',
        'Prefer this over write_file: only the changed regions are touched, so the user’s cursor in an open editor stays where it is.',
        'If the song is playing it is re-evaluated at once, so the user hears the change; a visual with a preview on screen redraws. Each change is recorded in Stave’s History panel so the user can roll it back. The result includes any evaluation errors.',
      ].join(' '),
      inputSchema: {
        path: PATH,
        edits: z
          .array(
            z.object({
              old_text: z.string().min(1).describe('Exact text currently in the file, including whitespace.'),
              new_text: z.string().describe('Replacement text.'),
              replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one.'),
            }),
          )
          .min(1),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ path, edits }) =>
      run(async () => {
        const r = await bridge.call('files.edit', {
          path,
          edits: edits.map((e) => ({ oldText: e.old_text, newText: e.new_text, replaceAll: e.replace_all })),
        })
        return text(formatWrite('Edited', r))
      }),
  )

  server.registerTool(
    'write_file',
    {
      title: 'Replace a Stave file',
      description:
        'Replace the whole content of an existing file. Only the regions that actually differ are applied, and the change is recorded in History, re-evaluated if playing, and checked for errors as with edit_file. Use create_file for a new file.',
      inputSchema: { path: PATH, content: z.string().describe('The complete new content.') },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ path, content }) =>
      run(async () => {
        const r = await bridge.call('files.write', { path, content })
        return text(formatWrite('Wrote', r))
      }),
  )

  server.registerTool(
    'create_file',
    {
      title: 'Create a Stave file',
      description: `Create a new file in the project. The extension decides its type. ${FILE_TYPES} A visual file can be shown from a pattern with .viz("<file name without extension>"). Fails if the path is taken. Without content, a visual file starts from Stave's starter sketch.`,
      inputSchema: { path: PATH, content: z.string().optional() },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ path, content }) =>
      run(async () => {
        const r = await bridge.call('files.create', content === undefined ? { path } : { path, content })
        return text(formatWrite('Created', r))
      }),
  )

  server.registerTool(
    'rename_file',
    {
      title: 'Rename or move a Stave file',
      description: 'Rename a file or move it into a folder ("a.strudel" → "songs/a.strudel"). The extension must stay a Stave file type. Note that patterns refer to visuals by name in .viz("…"), so renaming a visual can break those references.',
      inputSchema: { path: PATH, new_path: z.string().min(1) },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ path, new_path }) =>
      run(async () => {
        const r = await bridge.call('files.rename', { path, newPath: new_path })
        return text(`Renamed ${r.path} → ${r.newPath}.`)
      }),
  )

  server.registerTool(
    'get_diagnostics',
    {
      title: 'Check a Stave file for errors',
      description:
        'Evaluate a file the way Stave would and return its current errors. A playing song is re-evaluated live; a stopped song is evaluated silently without starting sound; a visual is recompiled (draw-time errors only show while its preview is on screen). Use after changing a file if you need to re-check.',
      inputSchema: { path: PATH },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path }) =>
      run(async () => {
        const d = await bridge.call('diagnostics.get', { path })
        return text(formatDiagnostics(d))
      }),
  )

  server.registerTool(
    'capture_canvas',
    {
      title: 'Snapshot a Stave visual',
      description:
        'Take a picture of what a visual is drawing right now. With a path: that visual file’s preview, or the backdrop when it is the backdrop. Without a path: the backdrop or the largest visual on screen. The visual has to be on screen in the tab; this does not open anything.',
      inputSchema: {
        path: PATH.optional(),
        max_width: z.number().int().min(64).max(1600).optional().describe('Scale the image down to at most this width (default 768).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path, max_width }) =>
      run(async () => {
        const c = await bridge.call(
          'canvas.capture',
          { ...(path !== undefined ? { path } : {}), ...(max_width !== undefined ? { maxWidth: max_width } : {}) },
          { timeoutMs: 20_000 },
        )
        const what = c.path ? `${c.path} (${c.source})` : c.source
        const caveat = c.blank ? ' Every sampled pixel is the same colour — it may not be drawing yet, or it draws only while sound plays.' : ''
        return {
          content: [
            { type: 'text', text: `Snapshot of ${what}, ${c.width}×${c.height}.${caveat}` },
            { type: 'image', data: c.data, mimeType: c.mimeType },
          ],
        }
      }),
  )

  server.registerTool(
    'list_projects',
    {
      title: 'List Stave projects',
      description:
        'List the projects saved in the paired Stave tab’s browser (Stave keeps projects only there), most recently opened first, marking the one that is open. The file tools act on the open project; open_project switches to another, create_project makes a new one.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const { projects } = await bridge.call('projects.list', {})
        if (projects.length === 0) return text('There are no projects in this Stave tab.')
        const n = projects.length
        return text(`${n} project${n === 1 ? '' : 's'}, most recently opened first:\n${projects.map(formatProjectRow).join('\n')}`)
      }),
  )

  server.registerTool(
    'create_project',
    {
      title: 'Create a Stave project',
      description: [
        'Create a new, empty project in the paired Stave tab and switch the tab to it, so the user sees it and the file tools act on it. Answers once the project is ready, so a create_file right after lands in it.',
        'The project the user had open is saved as it is and stays in their list (open_project switches back); anything playing stops.',
        'A new project has no files of its own — only Stave’s bundled visuals under preset/. Fails if a project with that name already exists.',
      ].join(' '),
      inputSchema: { name: z.string().trim().min(1).describe('The new project’s name, as the user will see it in their project list.') },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ name }) =>
      run(async () => {
        const r = await bridge.call('projects.create', { name }, { timeoutMs: PROJECT_SWITCH_TIMEOUT_MS })
        return text(formatOpened('Created', r))
      }),
  )

  server.registerTool(
    'open_project',
    {
      title: 'Open a Stave project',
      description:
        'Switch the paired Stave tab to one of its other projects, named by `id` or by exact `name` as list_projects shows them (give one). The project the user had open is saved as it is; anything playing stops. The file tools then act on the project opened.',
      inputSchema: {
        id: z.string().min(1).optional().describe('The project’s id, from list_projects.'),
        name: z.string().min(1).optional().describe('The project’s exact name, from list_projects.'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ id, name }) => {
      if ((id === undefined) === (name === undefined)) {
        return Promise.resolve(failure('Give open_project either `id` or `name` (one of them), as list_projects shows them.'))
      }
      return run(async () => {
        const r = await bridge.call('projects.open', id !== undefined ? { id } : { name: name! }, { timeoutMs: PROJECT_SWITCH_TIMEOUT_MS })
        return text(formatOpened('Opened', r))
      })
    },
  )
}
