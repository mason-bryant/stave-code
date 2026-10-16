import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentBridgeConnector } from "../connector";
import type { BridgeHandlers } from "../handlers";
import { __resetAgentBridgeSettingsForTests, setAgentBridgeSettings } from "../settings";
import { BridgeRequestError, CLOSE_CODES, ERROR_CODES } from "../types";

/**
 * The connector's state machine against a scripted socket. The real socket,
 * server and pairing are exercised end to end by tests/agent-bridge.spec.ts.
 */

class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  // ── script ──
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const CODE = "47883-0123456789abcdef0123";

function makeConnector(handlers: Partial<BridgeHandlers> = {}) {
  return new AgentBridgeConnector({
    handlers: handlers as BridgeHandlers,
    getProject: () => ({ id: "p1", name: "Song" }),
    appVersion: "9.9.9",
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
  });
}

function last(): FakeSocket {
  return FakeSocket.instances[FakeSocket.instances.length - 1];
}

function pair(ws: FakeSocket): void {
  ws.open();
  ws.receive({ jsonrpc: "2.0", id: 0, result: { server: { name: "stave-mcp", version: "0.1.0", protocol: 1 } } });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let connector: AgentBridgeConnector;

beforeEach(() => {
  FakeSocket.instances = [];
  window.localStorage.clear();
  __resetAgentBridgeSettingsForTests();
});

afterEach(() => {
  connector?.stop();
  vi.useRealTimers();
});

describe("AgentBridgeConnector", () => {
  it("stays off, and opens nothing, until the user turns it on with a code", () => {
    connector = makeConnector();
    connector.start();
    expect(connector.getState()).toEqual({ kind: "off" });
    setAgentBridgeSettings({ enabled: true });
    expect(connector.getState()).toEqual({ kind: "no-code" });
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("dials 127.0.0.1 on the code's port, says hello with the token, and reports connected", () => {
    connector = makeConnector();
    connector.start();
    setAgentBridgeSettings({ enabled: true, code: CODE });
    const ws = last();
    expect(ws.url).toBe("ws://127.0.0.1:47883/");
    expect(connector.getState()).toEqual({ kind: "connecting", port: 47883 });
    ws.open();
    expect(ws.sent[0]).toMatchObject({
      method: "bridge.hello",
      params: { token: "0123456789abcdef0123", protocol: 1, app: { version: "9.9.9" }, project: { id: "p1", name: "Song" } },
    });
    ws.receive({ jsonrpc: "2.0", id: 0, result: { server: { name: "stave-mcp", version: "0.1.0", protocol: 1 } } });
    expect(connector.getState()).toEqual({ kind: "connected", port: 47883, server: "stave-mcp 0.1.0" });
  });

  it("answers requests one at a time, in order, with results and coded errors", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    connector = makeConnector({
      "files.read": async ({ path }) => {
        order.push(`start ${path}`);
        if (path === "slow") await new Promise<void>((r) => (release = r));
        order.push(`end ${path}`);
        if (path === "missing") throw new BridgeRequestError(ERROR_CODES.notFound, "No file");
        return { path, language: "strudel", content: "x" };
      },
    });
    connector.start();
    setAgentBridgeSettings({ enabled: true, code: CODE });
    const ws = last();
    pair(ws);
    ws.receive({ jsonrpc: "2.0", id: 1, method: "files.read", params: { path: "slow" } });
    ws.receive({ jsonrpc: "2.0", id: 2, method: "files.read", params: { path: "missing" } });
    ws.receive({ jsonrpc: "2.0", id: 3, method: "files.nope", params: {} });
    await flush();
    expect(order).toEqual(["start slow"]);
    release();
    await flush();
    await flush();
    expect(order).toEqual(["start slow", "end slow", "start missing", "end missing"]);
    const replies = ws.sent.slice(1);
    expect(replies[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { path: "slow", language: "strudel", content: "x" } });
    expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 2, error: { code: ERROR_CODES.notFound, message: "No file" } });
    expect(replies[2]).toMatchObject({ id: 3, error: { code: -32601 } });
  });

  it("gives up on a request that never settles, so the ones behind it still run", async () => {
    vi.useFakeTimers();
    connector = makeConnector({
      "files.list": () => new Promise(() => {}),
      "files.read": async ({ path }) => ({ path, language: "strudel", content: "x" }),
    });
    connector.start();
    setAgentBridgeSettings({ enabled: true, code: CODE });
    const ws = last();
    pair(ws);
    ws.receive({ jsonrpc: "2.0", id: 1, method: "files.list", params: {} });
    ws.receive({ jsonrpc: "2.0", id: 2, method: "files.read", params: { path: "a.strudel" } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.sent.slice(1)).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Stave gave up on files.list after 30s." } },
      { jsonrpc: "2.0", id: 2, result: { path: "a.strudel", language: "strudel", content: "x" } },
    ]);
  });

  it("stops, and says why, when the pairing code is refused — until the code changes", () => {
    connector = makeConnector();
    connector.start();
    setAgentBridgeSettings({ enabled: true, code: CODE });
    const ws = last();
    ws.open();
    ws.receive({ jsonrpc: "2.0", id: 0, error: { code: ERROR_CODES.badToken, message: "pairing code refused" } });
    expect(connector.getState()).toEqual({ kind: "refused", port: 47883, reason: "bad-token" });
    setAgentBridgeSettings({ enabled: true, code: CODE });
    expect(FakeSocket.instances).toHaveLength(1);
    setAgentBridgeSettings({ code: "47883-ffffffffffffffffffff" });
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("stops when another tab takes over, and takes it back on reconnect", () => {
    connector = makeConnector();
    connector.start();
    setAgentBridgeSettings({ enabled: true, code: CODE });
    pair(last());
    last().drop(CLOSE_CODES.replaced);
    expect(connector.getState()).toEqual({ kind: "replaced", port: 47883 });
    connector.reconnect();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(connector.getState().kind).toBe("connecting");
  });

  it("keeps retrying with back-off while stave-mcp is not running", () => {
    vi.useFakeTimers();
    connector = makeConnector();
    connector.start();
    setAgentBridgeSettings({ enabled: true, code: CODE });
    last().drop(1006);
    expect(connector.getState()).toEqual({ kind: "waiting", port: 47883, retryInMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    last().drop(1006);
    expect(connector.getState()).toMatchObject({ retryInMs: 2000 });
    vi.advanceTimersByTime(2000);
    pair(last());
    expect(connector.getState().kind).toBe("connected");
    // a later drop starts the back-off over
    last().drop(1006);
    expect(connector.getState()).toMatchObject({ retryInMs: 1000 });
  });

  it("closes the socket when the user turns it off", () => {
    connector = makeConnector();
    connector.start();
    setAgentBridgeSettings({ enabled: true, code: CODE });
    const ws = last();
    pair(ws);
    setAgentBridgeSettings({ enabled: false });
    expect(ws.readyState).toBe(3);
    expect(connector.getState()).toEqual({ kind: "off" });
  });

  it("tells stave-mcp when the user switches projects", () => {
    connector = makeConnector();
    connector.start();
    setAgentBridgeSettings({ enabled: true, code: CODE });
    const ws = last();
    pair(ws);
    connector.projectChanged();
    expect(ws.sent[ws.sent.length - 1]).toEqual({ jsonrpc: "2.0", method: "bridge.project", params: { project: { id: "p1", name: "Song" } } });
  });
});
