/**
 * Handlers for the three read tools. The specs (name, description, schema) stay
 * in `tools/index.ts`; the behaviour lives here.
 */

import { InvalidArgumentError } from "../errors";
import { ALL_SECTIONS, type ReadSection } from "../services/readService";
import {
  EPUB_CONTENT_TYPE,
  PDF_CONTENT_TYPE,
} from "../services/documentTextService";
import {
  buildCollectionSelectUri,
  buildOpenPdfUri,
  buildOpenUri,
} from "../services/uriService";
import {
  imageResult,
  jsonResult,
  type ToolContext,
  type ToolResult,
} from "./registry";

type Args = Record<string, unknown>;

function str(args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new InvalidArgumentError(
      `"${name}" must be a string, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function strArray(args: Args, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new InvalidArgumentError(`"${name}" must be an array of strings.`);
  }
  return value as string[];
}

export async function librarySearch(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const entity = str(args, "entity") ?? "items";

  if (entity === "collections") {
    const collections = ctx.gateway.getCollectionsByLibrary(
      ctx.gateway.userLibraryID,
      true,
    );
    const query = (str(args, "query") ?? "").toLowerCase();
    const matched = collections
      .filter((collection) =>
        query ? collection.name.toLowerCase().includes(query) : true,
      )
      .map((collection) => ({
        key: collection.key,
        name: collection.name,
        parentKey:
          typeof collection.parentKey === "string"
            ? collection.parentKey
            : undefined,
        uri: { select: buildCollectionSelectUri(collection.key) },
      }));
    return jsonResult({
      entity,
      total: matched.length,
      selectedKey: ctx.gateway.getSelectedCollectionKey(),
      collections: matched,
    });
  }

  if (entity === "tags") {
    const tags = await ctx.gateway.getAllTags(ctx.gateway.userLibraryID);
    const query = (str(args, "query") ?? "").toLowerCase();
    // Zotero stores a tag per type (manual and automatic), so the same name can
    // appear twice; a caller wants the vocabulary, not the storage rows.
    const matched = [...new Set(tags.map((tag) => tag.tag))]
      .filter((tag) => (query ? tag.toLowerCase().includes(query) : true))
      .sort((a, b) => a.localeCompare(b));
    return jsonResult({ entity, total: matched.length, tags: matched });
  }

  if (entity !== "items") {
    throw new InvalidArgumentError(
      `Unknown entity ${JSON.stringify(entity)}: expected items, collections or tags.`,
    );
  }

  const outcome = await ctx.search.run({
    mode: args.mode as never,
    query: str(args, "query"),
    conditions: args.conditions as never,
    joinMode: args.joinMode as never,
    itemType: str(args, "itemType"),
    collectionKey: str(args, "collectionKey"),
    deleted: args.deleted === true,
    limit: args.limit as never,
    offset: args.offset as never,
  });

  const items = await ctx.gateway.getItemsByID(outcome.itemIDs);
  const mode = str(args, "mode") ?? "keyword";
  const query = str(args, "query");

  const records = [];
  for (const item of items) {
    // An annotation has no title, creators or year, so the item summary would
    // only add "(untitled)" noise; its own text is the meaningful label.
    const isAnnotation = Boolean(item.isAnnotation?.());
    const record: Record<string, unknown> = isAnnotation
      ? { key: item.key, itemType: item.itemType }
      : { ...ctx.read.summarize(item) };

    // A full-text hit is useless without the matching text, and the annotation
    // mode returns annotations, whose own text is the point.
    if (mode === "fulltext" && query) {
      const attachments = await ctx.gateway.getItemsByID(item.getAttachments());
      for (const attachment of attachments) {
        const snippet = await ctx.search.snippetFor(attachment, query);
        if (snippet) {
          record.snippet = snippet;
          record.snippetFrom = attachment.key;
          // For an EPUB the hit can be turned into a CFI deep link that opens
          // the reader at the matched passage. Only when the query appears
          // verbatim and uniquely enough to point at one place.
          if (attachment.attachmentContentType === EPUB_CONTENT_TYPE) {
            const matches = await ctx.epubCfi.locate(attachment, query);
            if (matches.length) {
              record.cfiUri = buildOpenUri(attachment.key, {
                cfi: matches[0].pointCfi,
              });
            }
          } else if (attachment.attachmentContentType === PDF_CONTENT_TYPE) {
            // A PDF hit gets a page deep link to the page the text is on.
            const pageIndex = await ctx.documents.pageOfText(attachment, query);
            if (pageIndex !== null) {
              record.pageUri = buildOpenPdfUri(attachment.key, { pageIndex });
            }
          }
          break;
        }
      }
    } else if (isAnnotation) {
      const parent = item.parentItem;
      if (parent) {
        Object.assign(record, ctx.read.annotationRecord(item, parent));
      }
    }

    records.push(record);
  }

  return jsonResult({
    entity,
    mode,
    total: outcome.total,
    returned: records.length,
    limit: outcome.limit,
    offset: outcome.offset,
    ...(outcome.note ? { note: outcome.note } : {}),
    items: records,
  });
}

export async function libraryRead(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const item = await ctx.resolver.resolveItem(args.itemKey);
  const requested = strArray(args, "sections");

  const sections: ReadSection[] = requested?.length
    ? requested.map((section) => {
        if (!ALL_SECTIONS.includes(section as ReadSection)) {
          throw new InvalidArgumentError(
            `Unknown section ${JSON.stringify(section)}: expected one of ` +
              `${ALL_SECTIONS.join(", ")}.`,
          );
        }
        return section as ReadSection;
      })
    : ["metadata"];

  return jsonResult(await ctx.read.read(item, sections));
}

export async function paperRead(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const attachment = await ctx.resolver.resolveAttachment(args.attachmentKey);
  const mode = str(args, "mode") ?? "fulltext";
  const maxChars = ctx.documents.normalizeMaxChars(args.maxChars);

  switch (mode) {
    case "fulltext": {
      const result = await ctx.documents.fullText(attachment, maxChars);
      return jsonResult({ attachmentKey: attachment.key, mode, ...result });
    }
    case "pages": {
      const result = await ctx.documents.pages(
        attachment,
        args.pages,
        maxChars,
      );
      return jsonResult({ attachmentKey: attachment.key, mode, ...result });
    }
    case "sections": {
      const result = await ctx.documents.sections(attachment, {
        includeText: args.includeText !== false,
        maxChars,
        select: strArray(args, "select"),
        perSectionMaxChars:
          args.perSectionMaxChars === undefined
            ? undefined
            : ctx.documents.normalizeMaxChars(args.perSectionMaxChars),
      });
      return jsonResult({ attachmentKey: attachment.key, mode, ...result });
    }
    case "clean": {
      const result = await ctx.documents.clean(attachment, maxChars);
      return jsonResult({ attachmentKey: attachment.key, mode, ...result });
    }
    default:
      throw new InvalidArgumentError(
        `Unknown mode ${JSON.stringify(mode)}: expected fulltext, pages, sections or clean.`,
      );
  }
}

export async function noteWrite(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const action = str(args, "action") ?? "create";

  switch (action) {
    case "create":
      return jsonResult(
        await ctx.mutations.enqueue("note create", () =>
          ctx.notes.create(args.content, args.parentItemKey),
        ),
      );
    case "update":
      return jsonResult(
        await ctx.mutations.enqueue("note update", () =>
          ctx.notes.update(args.noteKey, args.content),
        ),
      );
    case "append":
      return jsonResult(
        await ctx.mutations.enqueue("note append", () =>
          ctx.notes.append(args.noteKey, args.content),
        ),
      );
    default:
      throw new InvalidArgumentError(
        `Unknown action ${JSON.stringify(action)}: expected create, update or append.`,
      );
  }
}

export async function annotationWrite(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const action = str(args, "action");
  if (!action) {
    throw new InvalidArgumentError(
      '"action" is required: highlightText, highlightRects, areaRect, ' +
        "areaFigure, update or delete.",
    );
  }

  if (action === "update") {
    return jsonResult(
      await ctx.mutations.enqueue("annotation update", () =>
        ctx.annotations.update(args.annotationKey, {
          comment: str(args, "comment"),
          color: str(args, "color"),
          tags: strArray(args, "tags"),
        }),
      ),
    );
  }

  if (action === "delete") {
    return jsonResult(
      await ctx.mutations.enqueue("annotation delete", () =>
        ctx.annotations.remove(args.annotationKey),
      ),
    );
  }

  const attachment = await ctx.resolver.resolveAttachment(args.attachmentKey);

  switch (action) {
    case "highlightText":
      return jsonResult(
        await ctx.mutations.enqueue("annotation highlight", () =>
          ctx.annotations.highlightText(attachment, {
            text: str(args, "text") ?? "",
            comment: str(args, "comment"),
            color: str(args, "color"),
            tags: strArray(args, "tags"),
          }),
        ),
      );
    case "highlightRects":
      return jsonResult(
        await ctx.mutations.enqueue("annotation highlight", () =>
          ctx.annotations.highlightRects(attachment, {
            page: Number(args.page),
            rects: args.rects as number[][],
            text: str(args, "text"),
            comment: str(args, "comment"),
            color: str(args, "color"),
            tags: strArray(args, "tags"),
          }),
        ),
      );
    case "areaRect":
      return jsonResult(
        await ctx.mutations.enqueue("annotation area", () =>
          ctx.annotations.area(attachment, {
            page: Number(args.page),
            rects: args.rects as number[][],
            comment: str(args, "comment"),
            color: str(args, "color"),
            tags: strArray(args, "tags"),
          }),
        ),
      );
    case "areaFigure":
      return jsonResult(
        await ctx.mutations.enqueue("annotation area", () =>
          ctx.annotations.areaFromFigure(attachment, {
            figure: str(args, "figure") ?? "",
            page: args.page === undefined ? undefined : Number(args.page),
            comment: str(args, "comment"),
            color: str(args, "color"),
            tags: strArray(args, "tags"),
          }),
        ),
      );
    default:
      throw new InvalidArgumentError(
        `Unknown action ${JSON.stringify(action)}: expected highlightText, ` +
          `highlightRects, areaRect, areaFigure, update or delete.`,
      );
  }
}

export async function readerRead(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const attachmentKey = str(args, "attachmentKey");
  const includeContext =
    args.includeContext === undefined
      ? undefined
      : Boolean(args.includeContext);
  const contextChars =
    args.contextChars === undefined ? undefined : Number(args.contextChars);

  const result = await ctx.reader.getOpenReader({
    attachmentKey,
    includeContext,
    contextChars,
  });

  return jsonResult(result);
}

export async function readerNavigate(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const result = await ctx.reader.navigate({
    attachmentKey: args.attachmentKey,
    page: args.page,
    pageLabel: args.pageLabel,
    annotationKey: args.annotationKey,
    cfi: args.cfi,
    openInBackground: args.openInBackground,
    openInWindow: args.openInWindow,
    includeContext:
      args.includeContext === undefined
        ? undefined
        : Boolean(args.includeContext),
    contextChars:
      args.contextChars === undefined ? undefined : Number(args.contextChars),
  });

  return jsonResult(result);
}

export async function imageRead(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const source = str(args, "source");
  if (!source) {
    throw new InvalidArgumentError(
      '"source" is required: annotation, attachment, page or reader.',
    );
  }

  const result = await ctx.images.read({
    source: source as never,
    attachmentKey: args.attachmentKey,
    annotationKey: args.annotationKey,
    page: args.page,
    rect: args.rect,
    figure: args.figure,
  });

  const { base64, mimeType, ...metadata } = result;
  return imageResult({ data: base64, mimeType }, { mimeType, ...metadata });
}
