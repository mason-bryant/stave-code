"use client";

import React, { useState, useSyncExternalStore } from "react";

import {
  getAgentBridge,
  getAgentBridgeSettings,
  parsePairingCode,
  setAgentBridgeSettings,
  subscribeAgentBridgeSettings,
  useAgentBridgeState,
  type AgentBridgeState,
} from "../../agentBridge";
import { SettingRow } from "./SettingRow";
import { Switch } from "./Switch";

function describe(state: AgentBridgeState, https: boolean): { text: string; tone: "ok" | "muted" | "bad" } {
  switch (state.kind) {
    case "off":
      return { text: "Off — Claude Code cannot see this tab.", tone: "muted" };
    case "no-code":
      return { text: "Paste the pairing code from stave-mcp to connect.", tone: "muted" };
    case "connecting":
      return { text: `Connecting to stave-mcp on port ${state.port}…`, tone: "muted" };
    case "waiting":
      return {
        text:
          `Waiting for stave-mcp on port ${state.port}. It runs while a Claude Code session that has it is open.` +
          (https
            ? " If it is running: Chrome asks once to let this site reach apps on this device — allow it; Safari does not allow it from stave.live at all (use Chrome, or a local dev server)."
            : ""),
        tone: "muted",
      };
    case "connected":
      return { text: "Connected — Claude Code can read and change the files in this project.", tone: "ok" };
    case "refused":
      return state.reason === "bad-token"
        ? { text: "stave-mcp refused this pairing code. Get the current one with stave-mcp pairing-code.", tone: "bad" }
        : { text: "This Stave and this stave-mcp speak different versions; update both.", tone: "bad" };
    case "replaced":
      return { text: "Another Stave tab paired with stave-mcp and took over.", tone: "bad" };
    case "unsupported":
      return { text: "This browser cannot open the connection (no WebSocket).", tone: "bad" };
  }
}

/**
 * Settings → Claude Code. Off by default; on, with a pairing code, this tab
 * connects to stave-mcp on this machine and Claude Code can read and change the
 * open project's files. Every change it makes lands in History.
 */
export function AgentBridgeSection() {
  const settings = useSyncExternalStore(subscribeAgentBridgeSettings, getAgentBridgeSettings, getAgentBridgeSettings);
  const state = useAgentBridgeState();
  const [draft, setDraft] = useState(settings.code);

  const https = typeof window !== "undefined" && window.location.protocol === "https:";
  const status = describe(state, https);
  const draftValid = parsePairingCode(draft) !== null;
  const canRetry = state.kind === "refused" || state.kind === "replaced" || state.kind === "waiting";

  const save = (): void => {
    if (draftValid) setAgentBridgeSettings({ code: draft.trim() });
  };

  return (
    <>
      <div className="grp-note">
        Lets Claude Code read and change the songs and visuals in this project through <code>stave-mcp</code>, a small
        server on this computer. Its changes go live as they are made, and each one is recorded in History, so you can
        roll it back.
      </div>
      <SettingRow name="Let Claude Code edit this tab" description="Connects only to stave-mcp on this computer, and only with the pairing code below.">
        <Switch
          ariaLabel="Let Claude Code edit this tab"
          testId="agent-bridge-enabled"
          checked={settings.enabled}
          onChange={(v) => setAgentBridgeSettings({ enabled: v })}
        />
      </SettingRow>
      <div className="pairing">
        <input
          className={`code${draft !== "" && !draftValid ? " err" : ""}`}
          placeholder="pairing code, e.g. 47883-1f0c…"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          aria-label="Pairing code"
          data-testid="agent-bridge-code"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <button
          className="addbtn"
          data-testid="agent-bridge-pair"
          disabled={!draftValid || draft.trim() === settings.code}
          onClick={save}
        >
          Pair
        </button>
      </div>
      <div className={`bridge-status ${status.tone}`} data-testid="agent-bridge-status" data-state={state.kind} role="status">
        <span>{status.text}</span>
        {canRetry && settings.enabled ? (
          <button className="reset" data-testid="agent-bridge-reconnect" onClick={() => getAgentBridge()?.reconnect()}>
            {state.kind === "replaced" ? "Take over" : "Try now"}
          </button>
        ) : null}
      </div>
      <div className="grp-note">
        Set up once, in the Stave repository: <code>pnpm --filter @stave/mcp build</code>, then{" "}
        <code>claude mcp add stave -- node &lt;path to stave&gt;/packages/mcp/dist/cli.js</code>. The pairing code
        comes from <code>node packages/mcp/dist/cli.js pairing-code</code>, or ask Claude for it.
      </div>
    </>
  );
}
