import {
  canRedo,
  canUndo,
  codeCanUndo,
  codeUndo,
  nextFileStep,
  undoFiles,
  undoTargetFor,
  type FileUndoResult,
  type NextFileStep,
} from "@stave/editor";
import { showConfirm, showToast } from "../dialogs/host";

/**
 * Undo and Redo, for ⌘Z and for Edit → Undo alike.
 *
 * Both act where focus says (`undoTargetFor`): in a code editor's history when
 * focus is in one or in a panel that writes code, and on the project's file
 * changes anywhere else. ⌘Z passes where focus is; the menu passes where focus
 * was before the menu was opened (`focusBeforeMenu`).
 *
 * Undoing a file's creation removes the file and everything written in it. Edit →
 * Undo used to do exactly that whatever the user was doing — it always undid the
 * last file change — and a song typed into a new file vanished with no word. So a
 * file change is named in the menu ("Undo Create song.strudel"), asks first when it
 * would remove a file with something written in it, and says what it removed or
 * brought back, with the way back on a button.
 */

type Which = "undo" | "redo";

/** How long the "Removed song.strudel — Redo" toast stays: it is the way back. */
export const FILE_UNDO_TOAST_MS = 10_000;

const verb = (which: Which): string => (which === "undo" ? "Undo" : "Redo");
const opposite = (which: Which): Which => (which === "undo" ? "redo" : "undo");
const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** "a.strudel", "a.strudel and b.p5", "a, b and c", "a, b, c and 2 more files". */
export function nameFiles(paths: readonly string[]): string {
  const names = paths.map(baseName);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more files`;
}

/** What Edit → Undo / Redo says, and whether it can act, for focus at `el`. */
export function undoMenuItem(which: Which, el: Element | null): { label: string; enabled: boolean } {
  const target = undoTargetFor(el);
  if (target.kind === "code") return { label: verb(which), enabled: codeCanUndo(target.editor, which) };
  const next = nextFileStep(which);
  return { label: next?.label ? `${verb(which)} ${next.label}` : verb(which), enabled: next !== null };
}

/**
 * Whether ⌘Z / ⌘⇧Z has something to do for focus at `el`. In a code editor or a
 * panel that writes code it always does: that key must never reach past the
 * panel and undo a file change instead (#1800).
 */
export function undoAvailable(which: Which, el: Element | null): boolean {
  if (undoTargetFor(el).kind === "code") return true;
  return which === "undo" ? canUndo() : canRedo();
}

/**
 * Undo or redo where focus at `el` says. `refocus` puts focus back on `el` after
 * a code undo — the menu took it away, and the next key the user types belongs
 * where they were typing.
 */
export async function runUndo(which: Which, el: Element | null, opts: { refocus?: boolean } = {}): Promise<void> {
  const target = undoTargetFor(el);
  if (target.kind === "code") {
    codeUndo(target.editor, which);
    if (opts.refocus && el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
    return;
  }
  await stepFiles(which);
}

/** Lines in a file's text, for "the 12 lines written in it". */
const lineCount = (text: string): number => text.replace(/\n+$/, "").split("\n").length;

/** The question asked before a file change that would remove written work. */
export function removalQuestion(which: Which, next: NextFileStep): { title: string; description: string } | null {
  const written = next.removes.filter((f) => f.content.trim() !== "");
  if (written.length === 0) return null;
  const paths = next.removes.map((f) => f.path);
  const doing = `${which === "undo" ? "Undoing" : "Redoing"} ${next.label ? `"${next.label}"` : "the last file change"}`;
  let what: string;
  if (paths.length === 1) {
    const lines = lineCount(written[0].content);
    what = `${nameFiles(paths)} and the ${lines === 1 ? "line" : `${lines} lines`} written in it`;
  } else {
    what = `${nameFiles(paths)}, and what is written in them`;
  }
  return {
    title: `Remove ${paths.length === 1 ? nameFiles(paths) : `${paths.length} files`}?`,
    description: `${doing} removes ${what}. ${verb(opposite(which))} brings ${paths.length === 1 ? "it" : "them"} back.`,
  };
}

/** "Removed song.strudel", "Brought back a.strudel and b.p5", or both; null when neither. */
export function fileUndoMessage(done: Pick<FileUndoResult, "removed" | "restored">): string | null {
  const parts: string[] = [];
  if (done.removed.length) parts.push(`Removed ${nameFiles(done.removed)}`);
  if (done.restored.length) parts.push(`Brought back ${nameFiles(done.restored)}`);
  return parts.length ? parts.join(". ") : null;
}

/** Undo or redo the next file change: ask first if it removes written work, then say what it did. */
async function stepFiles(which: Which): Promise<void> {
  const next = nextFileStep(which);
  if (!next) return;
  const question = removalQuestion(which, next);
  if (question) {
    const ok = await showConfirm({ ...question, confirmLabel: "Remove", danger: true });
    if (!ok) return;
  }
  // Only the step the user was asked about, if it is still the next one.
  const done = undoFiles(which, next.token);
  if (!done) {
    showToast(`Nothing to ${which}: the files changed in the meantime.`, "info");
    return;
  }
  announce(which, done);
}

/**
 * Say what a file undo or redo removed or brought back, with the opposite on a
 * button. The button takes back exactly this step — if something else changed the
 * files since, it says so instead of reversing that.
 */
export function announce(which: Which, done: FileUndoResult): void {
  const message = fileUndoMessage(done);
  if (!message) return;
  const back = opposite(which);
  const reverse = done.reverse;
  if (!reverse) {
    showToast(message, "info", FILE_UNDO_TOAST_MS);
    return;
  }
  showToast(
    message,
    "info",
    FILE_UNDO_TOAST_MS,
    () => {
      const again = undoFiles(back, reverse);
      if (again) announce(back, again);
      else showToast(`Couldn't ${back} that: the files have changed since.`, "error");
    },
    verb(back),
  );
}
