/**
 * Builds the service graph the tools run on. One place, so the plugin and the
 * unit tests wire the same objects in the same order.
 */

import { AnnotationService } from "./annotationService";
import {
  AttachmentService,
  CollectionService,
  DeleteService,
  ImportService,
} from "./libraryWriteServices";
import { DocumentTextService } from "./documentTextService";
import { ItemResolver } from "./itemResolver";
import { MutationService } from "./mutationService";
import { NoteService } from "./noteService";
import { ReaderService } from "./readerService";
import { ReadService } from "./readService";
import { ScriptService } from "./scriptService";
import { SearchService } from "./searchService";
import { WriteService } from "./writeService";
import type { ZoteroGateway } from "./zoteroGateway";
import type { ToolContext } from "../tools/registry";

export function createToolContext(gateway: ZoteroGateway): ToolContext {
  const resolver = new ItemResolver(gateway);
  const mutations = new MutationService(gateway);
  return {
    gateway,
    resolver,
    mutations,
    search: new SearchService(gateway, resolver),
    documents: new DocumentTextService(gateway),
    read: new ReadService(gateway),
    notes: new NoteService(gateway, resolver),
    annotations: new AnnotationService(gateway, resolver),
    writes: new WriteService(gateway, resolver, mutations),
    collections: new CollectionService(gateway, resolver, mutations),
    imports: new ImportService(gateway, resolver, mutations),
    deletes: new DeleteService(gateway, resolver, mutations),
    attachments: new AttachmentService(gateway, resolver, mutations),
    scripts: new ScriptService(gateway, mutations),
    reader: new ReaderService(gateway, resolver),
  };
}
