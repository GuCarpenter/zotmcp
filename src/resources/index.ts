/**
 * MCP resources: three read-only views onto My Library (spec S-10).
 *
 * Templated URIs are matched here; `resources/list` advertises the templates and
 * `resources/read` resolves a concrete URI.
 */

import { InvalidArgumentError } from "../errors";
import type { ResourceProvider } from "../protocol/dispatch";
import { buildCollectionSelectUri } from "../services/uriService";
import type { ToolContext } from "../tools/registry";

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

const COLLECTION_ITEMS = /^zotero:\/\/collections\/([A-Z0-9]{8})\/items$/;
const ITEM = /^zotero:\/\/items\/([A-Z0-9]{8})$/;

export interface CollectionNode {
  key: string;
  name: string;
  uri: string;
  children: CollectionNode[];
}

/** Builds the collection tree from a flat list, parents before children. */
export function buildCollectionTree(
  collections: { key: string; name: string; parentKey?: string | false }[],
): CollectionNode[] {
  const nodes = new Map<string, CollectionNode>();
  for (const collection of collections) {
    nodes.set(collection.key, {
      key: collection.key,
      name: collection.name,
      uri: buildCollectionSelectUri(collection.key),
      children: [],
    });
  }

  const roots: CollectionNode[] = [];
  for (const collection of collections) {
    const node = nodes.get(collection.key)!;
    const parentKey =
      typeof collection.parentKey === "string" ? collection.parentKey : null;
    const parent = parentKey ? nodes.get(parentKey) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const byName = (a: CollectionNode, b: CollectionNode) =>
    a.name.localeCompare(b.name);
  const sortTree = (list: CollectionNode[]) => {
    list.sort(byName);
    for (const node of list) sortTree(node.children);
  };
  sortTree(roots);

  return roots;
}

export function createResourceProvider(ctx: ToolContext): ResourceProvider {
  return {
    async list() {
      return [...RESOURCE_DESCRIPTORS];
    },

    async read(uri: string) {
      const payload = await resolve(uri, ctx);
      return [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ];
    },
  };
}

async function resolve(uri: string, ctx: ToolContext): Promise<unknown> {
  if (uri === "zotero://collections") {
    const collections = ctx.gateway.getCollectionsByLibrary(
      ctx.gateway.userLibraryID,
      true,
    );
    const tree = buildCollectionTree(
      collections.map((collection) => ({
        key: collection.key,
        name: collection.name,
        parentKey: collection.parentKey,
      })),
    );
    return { total: collections.length, collections: tree };
  }

  const itemMatch = ITEM.exec(uri);
  if (itemMatch) {
    const item = await ctx.resolver.resolveItem(itemMatch[1]);
    return ctx.read.read(item, ["metadata", "abstract"]);
  }

  const collectionMatch = COLLECTION_ITEMS.exec(uri);
  if (collectionMatch) {
    const collection = await ctx.resolver.resolveCollection(collectionMatch[1]);
    const itemIDs = (
      collection as unknown as { getChildItems(): { id: number }[] }
    )
      .getChildItems()
      .map((child) => child.id);
    const items = await ctx.gateway.getItemsByID(itemIDs);
    return {
      collectionKey: collection.key,
      name: collection.name,
      total: items.length,
      items: items.map((item) => ctx.read.summarize(item)),
    };
  }

  throw new InvalidArgumentError(
    `Unknown resource "${uri}". Available: ${RESOURCE_DESCRIPTORS.map(
      (descriptor) => descriptor.uri,
    ).join(", ")}.`,
  );
}
