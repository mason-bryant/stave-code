import type { CanvasCapture } from "./types";

/**
 * A picture of what a visual is drawing, for the agent to look at.
 *
 * The canvas is copied with `drawImage` inside an animation frame. That one
 * route covers both kinds of renderer: a main-thread WebGL canvas (whose
 * drawing buffer is only guaranteed intact during the frame it was drawn in)
 * and a worker renderer's placeholder canvas, which shows the last frame the
 * worker committed and cannot be read with `toDataURL` at all.
 */

type Source = CanvasCapture["source"];

interface Candidate {
  readonly canvas: HTMLCanvasElement;
  readonly source: Source;
}

function visibleArea(el: Element): number {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r.width * r.height : 0;
}

/** The largest visible canvas under any of `roots`. */
function largestCanvas(roots: Iterable<Element>): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null;
  let bestArea = 0;
  for (const root of roots) {
    for (const c of Array.from(root.querySelectorAll("canvas"))) {
      const area = visibleArea(c);
      if (area > bestArea) {
        best = c;
        bestArea = area;
      }
    }
  }
  return best;
}

function attr(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/**
 * Which canvas to capture. With a file: its preview tab, else the backdrop when
 * it is the backdrop. Without: the backdrop, else any preview, else the largest
 * visual anywhere (an inline `.viz` zone).
 */
export function findVisualCanvas(fileId: string | null, doc: Document = document): Candidate | null {
  if (fileId) {
    const preview = largestCanvas(doc.querySelectorAll(`[data-workspace-view="preview"][data-file-id="${attr(fileId)}"]`));
    if (preview) return { canvas: preview, source: "preview" };
    const backdrop = largestCanvas(doc.querySelectorAll(`[data-background-file-id="${attr(fileId)}"]`));
    if (backdrop) return { canvas: backdrop, source: "backdrop" };
    return null;
  }
  const backdrop = largestCanvas(doc.querySelectorAll("[data-background-file-id]"));
  if (backdrop) return { canvas: backdrop, source: "backdrop" };
  const preview = largestCanvas(doc.querySelectorAll('[data-workspace-view="preview"]'));
  if (preview) return { canvas: preview, source: "preview" };
  const any = largestCanvas([doc.body]);
  return any ? { canvas: any, source: "inline" } : null;
}

/** Is `fileId` drawing somewhere on screen (a preview tab or the backdrop)? */
export function isVisualOnScreen(fileId: string, doc: Document = document): boolean {
  return findVisualCanvas(fileId, doc) !== null;
}

/**
 * The next animation frame — or, in a background tab where frames stop, a short
 * timeout instead, so a capture there still returns (the last drawn frame).
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 250);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Copy `canvas` (scaled to at most `maxWidth`) and encode it as PNG. */
export async function captureCanvas(
  candidate: Candidate,
  path: string | null,
  maxWidth: number,
): Promise<CanvasCapture> {
  const { canvas, source } = candidate;
  // Let the renderer draw a frame first; the copy is made in the frame after.
  await nextFrame();
  const srcW = canvas.width || Math.round(canvas.getBoundingClientRect().width);
  const srcH = canvas.height || Math.round(canvas.getBoundingClientRect().height);
  if (srcW === 0 || srcH === 0) throw new Error("The visual has no size yet.");
  const scale = Math.min(1, maxWidth / srcW);
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser could not make a canvas to copy into.");
  await nextFrame();
  ctx.drawImage(canvas, 0, 0, width, height);

  let dataUrl: string;
  try {
    dataUrl = out.toDataURL("image/png");
  } catch {
    // A visual that drew a cross-origin image or video without CORS taints the copy.
    throw new Error("The visual uses media from another site, so the browser will not let it be copied.");
  }
  return {
    path,
    source,
    width,
    height,
    mimeType: "image/png",
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    blank: isBlank(ctx, width, height),
  };
}

/** Every pixel on a coarse grid is the same colour. */
function isBlank(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const stepX = Math.max(1, Math.floor(width / 24));
  const stepY = Math.max(1, Math.floor(height / 24));
  let first: number | null = null;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = (y * width + x) * 4;
      const rgba = ((pixels[i] << 24) | (pixels[i + 1] << 16) | (pixels[i + 2] << 8) | pixels[i + 3]) >>> 0;
      if (first === null) first = rgba;
      else if (rgba !== first) return false;
    }
  }
  return true;
}
