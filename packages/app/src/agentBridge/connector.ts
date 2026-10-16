import { getAgentBridgeSettings, parsePairingCode, subscribeAgentBridgeSettings } from "./settings";
import type { BridgeHandlers } from "./handlers";
import { BridgeRequestError, CLOSE_CODES, ERROR_CODES, PROTOCOL_VERSION, type HelloParams, type ProjectInfo, type StaveMethod } from "./types";

/**
 * The tab's end of the Claude Code bridge: a WebSocket to stave-mcp on this
 * machine, opened only while the user has the setting on.
 *
 * The tab dials out — a page cannot listen — and then answers stave-mcp's
 * requests one at a time with the handlers. While stave-mcp is not running
 * (Claude Code closed) it keeps trying, backing off to every 30 seconds.
 * It stops trying, and says why, when the pairing code is refused or another
 * tab has taken over; the user changes the code or presses Reconnect.
 */

export type AgentBridgeState =
  | { readonly kind: "off" }
  /** On, but the pairing code is missing or malformed. */
  | { readonly kind: "no-code" }
  | { readonly kind: "connecting"; readonly port: number }
  /** stave-mcp did not answer (not running, or the browser blocked the connection). */
  | { readonly kind: "waiting"; readonly port: number; readonly retryInMs: number }
  | { readonly kind: "connected"; readonly port: number; readonly server: string }
  | { readonly kind: "refused"; readonly port: number; readonly reason: "bad-token" | "bad-protocol" }
  /** Another Stave tab paired after this one. */
  | { readonly kind: "replaced"; readonly port: number }
  | { readonly kind: "unsupported" };

export interface ConnectorDeps {
  readonly handlers: BridgeHandlers;
  readonly getProject: () => ProjectInfo | null;
  readonly appVersion: string;
  /** Tests substitute their own. */
  readonly WebSocketImpl?: typeof WebSocket;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/**
 * The longest one request may hold the queue. Each handler bounds its own
 * waits; this is the backstop, so one that never settles cannot stall every
 * request behind it. Longer than stave-mcp's own timeouts (15s, 20s for a
 * capture), so it never answers before stave-mcp has given up.
 */
const REQUEST_DEADLINE_MS = 30_000;

export class AgentBridgeConnector {
  private state: AgentBridgeState = { kind: "off" };
  private readonly listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private unsubscribeSettings: (() => void) | null = null;
  /** The code the current connection (or refusal) belongs to. */
  private activeCode: string | null = null;
  /** Requests run one at a time, so two writes never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ConnectorDeps) {}

  start(): void {
    if (this.unsubscribeSettings) return;
    this.unsubscribeSettings = subscribeAgentBridgeSettings(() => this.sync());
    this.sync();
  }

  stop(): void {
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.disconnect();
    this.setState({ kind: "off" });
  }

  getState(): AgentBridgeState {
    return this.state;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Try again now — after a refusal, a takeover, or while waiting. */
  reconnect(): void {
    this.activeCode = null;
    this.disconnect();
    this.attempt = 0;
    this.sync();
  }

  /** The user switched projects: tell stave-mcp which one the tools now act on. */
  projectChanged(): void {
    this.sendRaw({ jsonrpc: "2.0", method: "bridge.project", params: { project: this.deps.getProject() } });
  }

  private setState(next: AgentBridgeState): void {
    this.state = next;
    for (const cb of Array.from(this.listeners)) cb();
  }

  /** Bring the connection in line with the setting. */
  private sync(): void {
    const { enabled, code } = getAgentBridgeSettings();
    if (!enabled) {
      this.activeCode = null;
      this.disconnect();
      this.setState({ kind: "off" });
      return;
    }
    const pairing = parsePairingCode(code);
    if (!pairing) {
      this.activeCode = null;
      this.disconnect();
      this.setState({ kind: "no-code" });
      return;
    }
    if (this.activeCode === code) return; // already connected, connecting, or stopped for this code
    this.disconnect();
    this.activeCode = code;
    this.attempt = 0;
    this.connect(pairing.port, pairing.token);
  }

  private disconnect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private connect(port: number, token: string): void {
    const Impl = this.deps.WebSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
    if (!Impl) {
      this.setState({ kind: "unsupported" });
      return;
    }
    this.setState({ kind: "connecting", port });
    let ws: WebSocket;
    try {
      ws = new Impl(`ws://127.0.0.1:${port}/`);
    } catch {
      // Safari throws here for ws:// from an https page (mixed content).
      this.scheduleRetry(port, token);
      return;
    }
    this.ws = ws;
    let paired = false;

    ws.onopen = () => {
      const hello: HelloParams = {
        token,
        protocol: PROTOCOL_VERSION,
        app: { version: this.deps.appVersion },
        project: this.deps.getProject(),
      };
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "bridge.hello", params: hello }));
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg: { id?: number | string; method?: string; params?: unknown; result?: { server?: { name?: string; version?: string } }; error?: { code?: number } };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!paired && msg.id === 0 && msg.method === undefined) {
        if (msg.error) {
          this.stopFor(port, msg.error.code === ERROR_CODES.badToken ? "bad-token" : "bad-protocol");
          return;
        }
        paired = true;
        this.attempt = 0;
        const server = msg.result?.server;
        this.setState({ kind: "connected", port, server: server ? `${server.name ?? "stave-mcp"} ${server.version ?? ""}`.trim() : "stave-mcp" });
        return;
      }
      if (msg.method === "bridge.replaced") {
        this.stopReplaced(port);
        return;
      }
      if (paired && msg.method && msg.id !== undefined) {
        this.enqueue(ws, msg.id, msg.method, msg.params);
      }
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (event.code === CLOSE_CODES.replaced) return this.stopReplaced(port);
      if (event.code === CLOSE_CODES.badToken) return this.stopFor(port, "bad-token");
      if (event.code === CLOSE_CODES.badProtocol) return this.stopFor(port, "bad-protocol");
      this.scheduleRetry(port, token);
    };

    ws.onerror = () => {
      /* onclose follows with the reason */
    };
  }

  private stopFor(port: number, reason: "bad-token" | "bad-protocol"): void {
    this.disconnect();
    this.setState({ kind: "refused", port, reason });
  }

  private stopReplaced(port: number): void {
    this.disconnect();
    this.setState({ kind: "replaced", port });
  }

  private scheduleRetry(port: number, token: string): void {
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.setState({ kind: "waiting", port, retryInMs: delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect(port, token);
    }, delay);
  }

  private enqueue(ws: WebSocket, id: number | string, method: string, params: unknown): void {
    this.queue = this.queue.then(async () => {
      const handler = (this.deps.handlers as unknown as Record<string, ((p: unknown) => Promise<unknown>) | undefined>)[method];
      let reply: unknown;
      if (!handler || !Object.prototype.hasOwnProperty.call(this.deps.handlers, method)) {
        reply = { jsonrpc: "2.0", id, error: { code: -32601, message: `Stave does not know "${method}" (update the app or stave-mcp).` } };
      } else {
        try {
          reply = { jsonrpc: "2.0", id, result: await withDeadline(handler((params ?? {}) as never), method) };
        } catch (err) {
          const code = err instanceof BridgeRequestError ? err.code : -32000;
          const message = err instanceof Error ? err.message : String(err);
          if (!(err instanceof BridgeRequestError)) console.warn(`[stave] agent bridge: ${method as StaveMethod} failed:`, err);
          reply = { jsonrpc: "2.0", id, error: { code, message } };
        }
      }
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
    });
  }

  private sendRaw(msg: unknown): void {
    const ws = this.ws;
    if (ws && ws.readyState === ws.OPEN && this.state.kind === "connected") ws.send(JSON.stringify(msg));
  }
}

function withDeadline<T>(p: Promise<T>, method: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Stave gave up on ${method} after ${REQUEST_DEADLINE_MS / 1000}s.`)), REQUEST_DEADLINE_MS);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
