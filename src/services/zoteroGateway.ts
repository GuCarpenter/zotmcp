/**
 * The single seam between this plugin and Zotero.
 *
 * Every other module takes a `ZoteroGateway` rather than reaching for the global
 * `Zotero` object, which keeps the whole codebase unit-testable in plain Node
 * against a fake. Nothing outside this file may reference `Zotero` directly.
 */

import { config } from "../../package.json";

/** Zotero's default connector-server port. */
export const DEFAULT_HTTP_PORT = 23119;

export interface ZoteroGateway {
  /** My Library's numeric ID. All operations are scoped to it (spec LB-1). */
  readonly userLibraryID: number;

  /** Zotero application version, e.g. "8.0.3". */
  readonly version: string;

  /** Gecko major version: 115 (Zotero 7.0), 128 (7.1 beta), 140 (Zotero 8). */
  readonly platformMajorVersion: number;

  getItemByKey(libraryID: number, key: string): Promise<Zotero.Item | false>;
  getItemByID(itemID: number): Zotero.Item | false;
  getItemsByID(itemIDs: number[]): Promise<Zotero.Item[]>;
  getCollectionByKey(
    libraryID: number,
    key: string,
  ): Promise<Zotero.Collection | false>;
  getCollectionsByLibrary(
    libraryID: number,
    recursive: boolean,
  ): Zotero.Collection[];
  getAllTags(libraryID: number): Promise<{ tag: string; type: number }[]>;

  /** A fresh `Zotero.Search` already scoped to the given library. */
  createSearch(libraryID: number): SearchHandle;

  /** True when a term can be answered by Zotero's full-text index. */
  canSearchFullText(text: string): boolean;

  /**
   * Path of an attachment's cached extracted text, used to cut a snippet around
   * a full-text hit. Null when nothing is cached.
   */
  fulltextCachePath(item: Zotero.Item): string | null;

  /** Absolute path of an attachment's file, or null when missing/unlinked. */
  getAttachmentPath(item: Zotero.Item): Promise<string | null>;

  /** A fresh 8-character Zotero object key. */
  generateObjectKey(): string;

  /**
   * Creates or updates an annotation from Zotero's own annotation JSON. Save
   * options are forwarded, so an undo label reaches `saveTx`.
   */
  saveAnnotation(
    attachment: Zotero.Item,
    json: Record<string, unknown>,
    saveOptions?: Record<string, unknown>,
  ): Promise<Zotero.Item>;

  /**
   * Runs caller-supplied JavaScript with the privileged `Zotero` global and an
   * `env` helper bag. Privileged by nature, so it lives on the gateway with the
   * rest of the Zotero surface rather than leaking the global elsewhere.
   */
  runScript(source: string, env: Record<string, unknown>): Promise<unknown>;

  /** Resolves identifiers (DOI, ISBN, arXiv, PMID) into new items. */
  importByIdentifier(
    identifier: string,
    collectionIDs: number[],
  ): Promise<Zotero.Item[]>;

  /** Attaches a local file to a parent item, imported or linked. */
  importFile(input: {
    path: string;
    parentItemID: number;
    linked: boolean;
    title?: string;
  }): Promise<Zotero.Item>;

  /** Creates a regular item from validated fields and creators. */
  createItem(input: {
    itemType: string;
    fields: Record<string, unknown>;
    creators?: unknown[];
    collectionIDs?: number[];
  }): Promise<Zotero.Item>;

  /** Valid field names for an item type, for validation and error messages. */
  getFieldsForItemType(itemType: string): string[];
  isValidItemType(itemType: string): boolean;

  /** Library-wide tag operations. */
  renameTag(libraryID: number, from: string, to: string): Promise<void>;
  deleteTag(libraryID: number, tag: string): Promise<void>;
  setTagColor(
    libraryID: number,
    tag: string,
    color: string | false,
  ): Promise<void>;

  createCollection(input: {
    name: string;
    parentCollectionID?: number;
  }): Promise<Zotero.Collection>;
  saveCollection(
    collection: Zotero.Collection,
    saveOptions?: Record<string, unknown>,
  ): Promise<void>;
  eraseCollection(
    collection: Zotero.Collection,
    deleteItems: boolean,
  ): Promise<void>;

  /**
   * Merges duplicates. Zotero 10 deprecated `Zotero.Items.merge()` in favour of
   * `mergeItems.mjs`, which wraps itself in a transaction and stages
   * `undo-action-merge-items`, so a merge is reversible with Ctrl+Z.
   */
  mergeItems(master: Zotero.Item, others: Zotero.Item[]): Promise<void>;

  /** Creates a note item, attached to `parent` when given. */
  createNote(html: string, parent: Zotero.Item | null): Promise<Zotero.Item>;

  /**
   * Saves an already-modified item, choosing `save()` inside an open transaction
   * and `saveTx()` outside one. Calling `saveTx()` within a transaction waits on
   * a transaction that cannot commit until the caller returns, so the write
   * deadlocks until the queue deadline fires.
   */
  saveItem(
    item: Zotero.Item,
    saveOptions?: Record<string, unknown>,
  ): Promise<void>;

  /** True while a Zotero DB transaction is open on this thread. */
  inTransaction(): boolean;

  /** Moves an item to the trash, which Zotero can undo. */
  trashItem(
    item: Zotero.Item,
    saveOptions?: Record<string, unknown>,
  ): Promise<void>;
  readTextFile(path: string, maxLength?: number): Promise<string>;

  /**
   * Zotero 10's Structured Document Text pack for a PDF, EPUB or snapshot
   * attachment: typed blocks, a page catalogue and an outline, cached on disk and
   * invalidated by source hash. Null when unavailable for this attachment.
   */
  getSdtReader(itemID: number): Promise<SdtReader | null>;

  /** Raw PDF text extraction, the fallback when no SDT pack can be built. */
  getPdfFullText(
    itemID: number,
    maxPages?: number,
  ): Promise<{ text?: string; pageChars?: number[] } | null>;

  /**
   * Runs `fn` inside a Zotero DB transaction. Multi-save operations rely on this
   * for atomicity — notably bidirectional related-item links, where a failure on
   * the second side must roll back the first (spec W-9).
   */
  executeTransaction<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Labels the current transaction so its saves land on Zotero's native undo
   * stack as a single step. Only meaningful inside `executeTransaction`.
   */
  stageUndoAction(action: string, args?: Record<string, unknown>): void;

  /** Registers/removes the plugin's FTL, which supplies undo menu labels. */
  registerLocalization(files: string[]): void;
  unregisterLocalization(files: string[]): void;

  /** Reads a Zotero-scoped preference, e.g. `httpServer.port`. */
  getZoteroPref(key: string): unknown;

  /** Reads a plugin preference, without the `extensions.zotero.zotmcp.` prefix. */
  getPref(key: string): unknown;
  setPref(key: string, value: unknown): void;

  /** True when Zotero's own HTTP server is running (spec S-3). */
  isHttpServerEnabled(): boolean;
  httpServerPort(): number;

  hasEndpoint(path: string): boolean;
  registerEndpoint(path: string, endpoint: EndpointConstructor): void;
  unregisterEndpoint(path: string): void;

  /** Best-effort user-visible message; never throws if no window exists. */
  showPopup(title: string, body: string, isError: boolean): void;

  log(...args: unknown[]): void;
}

export type EndpointConstructor = new () => ZotmcpServer.Endpoint;

/**
 * Minimal view of `Zotero.Search`. Conditions are added one at a time, and the
 * search runs to item IDs.
 *
 * `addCondition` mirrors Zotero's own signature, minus the legacy `required`
 * argument, which Zotero 10 throws on.
 */
export interface SearchHandle {
  addCondition(condition: string, operator: string, value?: string): void;
  search(): Promise<number[]>;
}

/** A node in an SDT pack: either a text leaf or a block with children. */
export interface SdtNode {
  type?: string;
  text?: string;
  content?: SdtNode[];
  /**
   * Zotero anchors a block with `pageRects`, each entry being
   * `[pageIndex, x1, y1, x2, y2]` — there is no bare `pageIndex` field, though
   * one is tolerated in case a future producer emits it.
   */
  anchor?: {
    pageRects?: number[][];
    pageIndex?: number;
  };
}

export interface SdtOutlineItem {
  title?: string;
  /** Path to the block the entry points at; the first element is block index. */
  ref?: number[];
  target?: { position?: { pageIndex?: number } };
  items?: SdtOutlineItem[];
  children?: SdtOutlineItem[];
}

export interface SdtCatalog {
  pages?: { label?: string; contentRange?: unknown }[];
  outline?: SdtOutlineItem[];
  pageMappingType?: string;
}

/** Subset of Zotero's SDT pack reader that this plugin relies on. */
export interface SdtReader {
  getMetadata(): Promise<Record<string, unknown>>;
  getCatalog(): Promise<SdtCatalog>;
  getTopLevelBlockCount(): number;
  getBlocks(startBlock: number, endBlock: number): Promise<SdtNode[]>;
  getPageBlocks(pageIndex: number): Promise<SdtNode[]>;
}

export class RealZoteroGateway implements ZoteroGateway {
  public get userLibraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  public get version(): string {
    return String(Zotero.version ?? "");
  }

  public get platformMajorVersion(): number {
    return Number(Zotero.platformMajorVersion ?? 0);
  }

  public async getItemByKey(
    libraryID: number,
    key: string,
  ): Promise<Zotero.Item | false> {
    return Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
  }

  public getItemByID(itemID: number): Zotero.Item | false {
    return Zotero.Items.get(itemID);
  }

  public async getItemsByID(itemIDs: number[]): Promise<Zotero.Item[]> {
    if (!itemIDs.length) return [];
    return Zotero.Items.getAsync(itemIDs);
  }

  public getCollectionsByLibrary(
    libraryID: number,
    recursive: boolean,
  ): Zotero.Collection[] {
    return Zotero.Collections.getByLibrary(libraryID, recursive);
  }

  public async getAllTags(
    libraryID: number,
  ): Promise<{ tag: string; type: number }[]> {
    return Zotero.Tags.getAll(libraryID) as Promise<
      { tag: string; type: number }[]
    >;
  }

  public createSearch(libraryID: number): SearchHandle {
    const search = new Zotero.Search();
    // zotero-types marks libraryID readonly, but Zotero.Search defines a setter
    // (search.js: defineProperty with get/set) and scoping a search is the
    // documented way to bound it to a library.
    (search as unknown as { libraryID: number }).libraryID = libraryID;
    return {
      addCondition: (condition, operator, value) =>
        search.addCondition(condition as never, operator as never, value),
      search: () => search.search() as unknown as Promise<number[]>,
    };
  }

  public canSearchFullText(text: string): boolean {
    try {
      return Boolean(
        (
          Zotero as unknown as {
            FullText?: { canSearchContent(text: string): boolean };
          }
        ).FullText?.canSearchContent(text),
      );
    } catch {
      // An unavailable index is not a failure: the caller falls back to
      // reporting no snippet rather than no result.
      return false;
    }
  }

  public fulltextCachePath(item: Zotero.Item): string | null {
    try {
      const file = (
        Zotero as unknown as {
          FullText?: { getItemCacheFile(item: Zotero.Item): { path: string } };
        }
      ).FullText?.getItemCacheFile(item);
      return file?.path ?? null;
    } catch {
      return null;
    }
  }

  public async getAttachmentPath(item: Zotero.Item): Promise<string | null> {
    try {
      const path = await item.getFilePathAsync();
      return path === false ? null : path;
    } catch {
      // A linked file whose target moved is a normal state, not a failure.
      return null;
    }
  }

  public generateObjectKey(): string {
    return (
      Zotero as unknown as {
        DataObjectUtilities: { generateKey(): string };
      }
    ).DataObjectUtilities.generateKey();
  }

  public async saveAnnotation(
    attachment: Zotero.Item,
    json: Record<string, unknown>,
    saveOptions: Record<string, unknown> = {},
  ): Promise<Zotero.Item> {
    return (
      Zotero as unknown as {
        Annotations: {
          saveFromJSON(
            attachment: Zotero.Item,
            json: Record<string, unknown>,
            saveOptions?: Record<string, unknown>,
          ): Promise<Zotero.Item>;
        };
      }
    ).Annotations.saveFromJSON(attachment, json, saveOptions);
  }

  public async runScript(
    source: string,
    env: Record<string, unknown>,
  ): Promise<unknown> {
    // An async function body, so a script may await without wrapping itself.
    const AsyncFunction = Object.getPrototypeOf(async function () {})
      .constructor as new (
      ...args: string[]
    ) => (zotero: unknown, env: Record<string, unknown>) => Promise<unknown>;

    const fn = new AsyncFunction("Zotero", "env", source);
    return fn(Zotero, env);
  }

  public async importByIdentifier(
    identifier: string,
    collectionIDs: number[],
  ): Promise<Zotero.Item[]> {
    const zoteroAny = Zotero as unknown as {
      Utilities: {
        Internal: {
          extractIdentifiers(text: string): Record<string, string>[];
        };
      };
      Translate: { Search: new () => any };
    };

    const parsed = zoteroAny.Utilities.Internal.extractIdentifiers(identifier);
    if (!parsed.length) {
      throw new Error(
        `"${identifier}" is not a recognizable DOI, ISBN, arXiv ID, PMID or URL.`,
      );
    }

    const translate = new zoteroAny.Translate.Search();
    translate.setIdentifier(parsed[0]);
    const translators = await translate.getTranslators();
    if (!translators?.length) {
      throw new Error(`No translator could resolve "${identifier}".`);
    }
    translate.setTranslator(translators);

    return (await translate.translate({
      libraryID: this.userLibraryID,
      collections: collectionIDs,
    })) as Zotero.Item[];
  }

  public async importFile(input: {
    path: string;
    parentItemID: number;
    linked: boolean;
    title?: string;
  }): Promise<Zotero.Item> {
    const attachments = Zotero.Attachments as unknown as {
      importFromFile(options: Record<string, unknown>): Promise<Zotero.Item>;
      linkFromFile(options: Record<string, unknown>): Promise<Zotero.Item>;
    };
    const options = {
      file: input.path,
      parentItemID: input.parentItemID,
      ...(input.title ? { title: input.title } : {}),
    };
    return input.linked
      ? attachments.linkFromFile(options)
      : attachments.importFromFile(options);
  }

  public async createItem(input: {
    itemType: string;
    fields: Record<string, unknown>;
    creators?: unknown[];
    collectionIDs?: number[];
  }): Promise<Zotero.Item> {
    const item = new Zotero.Item(input.itemType as never);
    item.libraryID = this.userLibraryID;
    for (const [field, value] of Object.entries(input.fields)) {
      if (value === undefined || value === null || value === "") continue;
      item.setField(field as never, String(value));
    }
    if (input.creators?.length) {
      item.setCreators(input.creators as never);
    }
    if (input.collectionIDs?.length) {
      item.setCollections(input.collectionIDs as never);
    }
    await item.saveTx();
    return item;
  }

  public getFieldsForItemType(itemType: string): string[] {
    const types = Zotero.ItemTypes as unknown as {
      getID(name: string): number | false;
    };
    const fields = Zotero.ItemFields as unknown as {
      getItemTypeFields(itemTypeID: number): number[];
      getName(fieldID: number): string;
    };
    const typeID = types.getID(itemType);
    if (typeID === false) return [];
    return fields
      .getItemTypeFields(typeID)
      .map((fieldID) => fields.getName(fieldID));
  }

  public isValidItemType(itemType: string): boolean {
    const types = Zotero.ItemTypes as unknown as {
      getID(name: string): number | false;
    };
    return types.getID(itemType) !== false;
  }

  public async renameTag(
    libraryID: number,
    from: string,
    to: string,
  ): Promise<void> {
    await (
      Zotero.Tags as unknown as {
        rename(libraryID: number, from: string, to: string): Promise<void>;
      }
    ).rename(libraryID, from, to);
  }

  public async deleteTag(libraryID: number, tag: string): Promise<void> {
    const tags = Zotero.Tags as unknown as {
      getID(tag: string): number | false;
      removeFromLibrary(libraryID: number, tagIDs: number[]): Promise<void>;
    };
    const tagID = tags.getID(tag);
    if (tagID === false) {
      throw new Error(`No tag named "${tag}" exists in the library.`);
    }
    await tags.removeFromLibrary(libraryID, [tagID]);
  }

  public async setTagColor(
    libraryID: number,
    tag: string,
    color: string | false,
  ): Promise<void> {
    await (
      Zotero.Tags as unknown as {
        setColor(
          libraryID: number,
          tag: string,
          color: string | false,
        ): Promise<void>;
      }
    ).setColor(libraryID, tag, color);
  }

  public async createCollection(input: {
    name: string;
    parentCollectionID?: number;
  }): Promise<Zotero.Collection> {
    const collection = new Zotero.Collection();
    (collection as unknown as { libraryID: number }).libraryID =
      this.userLibraryID;
    collection.name = input.name;
    if (input.parentCollectionID !== undefined) {
      (collection as unknown as { parentID: number }).parentID =
        input.parentCollectionID;
    }
    await collection.saveTx();
    return collection;
  }

  public async saveCollection(
    collection: Zotero.Collection,
    saveOptions: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.inTransaction()) {
      await (collection as unknown as { save(): Promise<unknown> }).save();
      return;
    }
    await collection.saveTx(saveOptions as never);
  }

  public async eraseCollection(
    collection: Zotero.Collection,
    deleteItems: boolean,
  ): Promise<void> {
    await (
      collection as unknown as {
        eraseTx(options: Record<string, unknown>): Promise<void>;
      }
    ).eraseTx({ deleteItems });
  }

  public async mergeItems(
    master: Zotero.Item,
    others: Zotero.Item[],
  ): Promise<void> {
    const chromeUtils = ChromeUtils as unknown as {
      importESModule(url: string): {
        mergeItems(master: Zotero.Item, others: Zotero.Item[]): Promise<void>;
      };
    };

    try {
      const { mergeItems } = chromeUtils.importESModule(
        "chrome://zotero/content/mergeItems.mjs",
      );
      await mergeItems(master, others);
      return;
    } catch (e) {
      // Older builds may not ship the module; the deprecated entry point does
      // the same work and logs a deprecation warning.
      this.log("WARN mergeItems.mjs unavailable, using Zotero.Items.merge", e);
    }

    await (
      Zotero.Items as unknown as {
        merge(master: Zotero.Item, others: Zotero.Item[]): Promise<void>;
      }
    ).merge(master, others);
  }

  public async createNote(
    html: string,
    parent: Zotero.Item | null,
  ): Promise<Zotero.Item> {
    const note = new Zotero.Item("note");
    note.libraryID = this.userLibraryID;
    if (parent) note.parentID = parent.id;
    note.setNote(html);
    await note.saveTx();
    return note;
  }

  public inTransaction(): boolean {
    return Boolean(
      (Zotero.DB as unknown as { inTransaction(): boolean }).inTransaction(),
    );
  }

  public async saveItem(
    item: Zotero.Item,
    saveOptions: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.inTransaction()) {
      // The enclosing transaction's staged undo action carries the label, so no
      // per-save undo option is needed — and `saveTx` here would deadlock.
      await (item as unknown as { save(): Promise<unknown> }).save();
      return;
    }
    await item.saveTx(saveOptions as never);
  }

  public async trashItem(
    item: Zotero.Item,
    saveOptions: Record<string, unknown> = {},
  ): Promise<void> {
    // Trashing only flips the deleted flag, which is why Zotero can undo it.
    (item as unknown as { deleted: boolean }).deleted = true;
    await this.saveItem(item, saveOptions);
  }

  public async readTextFile(path: string, maxLength?: number): Promise<string> {
    return Zotero.File.getContentsAsync(
      path,
      "utf-8",
      maxLength,
    ) as Promise<string>;
  }

  public async getSdtReader(itemID: number): Promise<SdtReader | null> {
    try {
      const sdt = (
        Zotero as unknown as {
          SDT?: {
            getReader(
              itemID: number,
              options?: Record<string, unknown>,
            ): Promise<SdtReader | null>;
          };
        }
      ).SDT;
      if (!sdt) return null;
      // Always a user-initiated read, so it should not queue behind background
      // indexing work.
      return await sdt.getReader(itemID, { isPriority: true });
    } catch (e) {
      this.log("WARN SDT reader unavailable", itemID, e);
      return null;
    }
  }

  public async getPdfFullText(
    itemID: number,
    maxPages?: number,
  ): Promise<{ text?: string; pageChars?: number[] } | null> {
    try {
      const worker = (
        Zotero as unknown as {
          PDFWorker?: {
            getFullText(
              itemID: number,
              maxPages?: number | null,
              isPriority?: boolean,
            ): Promise<{ text?: string; pageChars?: number[] }>;
          };
        }
      ).PDFWorker;
      if (!worker) return null;
      return await worker.getFullText(itemID, maxPages ?? null, true);
    } catch (e) {
      this.log("WARN PDF text extraction failed", itemID, e);
      return null;
    }
  }

  public async getCollectionByKey(
    libraryID: number,
    key: string,
  ): Promise<Zotero.Collection | false> {
    return Zotero.Collections.getByLibraryAndKeyAsync(libraryID, key);
  }

  public async executeTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return Zotero.DB.executeTransaction(fn);
  }

  public stageUndoAction(action: string, args?: Record<string, unknown>): void {
    try {
      (
        Zotero as unknown as {
          UndoHistory?: {
            stageAction(action: string, args?: Record<string, unknown>): void;
          };
        }
      ).UndoHistory?.stageAction(action, args);
    } catch (e) {
      // A missing undo label costs the user a Ctrl+Z, not their data, so it must
      // never fail the write itself.
      this.log("WARN could not stage an undo action", action, e);
    }
  }

  public registerLocalization(files: string[]): void {
    try {
      (
        Zotero as unknown as {
          ftl?: { addResourceIds(files: string[]): void };
        }
      ).ftl?.addResourceIds(files);
    } catch (e) {
      this.log("WARN could not register localization", files, e);
    }
  }

  public unregisterLocalization(files: string[]): void {
    try {
      (
        Zotero as unknown as {
          ftl?: { removeResourceIds(files: string[]): void };
        }
      ).ftl?.removeResourceIds(files);
    } catch (e) {
      this.log("WARN could not unregister localization", files, e);
    }
  }

  public getZoteroPref(key: string): unknown {
    return Zotero.Prefs.get(key);
  }

  public getPref(key: string): unknown {
    return Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true);
  }

  public setPref(key: string, value: unknown): void {
    Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, value as never, true);
  }

  public isHttpServerEnabled(): boolean {
    // Zotero.Server is absent entirely when the connector server is off, so the
    // object check matters as much as the preference.
    return Boolean(Zotero.Server?.Endpoints) && this.readServerPref();
  }

  public httpServerPort(): number {
    const port = Number(Zotero.Prefs.get("httpServer.port"));
    return Number.isFinite(port) && port > 0 ? port : DEFAULT_HTTP_PORT;
  }

  public hasEndpoint(path: string): boolean {
    return Boolean(Zotero.Server?.Endpoints?.[path]);
  }

  public registerEndpoint(path: string, endpoint: EndpointConstructor): void {
    Zotero.Server.Endpoints[path] = endpoint as never;
  }

  public unregisterEndpoint(path: string): void {
    delete Zotero.Server?.Endpoints?.[path];
  }

  public showPopup(title: string, body: string, isError: boolean): void {
    try {
      const popup = new ztoolkit.ProgressWindow(title, {
        closeOtherProgressWindows: false,
      });
      popup
        .createLine({ text: body, type: isError ? "fail" : "default" })
        .show(isError ? -1 : 5000);
    } catch {
      // No window yet (or headless test run). The log line below is the record.
    }
  }

  public log(...args: unknown[]): void {
    ztoolkit.log(...args);
  }

  private readServerPref(): boolean {
    const value = Zotero.Prefs.get("httpServer.enabled");
    // Zotero ships the connector server enabled and the pref may be unset.
    return value === undefined ? true : Boolean(value);
  }
}
