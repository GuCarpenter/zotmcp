/**
 * Tool registry. `tools/list` is generated from this, never hand-maintained —
 * hand-maintained tool lists in comparable projects drifted from their code
 * (spec S-9).
 */

import type { AnnotationService } from "../services/annotationService";
import type { DocumentTextService } from "../services/documentTextService";
import type { EpubCfiService } from "../services/epubCfiService";
import type { ItemResolver } from "../services/itemResolver";
import type { MutationService } from "../services/mutationService";
import type {
  AttachmentService,
  CollectionService,
  DeleteService,
  ImportService,
} from "../services/libraryWriteServices";
import type { NoteService } from "../services/noteService";
import type { ReaderService } from "../services/readerService";
import type { ReadService } from "../services/readService";
import type { SearchService } from "../services/searchService";
import type { ScriptService } from "../services/scriptService";
import type { WriteService } from "../services/writeService";
import type { ZoteroGateway } from "../services/zoteroGateway";

export type ToolMutability = "read" | "write";

export interface ToolContext {
  gateway: ZoteroGateway;
  resolver: ItemResolver;
  mutations: MutationService;
  search: SearchService;
  documents: DocumentTextService;
  read: ReadService;
  notes: NoteService;
  annotations: AnnotationService;
  epubCfi: EpubCfiService;
  writes: WriteService;
  collections: CollectionService;
  imports: ImportService;
  deletes: DeleteService;
  attachments: AttachmentService;
  scripts: ScriptService;
  reader: ReaderService;
}

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutability: ToolMutability;
  /** Set for tools that trash or overwrite data, surfaced as destructiveHint. */
  destructive?: boolean;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolListEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint?: boolean;
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  public register(spec: ToolSpec): void {
    if (this.tools.has(spec.name)) {
      throw new Error(`Tool "${spec.name}" is already registered.`);
    }
    this.tools.set(spec.name, spec);
  }

  public get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  public names(): string[] {
    return [...this.tools.keys()];
  }

  public all(): ToolSpec[] {
    return [...this.tools.values()];
  }

  public list(): ToolListEntry[] {
    return this.all().map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: {
        readOnlyHint: spec.mutability === "read",
        ...(spec.destructive ? { destructiveHint: true } : {}),
      },
    }));
  }
}

export function textResult(
  text: string,
  structuredContent?: unknown,
): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

export function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2), value);
}

/** A tool failure is a normal result with `isError`, not a JSON-RPC error. */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
