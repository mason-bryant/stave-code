/**
 * Undo and Redo, for ⌘Z and Edit → Undo alike (lib/undoCommand).
 *
 * A user lost a song: Edit → Undo always undid the last FILE change, and the last
 * file change was creating the file they were typing into — so it removed the
 * file, song and all, without a word. Undo now acts where focus says (the code
 * editor's own history when the user was in one), asks before a file change that
 * would remove written work, and says what it removed with the way back on a button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dialogs = vi.hoisted(() => ({
  confirm: true,
  showConfirm: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock("../../dialogs/host", () => ({
  showConfirm: dialogs.showConfirm,
  showToast: dialogs.showToast,
}));

// The routing itself is pinned in the editor package (codeUndo.test.ts). Here a
// test can say "this element is in a code editor" without mounting Monaco.
const code = vi.hoisted(() => ({ el: null as Element | null, editor: null as unknown }));
vi.mock("@stave/editor", async (importOriginal) => {
  const real = await importOriginal<typeof import("@stave/editor")>();
  return {
    ...real,
    undoTargetFor: (el: Element | null) =>
      el && el === code.el ? { kind: "code", editor: code.editor } : real.undoTargetFor(el),
  };
});

import {
  createWorkspaceFile,
  deleteWorkspaceFile,
  getFile,
  listWorkspaceFiles,
  nextFileStep,
  resetUndoManager,
  setContent,
} from "@stave/editor";
import {
  fileUndoMessage,
  nameFiles,
  removalQuestion,
  runUndo,
  undoAvailable,
  undoMenuItem,
} from "../undoCommand";

const SONG = '$: s("bd sd")\n$: note("c3 e3 g3")';

beforeEach(() => {
  for (const f of listWorkspaceFiles()) deleteWorkspaceFile(f.id);
  resetUndoManager();
  nextFileStep("undo"); // make the history before the change, as the app does
  dialogs.confirm = true;
  dialogs.showConfirm.mockReset().mockImplementation(async () => dialogs.confirm);
  dialogs.showToast.mockReset();
  code.el = null;
  code.editor = null;
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** A new file the user then typed a song into — the case that lost work. */
function typedSong(): void {
  createWorkspaceFile("song", "song.strudel", "", "strudel");
  setContent("song", SONG);
}

/** Press the action button on the last toast shown. */
function pressToastAction(): void {
  const call = dialogs.showToast.mock.calls.at(-1)!;
  (call[3] as () => void)();
}

describe("Edit → Undo in a code editor", () => {
  it("undoes the typing, keeps the file, and puts focus back where the user was typing", async () => {
    typedSong();
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    const model = { undo: vi.fn(), redo: vi.fn(), canUndo: () => true, canRedo: () => false };
    code.el = textarea;
    code.editor = { getModel: () => model };

    expect(undoMenuItem("undo", textarea)).toEqual({ label: "Undo", enabled: true });
    expect(undoMenuItem("redo", textarea)).toEqual({ label: "Redo", enabled: false });

    await runUndo("undo", textarea, { refocus: true });
    expect(model.undo).toHaveBeenCalledTimes(1);
    expect(getFile("song")?.content).toBe(SONG);
    expect(document.activeElement).toBe(textarea);
    expect(dialogs.showConfirm).not.toHaveBeenCalled();
  });
});

describe("Undo outside any code editor: file changes", () => {
  it("the menu names the step", () => {
    typedSong();
    expect(undoMenuItem("undo", document.body)).toEqual({ label: "Undo Create song.strudel", enabled: true });
    expect(undoMenuItem("redo", document.body)).toEqual({ label: "Redo", enabled: false });
    expect(undoAvailable("undo", document.body)).toBe(true);
    expect(undoAvailable("redo", document.body)).toBe(false);
  });

  it("asks before removing a file with a song in it; No keeps it", async () => {
    typedSong();
    dialogs.confirm = false;
    await runUndo("undo", document.body);
    expect(dialogs.showConfirm).toHaveBeenCalledTimes(1);
    expect(dialogs.showConfirm.mock.calls[0][0]).toMatchObject({
      title: "Remove song.strudel?",
      description: 'Undoing "Create song.strudel" removes song.strudel and the 2 lines written in it. Redo brings it back.',
      danger: true,
    });
    expect(getFile("song")?.content).toBe(SONG);
    expect(dialogs.showToast).not.toHaveBeenCalled();
  });

  it("Yes removes it and says so, with Redo — which brings it back with the song", async () => {
    typedSong();
    await runUndo("undo", document.body);
    expect(getFile("song")).toBeUndefined();
    const [message, , , onRedo, actionLabel] = dialogs.showToast.mock.calls.at(-1)!;
    expect(message).toBe("Removed song.strudel");
    expect(actionLabel).toBe("Redo");
    expect(typeof onRedo).toBe("function");

    pressToastAction();
    expect(getFile("song")?.content).toBe(SONG);
    const [again, , , , againLabel] = dialogs.showToast.mock.calls.at(-1)!;
    expect(again).toBe("Brought back song.strudel");
    expect(againLabel).toBe("Undo");
  });

  it("an empty new file goes without a question", async () => {
    createWorkspaceFile("e", "empty.strudel", "", "strudel");
    await runUndo("undo", document.body);
    expect(dialogs.showConfirm).not.toHaveBeenCalled();
    expect(getFile("e")).toBeUndefined();
    expect(dialogs.showToast.mock.calls.at(-1)![0]).toBe("Removed empty.strudel");
  });

  it("a toast's Redo pressed after the files changed does not redo something else", async () => {
    createWorkspaceFile("a", "a.strudel", "", "strudel");
    await runUndo("undo", document.body);
    const onRedo = dialogs.showToast.mock.calls.at(-1)![3] as () => void;
    createWorkspaceFile("b", "b.strudel", "", "strudel"); // clears the redo history
    onRedo();
    expect(getFile("a")).toBeUndefined();
    expect(dialogs.showToast.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      "Couldn't redo that: the files have changed since.",
      "error",
    ]);
  });
});

describe("the words", () => {
  it("names files, a few at most", () => {
    expect(nameFiles(["dir/a.strudel"])).toBe("a.strudel");
    expect(nameFiles(["a", "b"])).toBe("a and b");
    expect(nameFiles(["a", "b", "c"])).toBe("a, b and c");
    expect(nameFiles(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more files");
  });

  it("says what an undo removed and brought back", () => {
    expect(fileUndoMessage({ removed: ["x.p5"], restored: [] })).toBe("Removed x.p5");
    expect(fileUndoMessage({ removed: [], restored: ["a", "b"] })).toBe("Brought back a and b");
    expect(fileUndoMessage({ removed: ["a"], restored: ["b"] })).toBe("Removed a. Brought back b");
    expect(fileUndoMessage({ removed: [], restored: [] })).toBeNull();
  });

  it("asks only when something written would go", () => {
    const step = (contents: string[]) => ({
      label: "Create 2 files",
      token: {},
      removes: contents.map((content, i) => ({ id: String(i), path: `f${i}.strudel`, content })),
    });
    expect(removalQuestion("undo", step(["", "  \n"]))).toBeNull();
    expect(removalQuestion("redo", step(["", "x"]))).toEqual({
      title: "Remove 2 files?",
      description: 'Redoing "Create 2 files" removes f0.strudel and f1.strudel, and what is written in them. Undo brings them back.',
    });
  });
});
