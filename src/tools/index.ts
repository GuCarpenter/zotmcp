/**
 * The complete MCP tool surface: eleven modal tools.
 *
 * Modal rather than many narrow tools, so the whole surface stays cheap to send
 * on every request. Handlers land phase by phase; a not-yet-implemented handler
 * fails loudly and names its phase rather than returning a plausible empty
 * result.
 */

import { ZotmcpError } from "../errors";
import {
  annotationWrite,
  libraryRead,
  librarySearch,
  noteWrite,
  paperRead,
} from "./readHandlers";
import {
  attachmentUpdate,
  collectionUpdate,
  libraryDelete,
  libraryImport,
  libraryUpdate,
} from "./writeHandlers";
import { ToolRegistry, type ToolSpec } from "./registry";

/** Canonical surface. The drift test compares the registry against this. */
export const TOOL_NAMES = [
  "library_search",
  "library_read",
  "paper_read",
  "library_import",
  "library_update",
  "collection_update",
  "library_delete",
  "attachment_update",
  "note_write",
  "annotation_write",
  "zotero_script",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

function pending(name: ToolName, phase: string): ToolSpec["handler"] {
  return async () => {
    throw new ZotmcpError(
      "internal",
      `Tool "${name}" is not implemented yet (planned in ${phase}).`,
    );
  };
}

const OBJECT_SCHEMA = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

const ITEM_KEY = {
  type: "string",
  description: "8-character Zotero item key, e.g. 'ABCD1234'.",
};

const specs: ToolSpec[] = [
  {
    name: "library_search",
    description:
      "Find items, collections and tags in My Library. Modes: keyword metadata " +
      "search, structured field conditions, boolean tag search, citation-key " +
      "lookup, indexed full-text search with snippets, and annotation search by " +
      "text, colour or tag. Also lists the trash. Results are paginated.",
    mutability: "read",
    inputSchema: OBJECT_SCHEMA({
      mode: {
        type: "string",
        enum: [
          "keyword",
          "conditions",
          "tag",
          "citationKey",
          "fulltext",
          "annotation",
        ],
        description: "Which search to run. Default 'keyword'.",
      },
      entity: {
        type: "string",
        enum: ["items", "collections", "tags"],
        description: "What to return. Default 'items'.",
      },
      query: { type: "string", description: "Search text." },
      limit: {
        type: "number",
        description: "Max results (default 25, max 100).",
      },
      offset: { type: "number", description: "Results to skip." },
    }),
    handler: librarySearch,
  },
  {
    name: "library_read",
    description:
      "Read one item's stored state: any subset of metadata, abstract, child " +
      "items, attachments (content type, file path, zotero:// links), tags, " +
      "notes and annotations.",
    mutability: "read",
    inputSchema: OBJECT_SCHEMA(
      {
        itemKey: ITEM_KEY,
        sections: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "metadata",
              "abstract",
              "children",
              "attachments",
              "tags",
              "notes",
              "annotations",
            ],
          },
          description: "Sections to return. Defaults to metadata only.",
        },
      },
      ["itemKey"],
    ),
    handler: libraryRead,
  },
  {
    name: "paper_read",
    description:
      "Read the text of a PDF or EPUB attachment. Modes: 'fulltext' for the " +
      "whole document, 'pages' for a 1-based page range, 'sections' for text by " +
      "document section with titles, levels and start pages. Sections can be " +
      "selected by title so a late section costs nothing for the earlier ones. " +
      "Output is capped and reports truncation.",
    mutability: "read",
    inputSchema: OBJECT_SCHEMA(
      {
        attachmentKey: ITEM_KEY,
        mode: {
          type: "string",
          enum: ["fulltext", "pages", "sections"],
          description: "Default 'fulltext'.",
        },
        pages: {
          type: "string",
          description: "1-based page range for mode 'pages', e.g. '3-5'.",
        },
        includeText: {
          type: "boolean",
          description:
            "For mode 'sections': set false to get titles, levels and start " +
            "pages only, i.e. a table of contents. Default true.",
        },
        select: {
          type: "array",
          items: { type: "string" },
          description:
            "For mode 'sections': read only the sections whose titles start " +
            "with or contain one of these, e.g. ['3.1'] or ['background']. " +
            "A number selector also brings in its subsections, so '3.1' " +
            "includes 3.1.1. Without it every section is returned, and the " +
            "character budget is spent from the start of the document.",
        },
        perSectionMaxChars: {
          type: "number",
          description:
            "For mode 'sections': cap each section's text separately, so one " +
            "long section cannot exhaust the whole budget.",
        },
        maxChars: { type: "number", description: "Output character cap." },
      },
      ["attachmentKey"],
    ),
    handler: paperRead,
  },
  {
    name: "library_import",
    description:
      "Add items to My Library. 'identifiers' resolves DOI, ISBN, arXiv ID, " +
      "PMID or URL through Zotero's translators; 'files' attaches a local file " +
      "to a parent item; 'manual' creates an item from explicit fields.",
    mutability: "write",
    inputSchema: OBJECT_SCHEMA(
      {
        kind: {
          type: "string",
          enum: ["identifiers", "files", "manual"],
        },
        identifiers: { type: "array", items: { type: "string" } },
        filePaths: { type: "array", items: { type: "string" } },
        items: { type: "array", items: { type: "object" } },
        parentItemKey: ITEM_KEY,
        collectionKey: {
          type: "string",
          description: "Optional collection to file new items into.",
        },
      },
      ["kind"],
    ),
    handler: libraryImport,
  },
  {
    name: "library_update",
    description:
      "Change existing items. 'metadata' updates fields and creators; 'tags' " +
      "adds, removes or replaces an item's tags; 'tag' renames, merges, deletes " +
      "or colours a tag across the library; 'parent' reparents or detaches a " +
      "note or attachment; 'related' links or unlinks items in both directions. " +
      "Accepts an operations array to batch several changes in one call.",
    mutability: "write",
    inputSchema: OBJECT_SCHEMA({
      kind: {
        type: "string",
        enum: ["metadata", "tags", "tag", "parent", "related"],
      },
      itemKeys: { type: "array", items: ITEM_KEY },
      operations: {
        type: "array",
        items: { type: "object" },
        description: "Batch of operations, each shaped like a single call.",
      },
    }),
    handler: libraryUpdate,
  },
  {
    name: "collection_update",
    description:
      "Manage collections: create (optionally under a parent), rename, move, " +
      "delete, and add or remove item membership. Deleting a collection leaves " +
      "its items in the library unless deleteItems is set.",
    mutability: "write",
    inputSchema: OBJECT_SCHEMA(
      {
        action: {
          type: "string",
          enum: [
            "create",
            "rename",
            "move",
            "delete",
            "addItems",
            "removeItems",
          ],
        },
        collectionKey: { type: "string" },
        parentCollectionKey: { type: "string" },
        name: { type: "string" },
        itemKeys: { type: "array", items: ITEM_KEY },
        deleteItems: {
          type: "boolean",
          description: "For 'delete': also move member items to the trash.",
        },
      },
      ["action"],
    ),
    handler: collectionUpdate,
  },
  {
    name: "library_delete",
    description:
      "Move items to the trash, restore trashed items, or merge duplicates into " +
      "a chosen master item.",
    mutability: "write",
    destructive: true,
    inputSchema: OBJECT_SCHEMA(
      {
        mode: { type: "string", enum: ["trash", "restore", "merge"] },
        itemKeys: { type: "array", items: ITEM_KEY },
        masterItemKey: ITEM_KEY,
      },
      ["mode"],
    ),
    handler: libraryDelete,
  },
  {
    name: "attachment_update",
    description:
      "Rename an attachment's file on disk, relink it to a different path, or " +
      "move the attachment to the trash.",
    mutability: "write",
    inputSchema: OBJECT_SCHEMA(
      {
        action: { type: "string", enum: ["rename", "relink", "delete"] },
        attachmentKey: ITEM_KEY,
        newName: { type: "string" },
        newPath: { type: "string" },
      },
      ["action", "attachmentKey"],
    ),
    handler: attachmentUpdate,
  },
  {
    name: "note_write",
    description:
      "Create, replace or append to a Zotero note. Markdown input is converted " +
      "to Zotero note HTML. A new note can be attached to an item or left " +
      "standalone.",
    mutability: "write",
    inputSchema: OBJECT_SCHEMA(
      {
        action: { type: "string", enum: ["create", "update", "append"] },
        noteKey: ITEM_KEY,
        parentItemKey: ITEM_KEY,
        content: { type: "string", description: "Note body as Markdown." },
      },
      ["action"],
    ),
    handler: noteWrite,
  },
  {
    name: "annotation_write",
    description:
      "Create, edit or remove annotations. 'highlightText' quotes text and " +
      "highlights the paragraph containing it; 'highlightRects' and 'areaRect' " +
      "take exact page rectangles in PDF user space. Update changes comment, " +
      "colour or tags; delete moves the annotation to the trash.",
    mutability: "write",
    inputSchema: OBJECT_SCHEMA(
      {
        action: {
          type: "string",
          enum: [
            "highlightText",
            "areaRect",
            "highlightEpub",
            "update",
            "delete",
          ],
        },
        attachmentKey: ITEM_KEY,
        annotationKey: ITEM_KEY,
        text: { type: "string", description: "Exact text to highlight." },
        page: { type: "number", description: "1-based page number." },
        rects: {
          type: "array",
          items: { type: "array", items: { type: "number" } },
          description: "PDF user-space rectangles [x1, y1, x2, y2].",
        },
        comment: { type: "string" },
        color: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      ["action"],
    ),
    handler: annotationWrite,
  },
  {
    name: "zotero_script",
    description:
      "Run JavaScript inside Zotero with the global Zotero object available, for " +
      "anything the other tools do not cover. Use mode 'read' to gather data and " +
      "'write' to change the library. Exceptions are returned with their stack.",
    mutability: "write",
    inputSchema: OBJECT_SCHEMA(
      {
        mode: { type: "string", enum: ["read", "write"] },
        script: { type: "string", description: "JavaScript source to run." },
        description: {
          type: "string",
          description: "What the script does; echoed back in the result.",
        },
        timeoutMs: {
          type: "number",
          description: "Default 30000, maximum 120000.",
        },
      },
      ["mode", "script"],
    ),
    handler: pending("zotero_script", "Phase 8"),
  },
];

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const spec of specs) registry.register(spec);
  return registry;
}
