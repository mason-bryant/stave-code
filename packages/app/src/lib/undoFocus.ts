/**
 * Where focus was before a menu was opened — so Edit → Undo acts where ⌘Z would have.
 *
 * Undo picks its target from focus (`undoTargetFor`): the code editor, the panel
 * that writes code, or else the project's file changes. Pressing a menu moves focus
 * onto the menu (Chromium) or off everything (Safari), so by the time Edit → Undo
 * runs, focus says nothing about where the user was. Every menu is marked with
 * `data-keeps-undo-target`; when a press or focus reaches one from outside, the
 * element that had focus is kept here for the menu to use.
 *
 * Only the menus are marked, not the whole menu bar: pressing the eval lamp beside
 * them is a move to somewhere else, as it is for ⌘Z.
 */

export const KEEPS_UNDO_TARGET_ATTR = "data-keeps-undo-target";

let kept: Element | null = null;

const inMenu = (node: EventTarget | null): boolean =>
  node instanceof Element && !!node.closest(`[${KEEPS_UNDO_TARGET_ATTR}]`);

/** Start keeping track. Returns a function that stops it. */
export function trackFocusBeforeMenus(doc: Document = document): () => void {
  const keep = (el: Element | null) => {
    if (!inMenu(el)) kept = el;
  };
  // A press comes before the focus change it causes, so focus is still where
  // the user was — and Safari never moves focus onto a pressed button at all.
  const onPointerDown = (e: Event) => {
    if (inMenu(e.target)) keep(doc.activeElement);
  };
  // From the keyboard, Tab onto a menu: what lost focus is where the user was.
  const onFocusIn = (e: FocusEvent) => {
    if (inMenu(e.target)) keep(e.relatedTarget instanceof Element ? e.relatedTarget : null);
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("focusin", onFocusIn, true);
  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("focusin", onFocusIn, true);
  };
}

/** The element that had focus before the last menu was opened; null when nothing had. */
export function focusBeforeMenu(): Element | null {
  return kept;
}

export function __resetFocusBeforeMenuForTests(): void {
  kept = null;
}
