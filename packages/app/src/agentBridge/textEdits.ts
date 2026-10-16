import type { OffsetEdit, TextEdit } from "./types";

/**
 * Text arithmetic for the Claude Code bridge. Pure — no editor, no document.
 *
 * WHY A DIFF AT ALL. The store's `setContent` deletes the whole text and
 * inserts the new one, and an open editor follows a changed file by replacing
 * its whole model (`@monaco-editor/react` syncs its `value` prop with one
 * full-range edit), so an agent's write would throw the user's cursor to the
 * end of the file. Applied as the regions that actually changed, through the
 * editor's own write door (`commitToFile`), the cursor stays where it was —
 * Monaco moves it only when an edit lands before it on its line — and the
 * change is one Ctrl+Z, like a Mixer or Sequencer edit.
 */

/** Thrown for an edit that cannot apply; `code` is the bridge's error code. */
export class TextEditError extends Error {
  constructor(
    message: string,
    readonly code: "noMatch" | "ambiguous",
  ) {
    super(message);
    this.name = "TextEditError";
  }
}

/** Apply exact-text replacements in order, each to the result of the last. */
export function applyTextEdits(content: string, edits: readonly TextEdit[]): string {
  let out = content;
  edits.forEach((edit, i) => {
    const which = edits.length > 1 ? `Edit ${i + 1}: ` : "";
    if (edit.oldText.length === 0) throw new TextEditError(`${which}the text to replace is empty.`, "noMatch");
    const count = countOccurrences(out, edit.oldText);
    if (count === 0) {
      throw new TextEditError(`${which}the text to replace was not found in the file (read it again — it may have changed).`, "noMatch");
    }
    if (count > 1 && !edit.replaceAll) {
      throw new TextEditError(
        `${which}the text to replace appears ${count} times; include more of the surrounding text so it is unique, or set replace_all.`,
        "ambiguous",
      );
    }
    out = edit.replaceAll ? out.split(edit.oldText).join(edit.newText) : replaceOnce(out, edit.oldText, edit.newText);
  });
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const at = haystack.indexOf(needle);
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}

/**
 * Beyond this many inserted + deleted lines a precise diff stops paying, and the
 * change is applied as one region. It also bounds the search's memory: the
 * trace keeps each round's frontier, d² numbers in all.
 */
const MAX_EDIT_DISTANCE = 1000;

/**
 * The regions where `before` and `after` differ, as non-overlapping offset
 * edits against `before`, ascending. Applying them to `before` yields `after`.
 *
 * Lines are diffed first (Myers), so separate changes stay separate regions and
 * a cursor between them is untouched; each region is then trimmed to the
 * characters that changed, so changing one note on a line does not rewrite the
 * line.
 */
export function diffEdits(before: string, after: string): OffsetEdit[] {
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);

  const hunks = lineHunks(a, b);
  if (hunks === null) return [trimEdit(before, 0, before.length, after)];

  // Line index → offset in `before`.
  const offsets = new Array<number>(a.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < a.length; i++) offsets[i + 1] = offsets[i] + a[i].length;

  return hunks.map((h) => trimEdit(before, offsets[h.aStart], offsets[h.aEnd], b.slice(h.bStart, h.bEnd).join("")));
}

/** Split keeping each line's terminator, so the pieces join back exactly. */
function splitLines(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/** Narrow a replacement of before[start, end) by `text` to the characters that differ. */
function trimEdit(before: string, start: number, end: number, text: string): OffsetEdit {
  const old = before.slice(start, end);
  let p = 0;
  const maxP = Math.min(old.length, text.length);
  while (p < maxP && old[p] === text[p]) p++;
  let s = 0;
  const maxS = Math.min(old.length - p, text.length - p);
  while (s < maxS && old[old.length - 1 - s] === text[text.length - 1 - s]) s++;
  return { range: [start + p, end - s], text: text.slice(p, text.length - s) };
}

interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/**
 * Myers' O(ND) diff over lines, returned as hunks of non-matching lines.
 * Null when the edit distance passes MAX_EDIT_DISTANCE.
 */
function lineHunks(a: readonly string[], b: readonly string[]): Hunk[] | null {
  // Matching head and tail lines never need the search.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const n = A.length;
  const m = B.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ aStart: head, aEnd: head + n, bStart: head, bEnd: head + m }];

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] is the frontier as round d began; round d reads it only on k in [-d, d].
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found !== -1) break;
  }
  if (found === -1) return null;

  // Walk the trace back into a list of matched line pairs.
  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d];
    const at = (k: number): number => vd[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    matches.push([x, y]);
  }
  matches.reverse();

  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ma, mb] of [...matches, [n, m] as [number, number]]) {
    if (ma > ai || mb > bi) hunks.push({ aStart: head + ai, aEnd: head + ma, bStart: head + bi, bEnd: head + mb });
    ai = ma + 1;
    bi = mb + 1;
  }
  return hunks;
}
