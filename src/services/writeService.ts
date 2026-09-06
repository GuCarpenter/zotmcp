/**
 * Item mutation: metadata, tags, parenting and related links.
 *
 * Every write goes through `MutationService`, so operations never interleave, and
 * every write that Zotero can undo carries an undo label.
 */

import { InvalidArgumentError } from "../errors";
import type { ItemResolver } from "./itemResolver";
import type { MutationService } from "./mutationService";
import { stageUndo, UNDO_ACTIONS, undoLabel } from "./undo";
import type { ZoteroGateway } from "./zoteroGateway";

export type TagAction = "add" | "remove" | "set";
export type TagObjectAction = "rename" | "merge" | "delete" | "setColor";

export interface ChangeReport {
  itemKey: string;
  changed: string[];
}

export class WriteService {
  constructor(
    private readonly gateway: ZoteroGateway,
    private readonly resolver: ItemResolver,
    private readonly mutations: MutationService,
  ) {}

  /** Updates fields and creators, reporting each field that actually changed. */
  public async updateMetadata(
    itemKey: unknown,
    fields: Record<string, unknown>,
    creators?: unknown[],
  ): Promise<ChangeReport> {
    const item = await this.resolver.resolveItem(itemKey);

    if (!Object.keys(fields).length && !creators) {
      throw new InvalidArgumentError(
        "Nothing to update: provide fields or creators.",
      );
    }

    const valid = new Set(this.gateway.getFieldsForItemType(item.itemType));
    const changed: string[] = [];

    return this.mutations.enqueue("metadata", async () => {
      for (const [field, value] of Object.entries(fields)) {
        // Zotero 10 throws rather than corrupting when an item's type is changed
        // across the regular/attachment/note boundary, so that route is closed
        // here instead of failing deep inside Zotero.
        if (field === "itemType" || field === "itemTypeID") {
          throw new InvalidArgumentError(
            "Changing an item's type is not supported; create the correct type " +
              "and merge instead.",
          );
        }
        if (!valid.has(field)) {
          throw new InvalidArgumentError(
            `"${field}" is not a field of item type "${item.itemType}". ` +
              `Valid fields: ${[...valid].sort().join(", ")}.`,
          );
        }

        const next = value === null || value === undefined ? "" : String(value);
        if (String(item.getField(field as never) ?? "") === next) continue;
        item.setField(field as never, next);
        changed.push(field);
      }

      if (creators) {
        item.setCreators(creators as never);
        changed.push("creators");
      }

      if (changed.length) {
        await this.gateway.saveItem(item, undoLabel(UNDO_ACTIONS.editMetadata));
      }

      return { itemKey: item.key, changed };
    });
  }

  /** Tags on items. `set` replaces the whole list, which `add` never does. */
  public async updateTags(
    itemKeys: unknown,
    action: TagAction,
    tags: string[],
  ): Promise<ChangeReport[]> {
    const keys = requireKeys(itemKeys);
    if (!Array.isArray(tags) || (!tags.length && action !== "set")) {
      throw new InvalidArgumentError(
        `Action "${action}" requires a non-empty tags array.`,
      );
    }

    const items: Zotero.Item[] = [];
    for (const key of keys) items.push(await this.resolver.resolveItem(key));

    return this.mutations.enqueueTransaction("tags", async () => {
      stageUndo(this.gateway, UNDO_ACTIONS.editTags, items.length);
      const reports: ChangeReport[] = [];

      for (const item of items) {
        const before = item.getTags().map((tag) => tag.tag);
        const target = item as unknown as {
          addTag(tag: string): boolean;
          removeTag(tag: string): void;
          setTags(tags: { tag: string }[]): void;
        };

        if (action === "add") {
          for (const tag of tags) target.addTag(tag);
        } else if (action === "remove") {
          for (const tag of tags) target.removeTag(tag);
        } else {
          target.setTags(tags.map((tag) => ({ tag })));
        }

        const after = item.getTags().map((tag) => tag.tag);
        const changed =
          before.length !== after.length ||
          before.some((tag) => !after.includes(tag));

        if (changed) await this.gateway.saveItem(item);
        reports.push({
          itemKey: item.key,
          changed: changed ? ["tags"] : [],
        });
      }

      return reports;
    });
  }

  /** Tag operations across the whole library, not on one item. */
  public async updateTagObject(
    action: TagObjectAction,
    input: { tag?: string; newName?: string; color?: string | null },
  ): Promise<{ action: TagObjectAction; tag: string; result: string }> {
    const tag = (input.tag ?? "").trim();
    if (!tag) {
      throw new InvalidArgumentError('"tag" is required.');
    }
    const libraryID = this.gateway.userLibraryID;

    return this.mutations.enqueue(`tag ${action}`, async () => {
      switch (action) {
        case "rename":
        case "merge": {
          const newName = (input.newName ?? "").trim();
          if (!newName) {
            throw new InvalidArgumentError(
              `Action "${action}" requires "newName".`,
            );
          }
          // Zotero merges implicitly: renaming onto an existing tag folds the
          // two together, so rename and merge are the same call.
          await this.gateway.renameTag(libraryID, tag, newName);
          return { action, tag, result: `renamed to "${newName}"` };
        }
        case "delete":
          await this.gateway.deleteTag(libraryID, tag);
          return { action, tag, result: "removed from every item" };
        case "setColor": {
          const color = input.color ?? null;
          await this.gateway.setTagColor(libraryID, tag, color ?? false);
          return {
            action,
            tag,
            result: color ? `colour set to ${color}` : "colour cleared",
          };
        }
        default:
          throw new InvalidArgumentError(
            `Unknown tag action ${JSON.stringify(action)}.`,
          );
      }
    });
  }

  /** Reparents a note or attachment, or detaches it to top level. */
  public async setParent(
    itemKey: unknown,
    parentItemKey: unknown | null,
  ): Promise<ChangeReport> {
    const item = await this.resolver.resolveItem(itemKey);
    if (!item.isAttachment() && String(item.itemType) !== "note") {
      throw new InvalidArgumentError(
        `Only notes and attachments can be reparented; "${item.key}" is ` +
          `"${item.itemType}".`,
      );
    }

    const parent =
      parentItemKey === null || parentItemKey === undefined
        ? null
        : await this.resolver.resolveItem(parentItemKey);

    if (parent && !parent.isRegularItem()) {
      throw new InvalidArgumentError(
        `"${parent.key}" cannot be a parent (item type "${parent.itemType}").`,
      );
    }

    return this.mutations.enqueue("parent", async () => {
      (item as unknown as { parentID: number | false }).parentID = parent
        ? parent.id
        : false;
      await this.gateway.saveItem(item, undoLabel(UNDO_ACTIONS.setParent));
      return {
        itemKey: item.key,
        changed: [parent ? `parent -> ${parent.key}` : "detached"],
      };
    });
  }

  /**
   * Related links, written on both items inside one transaction.
   *
   * Zotero's Related is stored per item, so a link needs two saves. Doing them in
   * one transaction is what prevents a half-link — the failure mode both
   * comparable projects have, where the second save fails and one item keeps a
   * dangling relation.
   */
  public async updateRelated(
    itemKey: unknown,
    relatedItemKeys: unknown,
    action: "add" | "remove",
  ): Promise<{ itemKey: string; linked: string[]; skipped: string[] }> {
    const item = await this.resolver.resolveItem(itemKey);
    const keys = requireKeys(relatedItemKeys);

    const others: Zotero.Item[] = [];
    for (const key of keys) others.push(await this.resolver.resolveItem(key));

    return this.mutations.enqueueTransaction("related", async () => {
      stageUndo(this.gateway, UNDO_ACTIONS.editRelated, others.length);

      const linked: string[] = [];
      const skipped: string[] = [];

      for (const other of others) {
        if (other.key === item.key) {
          skipped.push(other.key);
          continue;
        }

        const a = item as unknown as {
          addRelatedItem(other: Zotero.Item): boolean;
          removeRelatedItem(other: Zotero.Item): boolean;
        };
        const b = other as unknown as {
          addRelatedItem(other: Zotero.Item): boolean;
          removeRelatedItem(other: Zotero.Item): boolean;
        };

        const forward =
          action === "add"
            ? a.addRelatedItem(other)
            : a.removeRelatedItem(other);
        const backward =
          action === "add" ? b.addRelatedItem(item) : b.removeRelatedItem(item);

        if (!forward && !backward) {
          skipped.push(other.key);
          continue;
        }

        // Both saves are inside this transaction: if the second throws, the
        // first is rolled back and no half-link survives.
        if (forward) await this.gateway.saveItem(item);
        if (backward) await this.gateway.saveItem(other);
        linked.push(other.key);
      }

      return { itemKey: item.key, linked, skipped };
    });
  }
}

export function requireKeys(value: unknown): string[] {
  const keys = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  const strings = keys.filter(
    (key): key is string => typeof key === "string" && key.trim() !== "",
  );
  if (!strings.length) {
    throw new InvalidArgumentError(
      "Provide at least one 8-character item key.",
    );
  }
  return strings;
}
