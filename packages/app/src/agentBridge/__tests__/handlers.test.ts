import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLog,
  createWorkspaceFile,
  deleteWorkspaceFile,
  emitFixed,
  emitLog,
  enterRuntimeView,
  exitRuntimeView,
  getFile,
  listWorkspaceFiles,
  registerReevalHandler,
  type ProjectMeta,
} from "@stave/editor";

import { createBridgeHandlers } from "../handlers";
import { ProjectSwitchRefused, markAgentProjectReady, registerAgentProjectAccess } from "../projectAccess";
import { registerAgentRuntimeAccess, type AgentRuntimeAccess } from "../runtimeAccess";
import { BridgeRequestError, ERROR_CODES } from "../types";

/**
 * The handlers against the REAL workspace store (its in-memory document — no
 * IndexedDB in jsdom) and the real Console log. No editor is mounted here, so
 * writes take the document route; the editor route, History and the live
 * engine are covered in the browser by tests/agent-bridge.spec.ts.
 */

const handlers = createBridgeHandlers({ getProject: () => ({ id: "p1", name: "Test" }) });

const SONG = '$: s("bd sd")\n$: note("c3 e3").s("sawtooth")\n';

function wipe(): void {
  for (const f of listWorkspaceFiles()) deleteWorkspaceFile(f.id);
  clearLog();
}

async function refusal(p: Promise<unknown>): Promise<BridgeRequestError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BridgeRequestError);
  return err as BridgeRequestError;
}

let unregister: Array<() => void> = [];

function engines(over: Partial<AgentRuntimeAccess>): void {
  unregister.push(
    registerAgentRuntimeAccess({
      isPlaying: () => false,
      checkEvaluate: async () => ({ error: null }),
      nextEvaluation: async () => ({ error: null }),
      ...over,
    }),
  );
}

beforeEach(() => {
  wipe();
  createWorkspaceFile("song", "song.strudel", SONG, "strudel");
  createWorkspaceFile("viz", "visuals/waves.hydra", "s.osc(10).out()", "hydra");
  createWorkspaceFile("keep", "empty/.keep", "", "markdown");
});

afterEach(() => {
  for (const off of unregister) off();
  unregister = [];
  wipe();
});

describe("agent bridge handlers — reading", () => {
  it("lists the project's files, without folder placeholders", async () => {
    const { project, files } = await handlers["files.list"]({});
    expect(project).toEqual({ id: "p1", name: "Test" });
    expect(files.map((f) => f.path)).toEqual(["song.strudel", "visuals/waves.hydra"]);
    expect(files[0]).toMatchObject({ language: "strudel", lines: 2, open: false, playing: false });
  });

  it("reads a file, and names near misses for a wrong path", async () => {
    await expect(handlers["files.read"]({ path: "./song.strudel" })).resolves.toEqual({
      path: "song.strudel",
      language: "strudel",
      content: SONG,
    });
    const err = await refusal(handlers["files.read"]({ path: "waves.hydra" }));
    expect(err.code).toBe(ERROR_CODES.notFound);
    expect(err.message).toContain('"visuals/waves.hydra"');
  });
});

describe("agent bridge handlers — writing", () => {
  it("edits by exact text, and evaluates a stopped song silently", async () => {
    let checked = 0;
    engines({ checkEvaluate: async () => (checked++, { error: null }) });
    const r = await handlers["files.edit"]({ path: "song.strudel", edits: [{ oldText: "c3 e3", newText: "c3 eb3 g3" }] });
    expect(getFile("song")!.content).toBe(SONG.replace("c3 e3", "c3 eb3 g3"));
    expect(r).toMatchObject({ changed: true, regions: 1, appliedVia: "document" });
    expect(r.diagnostics).toMatchObject({ evaluated: "check", errors: [] });
    expect(checked).toBe(1);
  });

  it("reports a stopped song's evaluate error with its position", async () => {
    engines({ checkEvaluate: async () => ({ error: new Error("Unexpected token (2:5)") }) });
    const r = await handlers["files.write"]({ path: "song.strudel", content: '$: s("bd sd")\n$: note("c3 e3"\n' });
    expect(r.diagnostics.errors).toEqual([{ message: "Unexpected token (2:5)", line: 2, column: 5 }]);
  });

  it("says nothing was checked when the silent evaluate did not settle in time", async () => {
    engines({ checkEvaluate: async () => "timeout" });
    const d = await handlers["diagnostics.get"]({ path: "song.strudel" });
    expect(d).toMatchObject({ evaluated: "none", errors: [] });
    expect(d.note).toContain("did not finish");
  });

  it("re-evaluates a playing song and waits for the engine's answer", async () => {
    const reevals: string[] = [];
    unregister.push(registerReevalHandler((id) => reevals.push(id)));
    let subscribedBeforeWrite = false;
    engines({
      isPlaying: () => true,
      nextEvaluation: async () => {
        subscribedBeforeWrite = getFile("song")!.content === SONG;
        return { error: new Error("sawtoth is not defined") };
      },
    });
    const r = await handlers["files.edit"]({ path: "song.strudel", edits: [{ oldText: "sawtooth", newText: "sawtoth" }] });
    expect(subscribedBeforeWrite).toBe(true);
    expect(reevals).toEqual(["song"]);
    expect(r.diagnostics).toMatchObject({ evaluated: "live", errors: [{ message: "sawtoth is not defined" }] });
  });

  it("includes a playing song's current Console errors, but not ones a clean evaluate fixed", async () => {
    emitLog({ level: "error", runtime: "strudel", source: "song.strudel", message: "old error" });
    await new Promise((r) => setTimeout(r, 2));
    emitFixed({ runtime: "strudel", source: "song.strudel" });
    await new Promise((r) => setTimeout(r, 2));
    emitLog({ level: "warn", runtime: "strudel", source: "song.strudel", message: "sound bdx not found" });
    engines({ isPlaying: () => true });
    const d = await handlers["diagnostics.get"]({ path: "song.strudel" });
    expect(d.errors).toEqual([]);
    expect(d.warnings).toEqual([{ message: "sound bdx not found" }]);
  });

  it("refuses an edit whose text is missing or ambiguous, and changes nothing", async () => {
    const missing = await refusal(handlers["files.edit"]({ path: "song.strudel", edits: [{ oldText: "kick", newText: "bd" }] }));
    expect(missing.code).toBe(ERROR_CODES.noMatch);
    const twice = await refusal(handlers["files.edit"]({ path: "song.strudel", edits: [{ oldText: "$:", newText: "_$:" }] }));
    expect(twice.code).toBe(ERROR_CODES.ambiguous);
    expect(getFile("song")!.content).toBe(SONG);
  });

  it("says so when the content is already exactly that", async () => {
    engines({});
    const r = await handlers["files.write"]({ path: "song.strudel", content: SONG });
    expect(r).toMatchObject({ changed: false, regions: 0, appliedVia: "none", commit: null });
  });

  it("syntax-checks a visual that is not on screen", async () => {
    const ok = await handlers["files.write"]({ path: "visuals/waves.hydra", content: "s.osc(20).out()" });
    expect(ok.diagnostics).toMatchObject({ evaluated: "compile", errors: [] });
    expect(ok.diagnostics.note).toContain("only checked for syntax");
    const bad = await handlers["files.write"]({ path: "visuals/waves.hydra", content: "s.osc(20.out()" });
    expect(bad.diagnostics.errors).toHaveLength(1);
    expect(bad.diagnostics.errors[0].message).toMatch(/^SyntaxError/);
  });
});

describe("agent bridge handlers — creating and renaming", () => {
  it("creates a file typed by its extension, with the starter sketch for a visual", async () => {
    const r = await handlers["files.create"]({ path: "visuals/new.hydra" });
    expect(r).toMatchObject({ path: "visuals/new.hydra", language: "hydra", changed: true });
    const made = listWorkspaceFiles().find((f) => f.path === "visuals/new.hydra")!;
    expect(made.content).toContain(".out()");
    const song = await handlers["files.create"]({ path: "b.strudel", content: 's("cp")' });
    expect(song.language).toBe("strudel");
  });

  it("refuses a taken path, an unknown type and a path that climbs out", async () => {
    expect((await refusal(handlers["files.create"]({ path: "song.strudel" }))).code).toBe(ERROR_CODES.conflict);
    expect((await refusal(handlers["files.create"]({ path: "visuals" }))).code).toBe(ERROR_CODES.badPath);
    expect((await refusal(handlers["files.create"]({ path: "notes.txt" }))).code).toBe(ERROR_CODES.badPath);
    expect((await refusal(handlers["files.create"]({ path: "../x.strudel" }))).code).toBe(ERROR_CODES.badPath);
  });

  it("renames within a type, and refuses a rename that changes the type or collides", async () => {
    await expect(handlers["files.rename"]({ path: "song.strudel", newPath: "songs/main.strudel" })).resolves.toEqual({
      path: "song.strudel",
      newPath: "songs/main.strudel",
    });
    expect(getFile("song")!.path).toBe("songs/main.strudel");
    expect((await refusal(handlers["files.rename"]({ path: "songs/main.strudel", newPath: "main.hydra" }))).code).toBe(ERROR_CODES.badPath);
    createWorkspaceFile("other", "other.strudel", "", "strudel");
    expect((await refusal(handlers["files.rename"]({ path: "songs/main.strudel", newPath: "other.strudel" }))).code).toBe(ERROR_CODES.conflict);
  });
});

describe("agent bridge handlers — status and capture", () => {
  it("reports the project", async () => {
    engines({ isPlaying: (id) => id === "song" });
    await expect(handlers["project.status"]({})).resolves.toEqual({
      project: { id: "p1", name: "Test" },
      ready: true,
      timeTravel: false,
      files: 2,
      openFiles: [],
      playing: ["song.strudel"],
    });
  });

  it("refuses to capture a visual that is not on screen", async () => {
    const err = await refusal(handlers["canvas.capture"]({ path: "visuals/waves.hydra" }));
    expect(err.code).toBe(ERROR_CODES.noCanvas);
    expect(err.message).toContain("not drawing on screen");
  });
});

describe("agent bridge handlers — projects", () => {
  const T0 = Date.UTC(2026, 9, 16, 12, 0);

  /**
   * StaveApp's side of the seam, in miniature: a project list, the open one,
   * and a switch whose editor reports ready only when the test says so — the
   * remount and History start the real one waits for.
   */
  function projectList(opts: { refuse?: "unsaved" | "busy" } = {}) {
    const list: ProjectMeta[] = [
      { id: "p1", name: "Test", createdAt: T0, lastOpenedAt: T0 + 3000 },
      { id: "p2", name: "Night drive", createdAt: T0, lastOpenedAt: T0 + 2000 },
      { id: "p3", name: "Twins", createdAt: T0, lastOpenedAt: T0 + 1000 },
      { id: "p4", name: "Twins", createdAt: T0, lastOpenedAt: T0 },
    ];
    const state = { open: "p1", switches: [] as string[], mount: (id: string) => void unregister.push(markAgentProjectReady(id)) };
    const enter = async (meta: ProjectMeta): Promise<ProjectMeta> => {
      if (opts.refuse) throw new ProjectSwitchRefused(opts.refuse);
      state.switches.push(meta.id);
      state.open = meta.id;
      queueMicrotask(() => state.mount(meta.id));
      return meta;
    };
    unregister.push(
      registerAgentProjectAccess({
        list: async () => [...list].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
        create: (name) => {
          const meta = { id: `p${list.length + 1}`, name, createdAt: T0 + 9000, lastOpenedAt: T0 + 9000 };
          return enter(meta).then(() => (list.push(meta), meta));
        },
        open: (id) => enter(list.find((p) => p.id === id)!),
      }),
    );
    unregister.push(markAgentProjectReady("p1"));
    const toasts: string[] = [];
    const h = createBridgeHandlers({
      getProject: () => {
        const p = list.find((m) => m.id === state.open)!;
        return { id: p.id, name: p.name };
      },
      onAgentChange: (m) => toasts.push(m),
    });
    return { h, state, toasts };
  }

  afterEach(() => {
    exitRuntimeView();
    vi.useRealTimers();
  });

  it("lists every project, most recently opened first, marking the open one", async () => {
    const { h } = projectList();
    const { projects } = await h["projects.list"]({});
    expect(projects.map((p) => [p.id, p.open])).toEqual([
      ["p1", true],
      ["p2", false],
      ["p3", false],
      ["p4", false],
    ]);
    expect(projects[1]).toEqual({ id: "p2", name: "Night drive", open: false, createdAt: T0, lastOpenedAt: T0 + 2000 });
  });

  it("creates a project, switches to it, and answers only once its editor is ready", async () => {
    const { h, state, toasts } = projectList();
    let mount: () => void = () => {};
    state.mount = (id) => {
      mount = () => void unregister.push(markAgentProjectReady(id));
    };
    let answered = false;
    const pending = h["projects.create"]({ name: "  Song for Ada  " }).then((r) => ((answered = true), r));
    await new Promise((r) => setTimeout(r, 30));
    expect(state.switches).toEqual(["p5"]);
    expect(answered).toBe(false);
    mount();
    await expect(pending).resolves.toEqual({ project: { id: "p5", name: "Song for Ada" }, switched: true, ready: true, files: 2 });
    expect(toasts).toEqual(["Claude created the project Song for Ada"]);
  });

  it("says the new project is not ready when its editor never reports in", async () => {
    vi.useFakeTimers();
    const { h, state } = projectList();
    state.mount = () => {};
    const pending = h["projects.create"]({ name: "Slow" });
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(pending).resolves.toMatchObject({ project: { name: "Slow" }, switched: true, ready: false });
  });

  it("refuses a blank or taken name before creating anything", async () => {
    const { h, state } = projectList();
    expect((await refusal(h["projects.create"]({ name: "   " }))).code).toBe(ERROR_CODES.badName);
    const taken = await refusal(h["projects.create"]({ name: "Night drive" }));
    expect(taken.code).toBe(ERROR_CODES.conflict);
    expect(taken.message).toContain("id p2");
    expect(state.switches).toEqual([]);
  });

  it("will not leave a project whose changes storage refused, nor switch while switching", async () => {
    const unsaved = await refusal(projectList({ refuse: "unsaved" }).h["projects.create"]({ name: "New" }));
    expect(unsaved.code).toBe(ERROR_CODES.unsaved);
    expect(unsaved.message).toContain("Storage is full");
    const busy = await refusal(projectList({ refuse: "busy" }).h["projects.open"]({ id: "p2" }));
    expect(busy.code).toBe(ERROR_CODES.notReady);
  });

  it("will not switch while the user is viewing a past version", async () => {
    const { h, state } = projectList();
    enterRuntimeView("c1", {});
    expect((await refusal(h["projects.create"]({ name: "New" }))).code).toBe(ERROR_CODES.readOnly);
    expect((await refusal(h["projects.open"]({ id: "p2" }))).code).toBe(ERROR_CODES.readOnly);
    expect(state.switches).toEqual([]);
  });

  it("opens a project by id or by exact name", async () => {
    const { h, state, toasts } = projectList();
    await expect(h["projects.open"]({ name: "Night drive" })).resolves.toEqual({
      project: { id: "p2", name: "Night drive" },
      switched: true,
      ready: true,
      files: 2,
    });
    await expect(h["projects.open"]({ id: "p1" })).resolves.toMatchObject({ project: { id: "p1" }, switched: true });
    expect(state.switches).toEqual(["p2", "p1"]);
    expect(toasts).toEqual(["Claude opened the project Night drive", "Claude opened the project Test"]);
  });

  it("does nothing for the project already open", async () => {
    const { h, state } = projectList();
    await expect(h["projects.open"]({ name: "Test" })).resolves.toEqual({
      project: { id: "p1", name: "Test" },
      switched: false,
      ready: true,
      files: 2,
    });
    expect(state.switches).toEqual([]);
  });

  it("refuses a name two projects share, and names near misses for one nobody has", async () => {
    const { h } = projectList();
    const twins = await refusal(h["projects.open"]({ name: "Twins" }));
    expect(twins.code).toBe(ERROR_CODES.ambiguous);
    expect(twins.message).toContain("p3, p4");
    const near = await refusal(h["projects.open"]({ name: "night drive" }));
    expect(near.code).toBe(ERROR_CODES.notFound);
    expect(near.message).toContain('Did you mean "Night drive"?');
    expect((await refusal(h["projects.open"]({ id: "p9" }))).code).toBe(ERROR_CODES.notFound);
  });

  it("says the tab is not ready when nothing can switch projects yet", async () => {
    expect((await refusal(handlers["projects.list"]({}))).code).toBe(ERROR_CODES.notReady);
  });
});
