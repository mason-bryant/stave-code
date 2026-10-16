/**
 * The bridge protocol's types, from the stave-mcp package that owns them.
 * Type-only: nothing from @stave/mcp is bundled into the app.
 */
export type {
  CanvasCapture,
  DiagnosticEntry,
  Diagnostics,
  EvaluationKind,
  FileSummary,
  HelloParams,
  HelloResult,
  ParamsOf,
  ProjectInfo,
  ProjectStatus,
  ResultOf,
  StaveMethod,
  StaveMethods,
  TextEdit,
  WriteResult,
} from "@stave/mcp/protocol";
export type { OffsetEdit } from "@stave/editor";

/**
 * The protocol's close and error codes. Repeated here as values because the
 * app takes nothing from @stave/mcp at runtime; `protocolConstants.test.ts`
 * holds the two copies equal.
 */
export const PROTOCOL_VERSION = 1 as const;

export const CLOSE_CODES = {
  replaced: 4001,
  badToken: 4003,
  badProtocol: 4004,
  helloTimeout: 4008,
} as const;

export const ERROR_CODES = {
  notFound: 1001,
  conflict: 1002,
  readOnly: 1003,
  notReady: 1004,
  noMatch: 1005,
  ambiguous: 1006,
  noCanvas: 1007,
  badPath: 1008,
  badToken: 1009,
} as const;

/** An error a handler throws to answer a request with a specific code. */
export class BridgeRequestError extends Error {
  constructor(
    readonly code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
    message: string,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}
