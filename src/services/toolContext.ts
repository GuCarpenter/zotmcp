/**
 * Builds the service graph the tools run on. One place, so the plugin and the
 * unit tests wire the same objects in the same order.
 */

import { DocumentTextService } from "./documentTextService";
import { ItemResolver } from "./itemResolver";
import { MutationService } from "./mutationService";
import { ReadService } from "./readService";
import { SearchService } from "./searchService";
import type { ZoteroGateway } from "./zoteroGateway";
import type { ToolContext } from "../tools/registry";

export function createToolContext(gateway: ZoteroGateway): ToolContext {
  const resolver = new ItemResolver(gateway);
  return {
    gateway,
    resolver,
    mutations: new MutationService(gateway),
    search: new SearchService(gateway, resolver),
    documents: new DocumentTextService(gateway),
    read: new ReadService(gateway),
  };
}
