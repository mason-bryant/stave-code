// @vitest-environment jsdom
/**
 * Edit → Undo acts where ⌘Z would have: where focus was before the menu was opened.
 * Pressing a menu takes focus (Chromium) or drops it (Safari), so the element is
 * kept at the moment a press or focus reaches a menu from outside.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetFocusBeforeMenuForTests, focusBeforeMenu, trackFocusBeforeMenus } from "../undoFocus";

let stop = () => {};

function setUp() {
  document.body.innerHTML = `
    <textarea id="code"></textarea>
    <button id="lamp">lamp</button>
    <div data-keeps-undo-target><button id="edit">Edit</button><button id="undo">Undo</button></div>`;
  const $ = (id: string) => document.getElementById(id)!;
  return { code: $("code"), lamp: $("lamp"), edit: $("edit"), undo: $("undo") };
}

const press = (el: Element) => el.dispatchEvent(new Event("pointerdown", { bubbles: true }));

beforeEach(() => {
  __resetFocusBeforeMenuForTests();
  stop = trackFocusBeforeMenus(document);
});
afterEach(() => {
  stop();
  document.body.innerHTML = "";
});

describe("focus before a menu", () => {
  it("keeps the code editor's focus through opening the menu and pressing Undo", () => {
    const { code, edit, undo } = setUp();
    code.focus();
    press(edit);
    edit.focus(); // Chromium moves focus onto the pressed button
    press(undo);
    undo.focus();
    expect(focusBeforeMenu()).toBe(code);
  });

  it("Safari: the press moves focus off everything, and the editor is still what was kept", () => {
    const { code, edit } = setUp();
    code.focus();
    press(edit);
    code.blur();
    expect(document.activeElement).toBe(document.body);
    expect(focusBeforeMenu()).toBe(code);
  });

  it("a press on the lamp first means the lamp — as it does for ⌘Z", () => {
    const { code, lamp, edit } = setUp();
    code.focus();
    lamp.focus();
    press(edit);
    expect(focusBeforeMenu()).toBe(lamp);
  });

  it("from the keyboard: Tab onto a menu keeps what lost focus", () => {
    const { code, edit } = setUp();
    code.focus();
    edit.focus(); // focusin on the menu, relatedTarget = the editor
    expect(focusBeforeMenu()).toBe(code);
  });

  it("presses outside every menu change nothing", () => {
    const { code, lamp } = setUp();
    code.focus();
    press(lamp);
    expect(focusBeforeMenu()).toBeNull();
  });
});
