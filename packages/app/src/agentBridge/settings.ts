/**
 * The Claude Code bridge setting: whether this browser lets a local stave-mcp
 * drive the open project, and the pairing code it was given.
 *
 * Per browser, not per project — the bridge follows whichever project the tab
 * has open. Off unless the user turns it on.
 */

const STORAGE_KEY = "stave:agentBridge";

export interface AgentBridgeSettings {
  readonly enabled: boolean;
  /** What the user pasted: `<port>-<token>`, as `stave-mcp pairing-code` prints it. */
  readonly code: string;
}

const DEFAULTS: AgentBridgeSettings = { enabled: false, code: "" };

export interface PairingCode {
  readonly port: number;
  readonly token: string;
}

/** `47883-0f3a…` → port and token, or null when it is not a pairing code. */
export function parsePairingCode(raw: string): PairingCode | null {
  const m = /^\s*(\d{1,5})-([A-Za-z0-9_-]{16,128})\s*$/.exec(raw);
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1 || port > 65535) return null;
  return { port, token: m[2] };
}

const listeners = new Set<() => void>();
let cached: AgentBridgeSettings | null = null;

export function getAgentBridgeSettings(): AgentBridgeSettings {
  if (cached) return cached;
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as Partial<AgentBridgeSettings>) : {};
    cached = {
      enabled: parsed.enabled === true,
      code: typeof parsed.code === "string" ? parsed.code : "",
    };
  } catch {
    cached = DEFAULTS;
  }
  return cached;
}

export function setAgentBridgeSettings(patch: Partial<AgentBridgeSettings>): void {
  const next = { ...getAgentBridgeSettings(), ...patch };
  cached = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // private mode: the setting lasts for this page only
  }
  for (const cb of Array.from(listeners)) cb();
}

export function subscribeAgentBridgeSettings(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Tests only: forget the cached read so the next one sees localStorage. */
export function __resetAgentBridgeSettingsForTests(): void {
  cached = null;
  listeners.clear();
}
