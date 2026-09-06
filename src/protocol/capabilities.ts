/**
 * MCP protocol version negotiation and advertised capabilities.
 *
 * The server is stateless (spec S-6): `initialize` is informational, no session
 * is created, and a later `tools/call` on a fresh connection is equally valid.
 */

import { config } from "../../package.json";

/** Newest version this server implements. */
export const LATEST_PROTOCOL_VERSION = "2025-06-18";

/** Older revisions a client may ask for, oldest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  LATEST_PROTOCOL_VERSION,
] as const;

export const SERVER_INFO = {
  name: config.addonRef,
  version: "1.0.0",
} as const;

/**
 * Echoes the client's requested version when supported, else answers with the
 * newest version this server speaks and lets the client decide.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  if (
    typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
  ) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

export function buildInitializeResult(params?: Record<string, unknown>) {
  return {
    protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
    // Tools and resources only: no prompts, no sampling, no server-initiated
    // messages — nothing in scope needs a push channel.
    capabilities: {
      tools: {},
      resources: {},
    },
    serverInfo: SERVER_INFO,
  };
}
