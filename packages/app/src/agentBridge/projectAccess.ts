/**
 * The bridge's view of the project list. The list and the open project are
 * React state in `StaveApp`, which registers this access while it is mounted —
 * the same seam shape as `runtimeAccess.ts`.
 *
 * A switch remounts `StrudelEditorClient` (keyed on the project id), and only
 * once that has mounted is the project ready for a write: its bundled visuals
 * are seeded, and History is started for it, so a file created then is
 * recorded as its own commit rather than folded into the project's first one.
 * The editor says so through `markAgentProjectReady`.
 */

import type { ProjectMeta } from "@stave/editor";

export interface AgentProjectAccess {
  /** Every project, most recently opened first. */
  list(): Promise<ProjectMeta[]>;
  /** Create an empty project named `name` and switch the tab to it. */
  create(name: string): Promise<ProjectMeta>;
  /** Switch the tab to the existing project `id`. */
  open(id: string): Promise<ProjectMeta>;
}

/**
 * Why a switch was refused before anything changed: `unsaved` — storage is
 * full and the open project holds changes the disk refused (#1779); `busy` —
 * the tab is already switching projects.
 */
export class ProjectSwitchRefused extends Error {
  constructor(readonly reason: "unsaved" | "busy") {
    super(reason === "unsaved" ? "The open project has unsaved changes." : "Stave is already switching projects.");
    this.name = "ProjectSwitchRefused";
  }
}

let access: AgentProjectAccess | null = null;

export function registerAgentProjectAccess(a: AgentProjectAccess): () => void {
  access = a;
  return () => {
    if (access === a) access = null;
  };
}

export function getAgentProjectAccess(): AgentProjectAccess | null {
  return access;
}

let readyProject: string | null = null;
const readyListeners = new Set<() => void>();

/**
 * The editor for `projectId` has mounted and its History has started. Returns
 * the cleanup for its unmount.
 */
export function markAgentProjectReady(projectId: string): () => void {
  readyProject = projectId;
  for (const cb of Array.from(readyListeners)) cb();
  return () => {
    if (readyProject === projectId) readyProject = null;
  };
}

export function isAgentProjectReady(projectId: string): boolean {
  return readyProject === projectId;
}

/** Whether `projectId` becomes ready within `timeoutMs`. */
export function whenAgentProjectReady(projectId: string, timeoutMs: number): Promise<boolean> {
  if (readyProject === projectId) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      readyListeners.delete(check);
      resolve(ok);
    };
    const check = (): void => {
      if (readyProject === projectId) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    readyListeners.add(check);
  });
}
