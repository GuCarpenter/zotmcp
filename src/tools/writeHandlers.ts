/**
 * Handlers for the write tools. Specs stay in `tools/index.ts`.
 */

import { InvalidArgumentError } from "../errors";
import { describeError } from "../errors";
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

export async function libraryImport(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const kind = str(args, "kind");

  switch (kind) {
    case "identifiers":
      return jsonResult(
        await ctx.imports.byIdentifiers(args.identifiers, args.collectionKey),
      );
    case "files":
      return jsonResult(
        await ctx.imports.fromFiles(
          args.filePaths,
          args.parentItemKey,
          args.linked === true,
        ),
      );
    case "manual":
      return jsonResult(
        await ctx.imports.manual(args.items, args.collectionKey),
      );
    default:
      throw new InvalidArgumentError(
        `Unknown kind ${JSON.stringify(kind)}: expected identifiers, files or manual.`,
      );
  }
}

/** One `library_update` operation, shared by the single and batch paths. */
async function runUpdate(args: Args, ctx: ToolContext): Promise<unknown> {
  const kind = str(args, "kind");

  switch (kind) {
    case "metadata":
      return ctx.writes.updateMetadata(
        args.itemKey ?? (args.itemKeys as string[] | undefined)?.[0],
        (args.fields ?? {}) as Record<string, unknown>,
        args.creators as unknown[] | undefined,
      );
    case "tags":
      return ctx.writes.updateTags(
        args.itemKeys ?? args.itemKey,
        (str(args, "action") ?? "add") as never,
        strArray(args, "tags") ?? [],
      );
    case "tag":
      return ctx.writes.updateTagObject((str(args, "action") ?? "") as never, {
        tag: str(args, "tag"),
        newName: str(args, "newName"),
        color: str(args, "color") ?? null,
      });
    case "parent":
      return ctx.writes.setParent(
        args.itemKey,
        args.parentItemKey === undefined ? null : args.parentItemKey,
      );
    case "related":
      return ctx.writes.updateRelated(
        args.itemKey,
        args.relatedItemKeys,
        (str(args, "action") ?? "add") as never,
      );
    default:
      throw new InvalidArgumentError(
        `Unknown kind ${JSON.stringify(kind)}: expected metadata, tags, tag, ` +
          `parent or related.`,
      );
  }
}

export async function libraryUpdate(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const operations = args.operations;

  if (operations !== undefined) {
    if (!Array.isArray(operations) || !operations.length) {
      throw new InvalidArgumentError(
        '"operations" must be a non-empty array of operations.',
      );
    }

    // Each operation reports its own outcome, so a mid-batch failure shows
    // exactly what applied and what did not.
    const results = [];
    for (const [index, operation] of operations.entries()) {
      try {
        results.push({
          index,
          ok: true,
          result: await runUpdate(operation as Args, ctx),
        });
      } catch (e) {
        results.push({ index, ok: false, error: describeError(e) });
      }
    }

    return jsonResult({
      operations: results.length,
      failed: results.filter((entry) => !entry.ok).length,
      results,
    });
  }

  return jsonResult(await runUpdate(args, ctx));
}

export async function collectionUpdate(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const action = str(args, "action");

  switch (action) {
    case "create":
      return jsonResult(
        await ctx.collections.create(args.name, args.parentCollectionKey),
      );
    case "rename":
      return jsonResult(
        await ctx.collections.rename(args.collectionKey, args.name),
      );
    case "move":
      return jsonResult(
        await ctx.collections.move(
          args.collectionKey,
          args.parentCollectionKey === undefined
            ? null
            : args.parentCollectionKey,
        ),
      );
    case "delete":
      return jsonResult(
        await ctx.collections.remove(
          args.collectionKey,
          args.deleteItems === true,
        ),
      );
    case "addItems":
    case "removeItems":
      return jsonResult(
        await ctx.collections.setMembership(
          args.collectionKey,
          args.itemKeys,
          action,
        ),
      );
    default:
      throw new InvalidArgumentError(
        `Unknown action ${JSON.stringify(action)}: expected create, rename, ` +
          `move, delete, addItems or removeItems.`,
      );
  }
}

export async function libraryDelete(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const mode = str(args, "mode");

  switch (mode) {
    case "trash":
      return jsonResult(await ctx.deletes.trash(args.itemKeys));
    case "restore":
      return jsonResult(await ctx.deletes.restore(args.itemKeys));
    case "merge":
      return jsonResult(
        await ctx.deletes.merge(args.masterItemKey, args.itemKeys),
      );
    default:
      throw new InvalidArgumentError(
        `Unknown mode ${JSON.stringify(mode)}: expected trash, restore or merge.`,
      );
  }
}

export async function attachmentUpdate(
  args: Args,
  ctx: ToolContext,
): Promise<ToolResult> {
  const action = str(args, "action");

  switch (action) {
    case "rename":
      return jsonResult(
        await ctx.attachments.rename(args.attachmentKey, args.newName),
      );
    case "relink":
      return jsonResult(
        await ctx.attachments.relink(args.attachmentKey, args.newPath),
      );
    case "delete":
      return jsonResult(await ctx.attachments.remove(args.attachmentKey));
    default:
      throw new InvalidArgumentError(
        `Unknown action ${JSON.stringify(action)}: expected rename, relink or delete.`,
      );
  }
}
