/**
 * The bridge's view of the song engines. The runtimes live in
 * `StrudelEditorClient` (`runtimesRef`), which registers this access while it
 * is mounted — the same seam shape as the editor's `registerReevalHandler`.
 */

export interface EvaluationOutcome {
  readonly error: Error | null;
}

export interface AgentRuntimeAccess {
  /** Is `fileId`'s song playing? */
  isPlaying(fileId: string): boolean;
  /**
   * Evaluate `fileId` without sound — the Song timeline's speculative
   * evaluate, which reports nothing to the Console. Null when the file has no
   * engine (not a song) or it is playing; 'timeout' when the evaluate did not
   * settle in time (it is bounded, like the timeline's own refresh, #1221).
   */
  checkEvaluate(fileId: string): Promise<EvaluationOutcome | "timeout" | null>;
  /**
   * The next evaluation of `fileId` that its engine reports — subscribe BEFORE
   * the change that will cause it. 'timeout' when none came in `timeoutMs`.
   */
  nextEvaluation(fileId: string, timeoutMs: number): Promise<EvaluationOutcome | "timeout">;
}

let access: AgentRuntimeAccess | null = null;

export function registerAgentRuntimeAccess(a: AgentRuntimeAccess): () => void {
  access = a;
  return () => {
    if (access === a) access = null;
  };
}

export function getAgentRuntimeAccess(): AgentRuntimeAccess | null {
  return access;
}

/**
 * Whether `p` settles within `ms`. The bridge answers one request at a time, so
 * an evaluate that never settles must not be awaited unbounded: it would hold
 * every request behind it.
 */
export function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    p.then(done, done);
  });
}
