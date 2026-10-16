import { describe, expect, it } from "vitest";
import * as protocol from "@stave/mcp/protocol";

import { CLOSE_CODES, ERROR_CODES, PROTOCOL_VERSION } from "../types";
import { parsePairingCode } from "../settings";

/**
 * The app takes only TYPES from @stave/mcp, so the few protocol values it needs
 * at runtime are copied into `types.ts`. This holds the copies to the source.
 */
describe("bridge protocol constants", () => {
  it("match stave-mcp's", () => {
    expect(PROTOCOL_VERSION).toBe(protocol.PROTOCOL_VERSION);
    expect(CLOSE_CODES).toEqual(protocol.CLOSE_CODES);
    expect(ERROR_CODES).toEqual(protocol.ERROR_CODES);
  });

  it("read the pairing code stave-mcp prints", () => {
    expect(parsePairingCode(`${protocol.DEFAULT_PORT}-0123456789abcdef0123456789abcdef`)).toEqual({
      port: protocol.DEFAULT_PORT,
      token: "0123456789abcdef0123456789abcdef",
    });
    expect(parsePairingCode("  47883-0123456789abcdef  ")).toEqual({ port: 47883, token: "0123456789abcdef" });
    expect(parsePairingCode("")).toBeNull();
    expect(parsePairingCode("47883")).toBeNull();
    expect(parsePairingCode("47883-short")).toBeNull();
    expect(parsePairingCode("99999-0123456789abcdef")).toBeNull();
    expect(parsePairingCode("0-0123456789abcdef")).toBeNull();
    expect(parsePairingCode("ws://127.0.0.1:47883-0123456789abcdef")).toBeNull();
  });
});
