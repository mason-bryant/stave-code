import { useSyncExternalStore } from "react";

import { AgentBridgeConnector, type AgentBridgeState } from "./connector";
import { createBridgeHandlers, type HandlerDeps } from "./handlers";
import type { ProjectInfo } from "./types";

export type { AgentBridgeState } from "./connector";
export { registerAgentRuntimeAccess, type AgentRuntimeAccess } from "./runtimeAccess";
export {
  ProjectSwitchRefused,
  markAgentProjectReady,
  registerAgentProjectAccess,
  type AgentProjectAccess,
} from "./projectAccess";
export {
  getAgentBridgeSettings,
  parsePairingCode,
  setAgentBridgeSettings,
  subscribeAgentBridgeSettings,
} from "./settings";

/**
 * The Claude Code bridge (see `connector.ts`). One per page: StaveApp starts it
 * at boot, and it does nothing until the user turns it on in Settings.
 */

interface LiveDeps {
  getProject: () => ProjectInfo | null;
  onAgentChange?: (message: string) => void;
}

let connector: AgentBridgeConnector | null = null;
const live: LiveDeps = { getProject: () => null };

/**
 * Start the bridge, or — on a later call (a remount) — point it at the latest
 * callbacks. Idempotent.
 */
export function startAgentBridge(deps: LiveDeps & { appVersion: string }): AgentBridgeConnector {
  live.getProject = deps.getProject;
  live.onAgentChange = deps.onAgentChange;
  if (connector) return connector;
  const handlerDeps: HandlerDeps = {
    getProject: () => live.getProject(),
    onAgentChange: (m) => live.onAgentChange?.(m),
  };
  connector = new AgentBridgeConnector({
    handlers: createBridgeHandlers(handlerDeps),
    getProject: () => live.getProject(),
    appVersion: deps.appVersion,
  });
  connector.start();
  return connector;
}

export function getAgentBridge(): AgentBridgeConnector | null {
  return connector;
}

const OFF: AgentBridgeState = { kind: "off" };
const subscribeState = (cb: () => void): (() => void) => (connector ? connector.subscribe(cb) : () => {});
const stateSnapshot = (): AgentBridgeState => (connector ? connector.getState() : OFF);
const serverSnapshot = (): AgentBridgeState => OFF;

/** The bridge's connection state, for the Settings section. */
export function useAgentBridgeState(): AgentBridgeState {
  return useSyncExternalStore(subscribeState, stateSnapshot, serverSnapshot);
}
