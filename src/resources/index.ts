/**
 * MCP resources. Three read-only views onto My Library (spec S-10).
 *
 * `list` is complete; `read` lands with the library services in Phase 8.
 */

import { ZotmcpError } from "../errors";
import type { ResourceProvider } from "../protocol/dispatch";

export const RESOURCE_DESCRIPTORS = [
  {
    uri: "zotero://collections",
    name: "Collections",
    description: "The collection tree of My Library.",
    mimeType: "application/json",
  },
  {
    uri: "zotero://items/{itemKey}",
    name: "Item",
    description: "One item's metadata, by 8-character item key.",
    mimeType: "application/json",
  },
  {
    uri: "zotero://collections/{collectionKey}/items",
    name: "Collection items",
    description: "The items in one collection, by 8-character collection key.",
    mimeType: "application/json",
  },
] as const;

export function createResourceProvider(): ResourceProvider {
  return {
    async list() {
      return [...RESOURCE_DESCRIPTORS];
    },

    async read(uri: string) {
      throw new ZotmcpError(
        "internal",
        `Reading resource "${uri}" is not implemented yet (planned in Phase 8).`,
      );
    },
  };
}
