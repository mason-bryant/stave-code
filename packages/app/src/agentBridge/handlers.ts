import {
  commitToFile,
  commitWorkspace,
  createWorkspaceFile,
  getEditorForFile,
  getFile,
  getFixedMarkers,
  getLogHistory,
  isDocReady,
  isViewing,
  listWorkspaceFiles,
  makeFixedKey,
  renameWorkspaceFile,
  requestReeval,
  setContent,
  type LogEntry,
  type RuntimeId,
  type WorkspaceFile,
} from "@stave/editor";

import { extensionToLanguage, starterCodeFor } from "../lib/newFile";
import { isPlaceholder, pathTaken } from "../lib/fileTreeOps";
import { captureCanvas, findVisualCanvas, isVisualOnScreen } from "./captureCanvas";
import {
  ProjectSwitchRefused,
  getAgentProjectAccess,
  isAgentProjectReady,
  whenAgentProjectReady,
  type AgentProjectAccess,
} from "./projectAccess";
import { getAgentRuntimeAccess, type EvaluationOutcome } from "./runtimeAccess";
import { TextEditError, applyTextEdits, diffEdits } from "./textEdits";
import {
  BridgeRequestError,
  ERROR_CODES,
  type DiagnosticEntry,
  type Diagnostics,
  type FileSummary,
  type ParamsOf,
  type ProjectInfo,
  type ProjectOpened,
  type ResultOf,
  type StaveMethod,
  type WriteResult,
} from "./types";

/**
 * What the paired stave-mcp can ask this tab to do. Every write goes through
 * the same calls the editor makes when the user types, so it is a LOCAL change:
 * History's auto-commit hears it, the undo stack holds it, and a playing song
 * re-evaluates through the same seam a Mixer edit uses.
 */
export type BridgeHandlers = {
  readonly [M in StaveMethod]: (params: ParamsOf<M>) => Promise<ResultOf<M>>;
};

export interface HandlerDeps {
  readonly getProject: () => ProjectInfo | null;
  /** Tell the user what the agent just changed (a toast). */
  readonly onAgentChange?: (message: string) => void;
}

/** How long to wait for a playing song's engine to report the re-evaluation. */
const EVAL_WAIT_MS = 4000;
/** How long a visual on screen gets to recompile (its reload debounce is 300ms). */
const VISUAL_RECOMPILE_MAX_MS = 2500;
/**
 * After it recompiles, how long to listen for an error from its first frames.
 * A draw-time error from a worker renderer arrives late: the worker fails, the
 * renderer falls back to the main thread, and that mount throws and logs —
 * measured past 500ms in a headless run.
 */
const VISUAL_DRAW_GRACE_MS = 1500;

/**
 * How long a switched-to project gets to become ready: the editor remounting on
 * it and History loading. Its storage was already opened (each open is bounded,
 * #687) before this wait starts. Within stave-mcp's 25s for a switch.
 */
const PROJECT_READY_MAX_MS = 12_000;

const SONG_LANGUAGES: ReadonlySet<string> = new Set(["strudel", "sonicpi"]);
const VISUAL_RUNTIME: Readonly<Record<string, RuntimeId>> = { hydra: "hydra", p5js: "p5", glsl: "glsl" };

function fail(code: keyof typeof ERROR_CODES, message: string): never {
  throw new BridgeRequestError(ERROR_CODES[code], message);
}

function normalizePath(path: string): string {
  return path.trim().replace(/^\.?\/+/, "");
}

function visibleFiles(): WorkspaceFile[] {
  return listWorkspaceFiles().filter((f) => !isPlaceholder(f.path));
}

function fileAt(path: string): WorkspaceFile {
  const want = normalizePath(path);
  const file = visibleFiles().find((f) => f.path === want);
  if (!file) {
    const near = visibleFiles()
      .filter((f) => f.path.toLowerCase() === want.toLowerCase() || f.path.split("/").pop() === want.split("/").pop())
      .map((f) => f.path);
    fail("notFound", `No file "${want}" in this project.${near.length ? ` Did you mean ${near.map((p) => `"${p}"`).join(", ")}?` : " Use list_files to see the paths."}`);
  }
  return file;
}

function languageForPath(path: string): WorkspaceFile["language"] | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? extensionToLanguage(name.slice(dot + 1).toLowerCase()) : null;
}

function validNewPath(path: string): string {
  const p = normalizePath(path);
  if (p === "" || p.endsWith("/") || p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    fail("badPath", `"${path}" is not a usable file path.`);
  }
  return p;
}

function assertWritable(): void {
  if (!isDocReady()) fail("notReady", "The project is still loading in Stave; try again in a moment.");
  if (isViewing()) {
    fail("readOnly", "Stave is showing a past version from History, so the project is read-only. Ask the user to exit that view (or fork it) first.");
  }
}

function lineCount(s: string): number {
  return s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
}

function runtimeIdFor(file: WorkspaceFile): RuntimeId | null {
  if (SONG_LANGUAGES.has(file.language)) return file.language === "sonicpi" ? "sonicpi" : "strudel";
  return VISUAL_RUNTIME[file.language] ?? null;
}

function toEntry(e: Pick<LogEntry, "message" | "line" | "column" | "suggestion">): DiagnosticEntry {
  return {
    message: e.message,
    ...(e.line != null ? { line: e.line } : {}),
    ...(e.column != null ? { column: e.column } : {}),
    ...(e.suggestion ? { suggestion: e.suggestion.name } : {}),
  };
}

/**
 * Console entries for this file that are still current: not older than the
 * file's last clean evaluation (the Console's own Live-mode rule), and not
 * older than `since` when given.
 */
function currentLogEntries(file: WorkspaceFile, since: number | null): { errors: DiagnosticEntry[]; warnings: DiagnosticEntry[] } {
  const runtime = runtimeIdFor(file);
  if (!runtime) return { errors: [], warnings: [] };
  const fixedAt = getFixedMarkers().get(makeFixedKey(runtime, file.path)) ?? 0;
  const errors: DiagnosticEntry[] = [];
  const warnings: DiagnosticEntry[] = [];
  for (const e of getLogHistory()) {
    if (e.source !== file.path || e.runtime !== runtime) continue;
    if (e.ts < fixedAt || (since !== null && e.ts < since)) continue;
    if (e.level === "error") errors.push(toEntry(e));
    else if (e.level === "warn") warnings.push(toEntry(e));
  }
  return { errors, warnings };
}

function mergeErrors(first: DiagnosticEntry[], rest: DiagnosticEntry[]): DiagnosticEntry[] {
  const seen = new Set(first.map((e) => e.message));
  return [...first, ...rest.filter((e) => !seen.has(e.message))];
}

function errorEntry(err: Error): DiagnosticEntry {
  const m = /\((\d+):(\d+)\)\s*$/.exec(err.message);
  return m ? { message: err.message, line: Number(m[1]), column: Number(m[2]) } : { message: err.message };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait for a visual on screen to recompile after a change made at `since` —
 * until its runtime records a clean compile or an error — and then, unless it
 * already failed, a little longer for errors that only show once it draws.
 */
async function settleVisual(file: WorkspaceFile, since: number): Promise<void> {
  const runtime = runtimeIdFor(file);
  if (!runtime) return;
  const key = makeFixedKey(runtime, file.path);
  const failed = (): boolean =>
    getLogHistory().some((e) => e.source === file.path && e.runtime === runtime && e.level === "error" && e.ts >= since);
  const recompiled = await pollUntil(() => failed() || (getFixedMarkers().get(key) ?? 0) >= since, VISUAL_RECOMPILE_MAX_MS);
  if (recompiled && !failed()) await pollUntil(failed, VISUAL_DRAW_GRACE_MS);
}

/** Poll `done` every 50ms; true when it held before `maxMs` ran out. */
async function pollUntil(done: () => boolean, maxMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (done()) return true;
    await sleep(50);
  }
  return done();
}

/** Parse a visual's code without running it — all that is possible off screen. */
function syntaxCheck(code: string): DiagnosticEntry[] {
  try {
    new Function(code);
    return [];
  } catch (err) {
    return [{ message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }];
  }
}

interface DiagnoseContext {
  /** When the change being diagnosed was made; null for a plain check. */
  readonly since: number | null;
  /** The engine's report of the re-evaluation the change caused (a playing song). */
  readonly evaluation?: Promise<EvaluationOutcome | "timeout"> | null;
}

async function diagnose(fileId: string, ctx: DiagnoseContext): Promise<Diagnostics> {
  const file = getFile(fileId);
  if (!file) fail("notFound", "The file was removed.");
  const base = { path: file.path, language: file.language };

  if (SONG_LANGUAGES.has(file.language)) {
    const engines = getAgentRuntimeAccess();
    if (!engines) {
      return { ...base, evaluated: "none", errors: [], warnings: [], note: "The song engine is not running in this tab yet, so nothing was evaluated." };
    }
    let evaluation = ctx.evaluation ?? null;
    if (!evaluation && engines.isPlaying(fileId)) {
      // A plain check of a playing song: re-evaluate it the way an edit would.
      evaluation = engines.nextEvaluation(fileId, EVAL_WAIT_MS);
      requestReeval(fileId);
    }
    if (evaluation) {
      const outcome = await evaluation;
      const log = currentLogEntries(file, null);
      if (outcome === "timeout") {
        return { ...base, evaluated: "live", ...log, note: `The engine did not report an evaluation within ${EVAL_WAIT_MS / 1000}s; errors shown are the Console's current ones.` };
      }
      const direct = outcome.error ? [errorEntry(outcome.error)] : [];
      // A clean evaluate marks older Console errors fixed, so only newer ones remain.
      return { ...base, evaluated: "live", errors: mergeErrors(direct, log.errors), warnings: log.warnings };
    }
    const checked = await engines.checkEvaluate(fileId);
    if (!checked) {
      return { ...base, evaluated: "none", errors: [], warnings: [], note: "This song could not be evaluated in this tab." };
    }
    if (checked === "timeout") {
      return { ...base, evaluated: "none", errors: [], warnings: [], note: "The engine did not finish a silent evaluate in time, so nothing was checked; try get_diagnostics again." };
    }
    return {
      ...base,
      evaluated: "check",
      errors: checked.error ? [errorEntry(checked.error)] : [],
      warnings: [],
      note: "The song is not playing, so it was evaluated silently; errors that only happen while notes play (an unknown sample, say) show once the user plays it.",
    };
  }

  if (VISUAL_RUNTIME[file.language]) {
    // A Hydra or p5 preview's own compile step does not parse the code: that
    // happens when it mounts, and a syntax error there is thrown uncaught rather
    // than logged against the file. So the syntax is always checked here too.
    const syntax = file.language === "glsl" ? [] : syntaxCheck(file.content);
    if (isVisualOnScreen(fileId)) {
      if (ctx.since !== null && syntax.length === 0) await settleVisual(file, ctx.since);
      const log = currentLogEntries(file, null);
      return {
        ...base,
        evaluated: "preview",
        errors: mergeErrors(syntax, log.errors),
        warnings: log.warnings,
        note: "Errors that start later while it draws (only once sound plays, say) show in a later get_diagnostics.",
      };
    }
    if (file.language === "glsl") {
      return { ...base, evaluated: "compile", errors: [], warnings: [], note: "No preview of this shader is on screen, and a shader can only be compiled by drawing it, so it was not checked." };
    }
    const note = "No preview of this file is on screen, so it was only checked for syntax. To see it draw, the user can open it in a tab, or a song can show it with .viz(\"name\").";
    return { ...base, evaluated: "compile", errors: syntax, warnings: [], note };
  }

  return { ...base, evaluated: "none", errors: [], warnings: [] };
}

function projectAccess(): AgentProjectAccess {
  const access = getAgentProjectAccess();
  if (!access) fail("notReady", "This Stave tab cannot switch projects yet (it is still starting); try again in a moment.");
  return access;
}

/** Nothing exits a History time-travel view on a project switch, so it would carry over to the next project. */
function assertCanLeave(): void {
  if (isViewing()) {
    fail("readOnly", "Stave is showing a past version from History. Ask the user to exit that view before switching projects.");
  }
}

/** Run a switch, answering its refusals with their codes. */
async function runSwitch(run: () => Promise<{ id: string; name: string }>): Promise<ProjectInfo> {
  try {
    const meta = await run();
    return { id: meta.id, name: meta.name };
  } catch (err) {
    if (err instanceof ProjectSwitchRefused) {
      if (err.reason === "unsaved") {
        fail(
          "unsaved",
          "Storage is full and the open project has changes the browser could not save, so Stave will not leave it. Ask the user to export it or free space (and press Try again) first.",
        );
      }
      fail("notReady", "Stave is already switching projects; try again in a moment.");
    }
    throw new Error(`Stave could not switch projects: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The answer once the tab is on `project`: waited on until its editor and History have started. */
async function opened(project: ProjectInfo, switched: boolean): Promise<ProjectOpened> {
  const ready = (await whenAgentProjectReady(project.id, PROJECT_READY_MAX_MS)) && isDocReady();
  return { project, switched, ready, files: visibleFiles().length };
}

export function createBridgeHandlers(deps: HandlerDeps): BridgeHandlers {
  const notify = (message: string): void => deps.onAgentChange?.(message);

  /**
   * Put `next` into `file`. Applied as the changed regions through the file's
   * open editor when it has one (the cursor stays put; one Ctrl+Z undoes it),
   * else written to the document. Either way it is a local change.
   */
  async function applyWrite(file: WorkspaceFile, next: string, verb: string): Promise<WriteResult> {
    assertWritable();
    const base = { path: file.path, language: file.language };
    if (next === file.content) {
      return { ...base, changed: false, regions: 0, appliedVia: "none", commit: null, diagnostics: await diagnose(file.id, { since: null }) };
    }
    const edits = diffEdits(file.content, next);
    const engines = getAgentRuntimeAccess();
    // Subscribe before the change, so the re-evaluation it causes cannot be missed.
    const evaluation = engines?.isPlaying(file.id) ? engines.nextEvaluation(file.id, EVAL_WAIT_MS) : null;
    const since = Date.now();

    let appliedVia: WriteResult["appliedVia"] = "document";
    if (commitToFile(file.id, edits, "agent", file.content) === "applied" && getFile(file.id)?.content === next) {
      // The editor's own write door also asks a playing song to re-evaluate.
      appliedVia = "editor";
    } else {
      if (getFile(file.id)?.content !== next) setContent(file.id, next);
      requestReeval(file.id);
    }

    let commit: string | null = null;
    try {
      commit = await commitWorkspace("auto", { label: `Claude Code: ${verb} ${file.path}`, only: new Set([file.id]) });
    } catch (err) {
      console.warn("[stave] agent bridge: history commit failed:", err);
    }
    notify(`Claude ${verb} ${file.path}`);
    return {
      ...base,
      changed: true,
      regions: edits.length,
      appliedVia,
      commit,
      diagnostics: await diagnose(file.id, { since, evaluation }),
    };
  }

  return {
    async "project.status"() {
      const files = visibleFiles();
      const engines = getAgentRuntimeAccess();
      return {
        project: deps.getProject(),
        ready: isDocReady(),
        timeTravel: isViewing(),
        files: files.length,
        openFiles: files.filter((f) => getEditorForFile(f.id)).map((f) => f.path),
        playing: files.filter((f) => engines?.isPlaying(f.id)).map((f) => f.path),
      };
    },

    async "files.list"() {
      const engines = getAgentRuntimeAccess();
      const files: FileSummary[] = visibleFiles()
        .map((f) => ({
          path: f.path,
          language: f.language,
          lines: lineCount(f.content),
          chars: f.content.length,
          open: Boolean(getEditorForFile(f.id)),
          playing: engines?.isPlaying(f.id) ?? false,
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      return { project: deps.getProject(), files };
    },

    async "files.read"({ path }) {
      const file = fileAt(path);
      return { path: file.path, language: file.language, content: file.content };
    },

    async "files.write"({ path, content }) {
      return applyWrite(fileAt(path), content, "rewrote");
    },

    async "files.edit"({ path, edits }) {
      const file = fileAt(path);
      let next: string;
      try {
        next = applyTextEdits(file.content, edits);
      } catch (err) {
        if (err instanceof TextEditError) fail(err.code, err.message);
        throw err;
      }
      return applyWrite(file, next, "edited");
    },

    async "files.create"({ path, content }) {
      assertWritable();
      const p = validNewPath(path);
      const language = languageForPath(p);
      if (!language) {
        fail("badPath", `"${p}" does not end in a Stave file type (.strudel, .sonicpi, .hydra, .p5, .glsl or .md).`);
      }
      if (pathTaken(listWorkspaceFiles(), p)) fail("conflict", `"${p}" already exists.`);
      const id = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const body = content ?? starterCodeFor(language);
      createWorkspaceFile(id, p, body, language);
      let commit: string | null = null;
      try {
        commit = await commitWorkspace("auto", { label: `Claude Code: created ${p}`, only: new Set([id]) });
      } catch (err) {
        console.warn("[stave] agent bridge: history commit failed:", err);
      }
      notify(`Claude created ${p}`);
      return {
        path: p,
        language,
        changed: true,
        regions: body === "" ? 0 : 1,
        appliedVia: "document",
        commit,
        diagnostics: await diagnose(id, { since: null }),
      };
    },

    async "files.rename"({ path, newPath }) {
      assertWritable();
      const file = fileAt(path);
      const to = validNewPath(newPath);
      if (to === file.path) return { path: file.path, newPath: to };
      if (languageForPath(to) !== file.language) {
        fail("badPath", `"${to}" would change the file's type; keep a ${file.language} extension.`);
      }
      if (pathTaken(listWorkspaceFiles(), to, new Set([file.id]))) fail("conflict", `"${to}" already exists.`);
      renameWorkspaceFile(file.id, to);
      notify(`Claude renamed ${file.path} to ${to}`);
      return { path: file.path, newPath: to };
    },

    async "diagnostics.get"({ path }) {
      return diagnose(fileAt(path).id, { since: null });
    },

    async "canvas.capture"({ path, maxWidth }) {
      const file = path !== undefined ? fileAt(path) : null;
      const candidate = findVisualCanvas(file?.id ?? null);
      if (!candidate) {
        fail(
          "noCanvas",
          file
            ? `${file.path} is not drawing on screen. The user can open it in a tab, or set it as the backdrop, and then it can be captured.`
            : "No visual is on screen in the Stave tab.",
        );
      }
      try {
        return await captureCanvas(candidate, file?.path ?? null, maxWidth ?? 768);
      } catch (err) {
        fail("noCanvas", err instanceof Error ? err.message : String(err));
      }
    },

    async "projects.list"() {
      const open = deps.getProject()?.id ?? null;
      const projects = await projectAccess().list();
      return {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          open: p.id === open,
          createdAt: p.createdAt,
          lastOpenedAt: p.lastOpenedAt,
        })),
      };
    },

    async "projects.create"({ name }) {
      const access = projectAccess();
      const wanted = typeof name === "string" ? name.trim() : "";
      if (wanted === "") fail("badName", "A project needs a name.");
      const same = (await access.list()).filter((p) => p.name === wanted);
      if (same.length > 0) {
        fail("conflict", `A project named "${wanted}" already exists (id ${same[0].id}). Open it with open_project, or choose another name.`);
      }
      assertCanLeave();
      const project = await runSwitch(() => access.create(wanted));
      notify(`Claude created the project ${project.name}`);
      return opened(project, true);
    },

    async "projects.open"({ id, name }) {
      const access = projectAccess();
      const projects = await access.list();
      let target: { id: string; name: string } | undefined;
      if (typeof id === "string" && id !== "") {
        target = projects.find((p) => p.id === id);
        if (!target) fail("notFound", `No project with id "${id}". Use list_projects to see them.`);
      } else if (typeof name === "string" && name !== "") {
        const named = projects.filter((p) => p.name === name);
        if (named.length > 1) {
          fail("ambiguous", `${named.length} projects are named "${name}"; open one by id: ${named.map((p) => p.id).join(", ")}.`);
        }
        target = named[0];
        if (!target) {
          const near = projects.filter((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase()).map((p) => `"${p.name}"`);
          fail("notFound", `No project named "${name}".${near.length ? ` Did you mean ${near.join(", ")}?` : " Use list_projects to see them."}`);
        }
      } else {
        fail("notFound", "Name the project to open by id or by name.");
      }

      const current = deps.getProject();
      if (current?.id === target.id) {
        return { project: current, switched: false, ready: isAgentProjectReady(target.id) && isDocReady(), files: visibleFiles().length };
      }
      assertCanLeave();
      const project = await runSwitch(() => access.open(target.id));
      notify(`Claude opened the project ${project.name}`);
      return opened(project, true);
    },
  };
}
