/**
 * Handlers for the three read tools. The specs (name, description, schema) stay
 * in `tools/index.ts`; the behaviour lives here.
 */

import { InvalidArgumentError } from "../errors";
import { ALL_SECTIONS, type ReadSection } from "../services/readService";
import { buildCollectionSelectUri } from "../services/uriService";
import { jsonResult, type ToolContext, type ToolResult } from "./registry";

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
    return jsonResult({ entity, total: matched.length, collections: matched });
  }

  if (entity === "tags") {
    const tags = await ctx.gateway.getAllTags(ctx.gateway.userLibraryID);
    const query = (str(args, "query") ?? "").toLowerCase();
    const matched = tags
      .map((tag) => tag.tag)
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
    const record: Record<string, unknown> = {
      ...ctx.read.summarize(item),
    };

    // A full-text hit is useless without the matching text, and the annotation
    // mode returns annotations, whose own text is the point.
    if (mode === "fulltext" && query) {
      const attachments = await ctx.gateway.getItemsByID(item.getAttachments());
      for (const attachment of attachments) {
        const snippet = await ctx.search.snippetFor(attachment, query);
        if (snippet) {
          record.snippet = snippet;
          record.snippetFrom = attachment.key;
          break;
        }
      }
    } else if (mode === "annotation" && item.isAnnotation?.()) {
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
      });
      return jsonResult({ attachmentKey: attachment.key, mode, ...result });
    }
    default:
      throw new InvalidArgumentError(
        `Unknown mode ${JSON.stringify(mode)}: expected fulltext, pages or sections.`,
      );
  }
}
