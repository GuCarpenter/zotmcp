/**
 * Collections, imports, trash and attachments.
 */

import { FileMissingError, InvalidArgumentError } from "../errors";
import type { ItemResolver } from "./itemResolver";
import type { MutationService } from "./mutationService";
import { stageUndo, UNDO_ACTIONS, undoLabel } from "./undo";
import { buildCollectionSelectUri, buildItemUris } from "./uriService";
import { requireKeys } from "./writeService";
import type { ZoteroGateway } from "./zoteroGateway";

const NOT_UNDOABLE_CREATE =
  "Creating an item is not undoable in Zotero; trash it if unwanted.";

export class CollectionService {
  constructor(
    private readonly gateway: ZoteroGateway,
    private readonly resolver: ItemResolver,
    private readonly mutations: MutationService,
  ) {}

  public async create(
    name: unknown,
    parentCollectionKey?: unknown,
  ): Promise<Record<string, unknown>> {
    const collectionName = requireName(name);
    const parent =
      parentCollectionKey === undefined || parentCollectionKey === null
        ? null
        : await this.resolver.resolveCollection(parentCollectionKey);

    return this.mutations.enqueue("collection create", async () => {
      const created = await this.gateway.createCollection({
        name: collectionName,
        ...(parent ? { parentCollectionID: parent.id } : {}),
      });
      return {
        key: created.key,
        name: collectionName,
        ...(parent ? { parentKey: parent.key } : {}),
        uri: { select: buildCollectionSelectUri(created.key) },
        note: NOT_UNDOABLE_CREATE,
      };
    });
  }

  public async rename(
    collectionKey: unknown,
    name: unknown,
  ): Promise<Record<string, unknown>> {
    const collection = await this.resolver.resolveCollection(collectionKey);
    const newName = requireName(name);

    return this.mutations.enqueue("collection rename", async () => {
      const previous = collection.name;
      collection.name = newName;
      await this.gateway.saveCollection(
        collection,
        undoLabel(UNDO_ACTIONS.moveCollection),
      );
      return { key: collection.key, from: previous, to: newName };
    });
  }

  /** Moves a collection under a new parent, or to top level with null. */
  public async move(
    collectionKey: unknown,
    parentCollectionKey: unknown | null,
  ): Promise<Record<string, unknown>> {
    const collection = await this.resolver.resolveCollection(collectionKey);
    const parent =
      parentCollectionKey === null || parentCollectionKey === undefined
        ? null
        : await this.resolver.resolveCollection(parentCollectionKey);

    if (parent && parent.key === collection.key) {
      throw new InvalidArgumentError("A collection cannot be its own parent.");
    }

    return this.mutations.enqueue("collection move", async () => {
      (collection as unknown as { parentID: number | false }).parentID = parent
        ? parent.id
        : false;
      await this.gateway.saveCollection(
        collection,
        undoLabel(UNDO_ACTIONS.moveCollection),
      );
      return {
        key: collection.key,
        parentKey: parent ? parent.key : null,
      };
    });
  }

  /**
   * Deletes a collection. Items stay in the library unless `deleteItems` is set,
   * matching Zotero's own "Delete Collection" rather than quietly trashing work.
   */
  public async remove(
    collectionKey: unknown,
    deleteItems: boolean,
  ): Promise<Record<string, unknown>> {
    const collection = await this.resolver.resolveCollection(collectionKey);

    return this.mutations.enqueue("collection delete", async () => {
      const name = collection.name;
      await this.gateway.eraseCollection(collection, deleteItems);
      return {
        key: collection.key,
        name,
        deletedItems: deleteItems,
        note: deleteItems
          ? "The collection and its member items were moved to the trash, and " +
            "both can be restored. Zotero records this on its undo stack."
          : "The collection was moved to the trash and can be restored; its " +
            "member items were left in the library.",
      };
    });
  }

  public async setMembership(
    collectionKey: unknown,
    itemKeys: unknown,
    action: "addItems" | "removeItems",
  ): Promise<Record<string, unknown>> {
    const collection = await this.resolver.resolveCollection(collectionKey);
    const keys = requireKeys(itemKeys);

    const items: Zotero.Item[] = [];
    for (const key of keys) {
      const item = await this.resolver.resolveItem(key);
      if (!item.isRegularItem()) {
        throw new InvalidArgumentError(
          `Only regular items can be filed in a collection; "${item.key}" is ` +
            `"${item.itemType}".`,
        );
      }
      items.push(item);
    }

    return this.mutations.enqueueTransaction(
      "collection membership",
      async () => {
        stageUndo(this.gateway, UNDO_ACTIONS.editCollectionItems, items.length);

        const changed: string[] = [];
        for (const item of items) {
          const current = item.getCollections();
          const isMember = current.includes(collection.id);

          if (action === "addItems" && !isMember) {
            (
              item as unknown as { addToCollection(id: number): void }
            ).addToCollection(collection.id);
          } else if (action === "removeItems" && isMember) {
            (
              item as unknown as { removeFromCollection(id: number): void }
            ).removeFromCollection(collection.id);
          } else {
            continue;
          }

          await this.gateway.saveItem(item);
          changed.push(item.key);
        }

        return {
          collectionKey: collection.key,
          action,
          changed,
          unchanged: keys.filter((key) => !changed.includes(key)),
        };
      },
    );
  }
}

export class ImportService {
  constructor(
    private readonly gateway: ZoteroGateway,
    private readonly resolver: ItemResolver,
    private readonly mutations: MutationService,
  ) {}

  /**
   * Resolves the collection to file new items into. An explicit key wins; when
   * omitted, the collection currently open in Zotero is used, so an import
   * lands where the user is looking rather than loose in My Library.
   */
  private async resolveTargetCollection(
    collectionKey: unknown,
  ): Promise<Zotero.Collection | null> {
    if (collectionKey) {
      return this.resolver.resolveCollection(collectionKey);
    }
    const openKey = this.gateway.getSelectedCollectionKey();
    if (!openKey) return null;
    try {
      return await this.resolver.resolveCollection(openKey);
    } catch {
      // The open view may not be a collection (e.g. My Library root or a feed).
      return null;
    }
  }

  public async byIdentifiers(
    identifiers: unknown,
    collectionKey?: unknown,
  ): Promise<Record<string, unknown>> {
    const list = Array.isArray(identifiers) ? identifiers : [identifiers];
    const values = list.filter(
      (value): value is string =>
        typeof value === "string" && value.trim() !== "",
    );
    if (!values.length) {
      throw new InvalidArgumentError(
        "Provide at least one DOI, ISBN, arXiv ID, PMID or URL.",
      );
    }

    const collection = await this.resolveTargetCollection(collectionKey);

    return this.mutations.enqueue("import identifiers", async () => {
      const created: Record<string, unknown>[] = [];
      const failed: { identifier: string; reason: string }[] = [];

      for (const identifier of values) {
        try {
          const items = await this.gateway.importByIdentifier(
            identifier,
            collection ? [collection.id] : [],
          );
          for (const item of items) {
            created.push({
              key: item.key,
              itemType: item.itemType,
              title: String(item.getField("title" as never) ?? ""),
              uri: buildItemUris({ key: item.key, isAttachment: false }),
            });
          }
        } catch (e) {
          // One bad identifier must not discard the ones that worked.
          failed.push({
            identifier,
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      }

      return {
        created,
        ...(failed.length ? { failed } : {}),
        ...(collection ? { collectionKey: collection.key } : {}),
        note: NOT_UNDOABLE_CREATE,
      };
    });
  }

  /**
   * Saves a regular web page as a clean webpage item. The page is fetched,
   * Defuddle extracts the readable article, and a self-contained HTML snapshot
   * is stored — with images inlined as data URIs so it reads offline unless
   * `embedImages` is false. Use this for pages Zotero has no translator for;
   * `byIdentifiers` still handles DOIs, arXiv IDs and translator-backed URLs.
   */
  public async fromUrl(
    url: unknown,
    collectionKey?: unknown,
    embedImages = true,
  ): Promise<Record<string, unknown>> {
    const pageUrl = String(url ?? "").trim();
    if (!/^https?:\/\//i.test(pageUrl)) {
      throw new InvalidArgumentError(
        "Provide an absolute http(s) URL to import as a web page.",
      );
    }

    const collection = await this.resolveTargetCollection(collectionKey);

    return this.mutations.enqueue("import url", async () => {
      const html = await this.gateway.fetchText(pageUrl);
      const readable = await this.gateway.extractReadable(html, pageUrl);
      if (!readable.html) {
        throw new InvalidArgumentError(
          `No readable article could be extracted from "${pageUrl}".`,
        );
      }

      let content = readable.html;
      let embeddedImages = 0;
      if (embedImages) {
        const inlined = await embedImagesAsDataUris(
          content,
          pageUrl,
          this.gateway,
        );
        content = inlined.html;
        embeddedImages = inlined.count;
      }

      const title = readable.title || pageUrl;
      const fields: Record<string, unknown> = {
        ...(readable.description ? { abstractNote: readable.description } : {}),
        ...(readable.published ? { date: readable.published } : {}),
      };
      const creators = readable.author
        ? [{ creatorType: "author", lastName: readable.author, fieldMode: 1 }]
        : undefined;

      const { itemKey, attachmentKey } = await this.gateway.saveWebpageSnapshot(
        {
          url: pageUrl,
          title,
          snapshotContent: content,
          fields,
          creators,
          collectionIDs: collection ? [collection.id] : [],
        },
      );

      return {
        created: [
          {
            key: itemKey,
            itemType: "webpage",
            title,
            uri: buildItemUris({ key: itemKey, isAttachment: false }),
            snapshot: {
              key: attachmentKey,
              embeddedImages,
              uri: buildItemUris({
                key: attachmentKey,
                isAttachment: true,
                contentType: "text/html",
              }),
            },
          },
        ],
        ...(collection ? { collectionKey: collection.key } : {}),
        note: NOT_UNDOABLE_CREATE,
      };
    });
  }

  public async fromFiles(
    filePaths: unknown,
    parentItemKey: unknown,
    linked: boolean,
  ): Promise<Record<string, unknown>> {
    const paths = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(
      (value): value is string =>
        typeof value === "string" && value.trim() !== "",
    );
    if (!paths.length) {
      throw new InvalidArgumentError(
        "Provide at least one absolute file path.",
      );
    }

    const parent = await this.resolver.resolveItem(parentItemKey);
    if (!parent.isRegularItem()) {
      throw new InvalidArgumentError(
        `An attachment needs a regular item as its parent; "${parent.key}" is ` +
          `"${parent.itemType}".`,
      );
    }

    return this.mutations.enqueue("import files", async () => {
      const created: Record<string, unknown>[] = [];
      for (const path of paths) {
        // A Markdown file is rendered to a themed HTML snapshot rather than
        // attached verbatim, so it reads like the web captures do.
        if (isMarkdownPath(path)) {
          const attachment = await this.gateway.importMarkdownSnapshot({
            path,
            parentItemID: parent.id,
            title: fileBaseName(path),
          });
          created.push({
            key: attachment.key,
            contentType: attachment.attachmentContentType ?? "text/html",
            linkMode: "imported_url",
            renderedFrom: "markdown",
            uri: buildItemUris({
              key: attachment.key,
              isAttachment: true,
              contentType: attachment.attachmentContentType,
            }),
          });
          continue;
        }

        const attachment = await this.gateway.importFile({
          path,
          parentItemID: parent.id,
          linked,
        });
        created.push({
          key: attachment.key,
          contentType: attachment.attachmentContentType ?? null,
          linkMode: linked ? "linked_file" : "imported_file",
          uri: buildItemUris({
            key: attachment.key,
            isAttachment: true,
            contentType: attachment.attachmentContentType,
          }),
        });
      }
      return { parentKey: parent.key, created, note: NOT_UNDOABLE_CREATE };
    });
  }

  public async manual(
    items: unknown,
    collectionKey?: unknown,
  ): Promise<Record<string, unknown>> {
    if (!Array.isArray(items) || !items.length) {
      throw new InvalidArgumentError(
        'Provide an "items" array, each entry with an itemType and fields.',
      );
    }

    const collection = await this.resolveTargetCollection(collectionKey);

    return this.mutations.enqueue("import manual", async () => {
      const created: Record<string, unknown>[] = [];

      for (const entry of items as Record<string, unknown>[]) {
        const itemType = String(entry.itemType ?? "");
        if (!this.gateway.isValidItemType(itemType)) {
          throw new InvalidArgumentError(
            `"${itemType}" is not a Zotero item type.`,
          );
        }

        const fields = (entry.fields ?? {}) as Record<string, unknown>;
        const valid = new Set(this.gateway.getFieldsForItemType(itemType));
        for (const field of Object.keys(fields)) {
          if (!valid.has(field)) {
            throw new InvalidArgumentError(
              `"${field}" is not a field of item type "${itemType}". ` +
                `Valid fields: ${[...valid].sort().join(", ")}.`,
            );
          }
        }

        const item = await this.gateway.createItem({
          itemType,
          fields,
          creators: entry.creators as unknown[] | undefined,
          collectionIDs: collection ? [collection.id] : [],
        });

        created.push({
          key: item.key,
          itemType,
          uri: buildItemUris({ key: item.key, isAttachment: false }),
        });
      }

      return { created, note: NOT_UNDOABLE_CREATE };
    });
  }
}

export class DeleteService {
  constructor(
    private readonly gateway: ZoteroGateway,
    private readonly resolver: ItemResolver,
    private readonly mutations: MutationService,
  ) {}

  public async trash(itemKeys: unknown): Promise<Record<string, unknown>> {
    const items = await this.resolveAll(itemKeys);

    return this.mutations.enqueueTransaction("trash", async () => {
      stageUndo(this.gateway, UNDO_ACTIONS.trash, items.length);
      for (const item of items) await this.gateway.trashItem(item);
      return {
        trashed: items.map((item) => item.key),
        note: "Trashing is undoable in Zotero, and items can be restored.",
      };
    });
  }

  public async restore(itemKeys: unknown): Promise<Record<string, unknown>> {
    const items = await this.resolveAll(itemKeys);

    return this.mutations.enqueueTransaction("restore", async () => {
      stageUndo(this.gateway, UNDO_ACTIONS.restore, items.length);
      for (const item of items) {
        (item as unknown as { deleted: boolean }).deleted = false;
        await this.gateway.saveItem(item);
      }
      return { restored: items.map((item) => item.key) };
    });
  }

  public async merge(
    masterItemKey: unknown,
    itemKeys: unknown,
  ): Promise<Record<string, unknown>> {
    const master = await this.resolver.resolveItem(masterItemKey);
    const others = (await this.resolveAll(itemKeys)).filter(
      (item) => item.key !== master.key,
    );

    if (!others.length) {
      throw new InvalidArgumentError(
        "Provide at least one item to merge into the master, other than the " +
          "master itself.",
      );
    }
    if (others.some((item) => item.itemType !== master.itemType)) {
      throw new InvalidArgumentError(
        `All merged items must share the master's item type ` +
          `("${master.itemType}").`,
      );
    }

    return this.mutations.enqueue("merge", async () => {
      await this.gateway.mergeItems(master, others);
      return {
        masterKey: master.key,
        merged: others.map((item) => item.key),
        note:
          "The merged items were moved to the trash and recorded as replaced " +
          "items. Zotero stages this as one undo step, so Ctrl+Z reverses it.",
      };
    });
  }

  private async resolveAll(itemKeys: unknown): Promise<Zotero.Item[]> {
    const keys = requireKeys(itemKeys);
    const items: Zotero.Item[] = [];
    for (const key of keys) items.push(await this.resolver.resolveItem(key));
    return items;
  }
}

export class AttachmentService {
  constructor(
    private readonly gateway: ZoteroGateway,
    private readonly resolver: ItemResolver,
    private readonly mutations: MutationService,
  ) {}

  public async rename(
    attachmentKey: unknown,
    newName: unknown,
  ): Promise<Record<string, unknown>> {
    const attachment = await this.resolver.resolveAttachment(attachmentKey);
    const name = String(newName ?? "").trim();

    if (!name) {
      throw new InvalidArgumentError('"newName" is required.');
    }
    // Zotero 10 throws if a stored-file path contains a slash, so a path here is
    // rejected with the reason rather than surfacing as an opaque failure.
    if (name.includes("/") || name.includes("\\")) {
      throw new InvalidArgumentError(
        `"${name}" must be a bare filename, not a path.`,
      );
    }

    return this.mutations.enqueue("attachment rename", async () => {
      const previous = attachment.attachmentFilename;
      (
        attachment as unknown as { attachmentFilename: string }
      ).attachmentFilename = name;
      await this.gateway.saveItem(
        attachment,
        undoLabel(UNDO_ACTIONS.renameAttachment),
      );
      return { key: attachment.key, from: previous, to: name };
    });
  }

  public async relink(
    attachmentKey: unknown,
    newPath: unknown,
  ): Promise<Record<string, unknown>> {
    const attachment = await this.resolver.resolveAttachment(attachmentKey);
    const path = String(newPath ?? "").trim();
    if (!path) {
      throw new InvalidArgumentError('"newPath" is required.');
    }

    return this.mutations.enqueue("attachment relink", async () => {
      const previous = await this.gateway.getAttachmentPath(attachment);
      (attachment as unknown as { attachmentPath: string }).attachmentPath =
        path;
      await this.gateway.saveItem(
        attachment,
        undoLabel(UNDO_ACTIONS.relinkAttachment),
      );
      return { key: attachment.key, from: previous, to: path };
    });
  }

  public async remove(
    attachmentKey: unknown,
  ): Promise<Record<string, unknown>> {
    const attachment = await this.resolver.resolveAttachment(attachmentKey);

    return this.mutations.enqueue("attachment delete", async () => {
      await this.gateway.trashItem(attachment, undoLabel(UNDO_ACTIONS.trash));
      return {
        key: attachment.key,
        note: "Trashing is undoable in Zotero, and the attachment can be restored.",
      };
    });
  }

  /** Reports a missing file rather than pretending a path exists. */
  public async assertFilePresent(attachment: Zotero.Item): Promise<string> {
    const path = await this.gateway.getAttachmentPath(attachment);
    if (!path) throw new FileMissingError(attachment.key, null);
    return path;
  }
}

function requireName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name) {
    throw new InvalidArgumentError('"name" is required and cannot be blank.');
  }
  return name;
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd|mkdn)$/i.test(path);
}

/** The file name without its directory or extension, for a snapshot title. */
function fileBaseName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.[^.]+$/, "") || name;
}

/**
 * Inlines a clean article's images as data URIs so its snapshot reads offline.
 * Each distinct image is fetched once through the gateway; a fetch that fails
 * or is not an image leaves the original src untouched. Returns the rewritten
 * HTML and the number of images embedded.
 */
async function embedImagesAsDataUris(
  html: string,
  baseUrl: string,
  gateway: ZoteroGateway,
): Promise<{ html: string; count: number }> {
  const sources = new Set<string>();
  const srcAttr = /<img\b[^>]*?\bsrc="([^"]+)"[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = srcAttr.exec(html))) {
    const src = match[1];
    if (src && !src.startsWith("data:")) sources.add(src);
  }

  const replacements = new Map<string, string>();
  for (const src of sources) {
    const absolute = resolveUrl(src, baseUrl);
    if (!absolute) continue;
    const dataUri = await gateway.fetchDataUri(absolute);
    if (dataUri) replacements.set(src, dataUri);
  }

  let count = 0;
  const rewritten = html.replace(
    /(<img\b[^>]*?\bsrc=")([^"]+)(")/gi,
    (whole, prefix: string, src: string, suffix: string) => {
      const dataUri = replacements.get(src);
      if (!dataUri) return whole;
      count += 1;
      return `${prefix}${dataUri}${suffix}`;
    },
  );

  return { html: rewritten, count };
}

function resolveUrl(src: string, baseUrl: string): string | null {
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return null;
  }
}
