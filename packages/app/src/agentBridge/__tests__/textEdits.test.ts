import { describe, expect, it } from "vitest";
import { applyEdits } from "@stave/editor";

import { TextEditError, applyTextEdits, diffEdits } from "../textEdits";

const SONG = `setcps(0.5)
$: s("bd sd bd sd").gain(0.8)
$: note("c3 e3 g3").s("sawtooth")
$: s("hh*8").gain(0.4)
`;

function roundTrip(before: string, after: string) {
  const edits = diffEdits(before, after);
  expect(applyEdits(before, edits)).toBe(after);
  return edits;
}

describe("diffEdits", () => {
  it("returns nothing for identical text", () => {
    expect(diffEdits(SONG, SONG)).toEqual([]);
  });

  it("narrows a one-note change to the characters that changed", () => {
    const after = SONG.replace('note("c3 e3 g3")', 'note("c3 eb3 g3")');
    const edits = roundTrip(SONG, after);
    expect(edits).toHaveLength(1);
    const at = SONG.indexOf("e3 g3");
    // only the inserted "b" — the rest of the line, and every other line, is untouched
    expect(edits[0]).toEqual({ range: [at + 1, at + 1], text: "b" });
  });

  it("keeps separate changes as separate regions, so text between them is untouched", () => {
    const after = SONG.replace("setcps(0.5)", "setcps(0.6)").replace("hh*8", "hh*16");
    const edits = roundTrip(SONG, after);
    expect(edits).toHaveLength(2);
    // nothing on the two middle lines falls inside either region
    const middleStart = SONG.indexOf("$: s(\"bd");
    const middleEnd = SONG.indexOf("$: s(\"hh");
    for (const e of edits) expect(e.range[1] <= middleStart || e.range[0] >= middleEnd).toBe(true);
  });

  it("handles inserted and deleted lines", () => {
    const inserted = SONG.replace("$: s(\"hh*8\")", '$: s("cp*2")\n$: s("hh*8")');
    expect(roundTrip(SONG, inserted)).toHaveLength(1);
    const deleted = SONG.replace('$: note("c3 e3 g3").s("sawtooth")\n', "");
    expect(roundTrip(SONG, deleted)).toHaveLength(1);
  });

  it("handles a file with no final newline, and an empty one", () => {
    roundTrip("a\nb", "a\nb\nc");
    roundTrip("a\nb\n", "a\nb");
    roundTrip("", "s(\"bd\")\n");
    roundTrip("s(\"bd\")\n", "");
    roundTrip("x", "y");
  });

  it("round-trips arbitrary edits", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const vocab = ["$: s(\"bd\")\n", "\n", "note(\"c\")", "  .gain(1)\n", "// hi\n", "x", "y\n"];
    for (let trial = 0; trial < 300; trial++) {
      const make = () => Array.from({ length: rand(12) }, () => vocab[rand(vocab.length)]).join("");
      const before = make();
      let after = before;
      for (let k = rand(4); k >= 0; k--) {
        const at = rand(after.length + 1);
        const cut = rand(6);
        after = after.slice(0, at) + vocab[rand(vocab.length)] + after.slice(at + cut);
      }
      roundTrip(before, after);
    }
  });

  it("falls back to one region for a total rewrite of a large file", () => {
    const before = Array.from({ length: 5000 }, (_, i) => `line ${i}\n`).join("");
    const after = Array.from({ length: 5000 }, (_, i) => `other ${i}\n`).join("");
    const edits = roundTrip(before, after);
    expect(edits.length).toBeGreaterThan(0);
  });
});

describe("applyTextEdits", () => {
  it("applies edits in order, each to the result of the last", () => {
    expect(
      applyTextEdits(SONG, [
        { oldText: "bd sd bd sd", newText: "bd cp" },
        { oldText: "bd cp", newText: "bd cp bd" },
      ]),
    ).toContain('s("bd cp bd")');
  });

  it("refuses text that is not there", () => {
    expect(() => applyTextEdits(SONG, [{ oldText: "kick", newText: "bd" }])).toThrow(TextEditError);
    try {
      applyTextEdits(SONG, [{ oldText: "kick", newText: "bd" }]);
    } catch (err) {
      expect((err as TextEditError).code).toBe("noMatch");
    }
  });

  it("refuses ambiguous text unless replaceAll", () => {
    try {
      applyTextEdits(SONG, [{ oldText: ".gain(", newText: ".velocity(" }]);
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as TextEditError).code).toBe("ambiguous");
      expect((err as Error).message).toContain("2 times");
    }
    const all = applyTextEdits(SONG, [{ oldText: ".gain(", newText: ".velocity(", replaceAll: true }]);
    expect(all).not.toContain(".gain(");
    expect(all.match(/\.velocity\(/g)).toHaveLength(2);
  });

  it("names which edit failed when there are several", () => {
    expect(() =>
      applyTextEdits(SONG, [
        { oldText: "setcps(0.5)", newText: "setcps(1)" },
        { oldText: "nope", newText: "x" },
      ]),
    ).toThrow(/^Edit 2:/);
  });
});
