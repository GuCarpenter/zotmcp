/**
 * In-memory ZoteroGateway for unit tests. Lets every service be exercised in
 * plain Node with no Zotero process.
 */

import type {
  EndpointConstructor,
  SdtReader,
  SearchHandle,
  ZoteroGateway,
} from "../../src/services/zoteroGateway";

export const USER_LIBRARY_ID = 1;
export const GROUP_LIBRARY_ID = 7;

export interface RecordedCondition {
  condition: string;
  operator: string;
  value?: string;
}

export interface FakeItem {
  key: string;
  id: number;
  libraryID: number;
  itemType: string;
  attachmentContentType?: string | null;
  attachmentIDs?: number[];
  noteIDs?: number[];
  json?: Record<string, unknown>;
  note?: string;
  parentKey?: string;
  tags?: string[];
  collectionIDs?: number[];
  related?: string[];
}

export interface FakeCollection {
  key: string;
  id: number;
  libraryID: number;
  name: string;
}

export class FakeGateway implements ZoteroGateway {
  public readonly userLibraryID = USER_LIBRARY_ID;
  public readonly version = "8.0.0";
  public readonly platformMajorVersion = 140;

  public items: FakeItem[] = [];
  public collections: FakeCollection[] = [];
  public prefs = new Map<string, unknown>();
  public zoteroPrefs = new Map<string, unknown>();
  public endpoints = new Map<string, EndpointConstructor>();
  public popups: { title: string; body: string; isError: boolean }[] = [];
  public logs: unknown[][] = [];
  public transactionCount = 0;
  public stagedUndoActions: {
    action: string;
    args?: Record<string, unknown>;
  }[] = [];
  public registeredLocalizations: string[] = [];
  public httpServerEnabled = true;
  public port = 23119;
  public tags: { tag: string; type: number }[] = [];
  /** One entry per createSearch() call, holding the conditions it received. */
  public searches: RecordedCondition[][] = [];
  public searchResults: number[] = [];
  /** Condition names createSearch() should reject, mimicking Zotero. */
  public rejectConditions = new Set<string>();
  public fullTextSearchable = true;
  public cachePath: string | null = "/tmp/zotero-ft-cache";
  public attachmentPath: string | null = "/tmp/paper.pdf";
  public keyCounter = 0;
  public savedAnnotations: {
    attachmentKey: string;
    json: Record<string, unknown>;
    saveOptions: Record<string, unknown>;
  }[] = [];
  public savedItems: { key: string; saveOptions: Record<string, unknown> }[] =
    [];
  public trashedItems: { key: string; saveOptions: Record<string, unknown> }[] =
    [];
  public createdNotes: {
    key: string;
    html: string;
    parentKey: string | null;
  }[] = [];
  public importedIdentifiers: {
    identifier: string;
    collectionIDs: number[];
  }[] = [];
  public identifierFailures = new Map<string, string>();
  public scriptRuns: { source: string; env: Record<string, unknown> }[] = [];
  /** Stands in for the script body, since no JS is evaluated in tests. */
  public scriptImplementation:
    ((env: Record<string, unknown>) => Promise<unknown> | unknown) | null =
    null;
  public importedFiles: Record<string, unknown>[] = [];
  public createdItems: Record<string, unknown>[] = [];
  public fieldsByItemType = new Map<string, string[]>();
  public invalidItemTypes = new Set<string>();
  public tagOperations: {
    op: string;
    libraryID: number;
    from: string;
    to?: string | null;
  }[] = [];
  public createdCollections: Record<string, unknown>[] = [];
  public savedCollections: {
    key: string;
    saveOptions: Record<string, unknown>;
  }[] = [];
  public erasedCollections: { key: string; deleteItems: boolean }[] = [];
  public merges: { masterKey: string; otherKeys: string[] }[] = [];
  public cacheText = "";
  public sdtReader: SdtReader | null = null;
  public pdfText: { text?: string; pageChars?: number[] } | null = null;

  /** Conditions from the most recent search. */
  public get lastSearch(): RecordedCondition[] {
    return this.searches[this.searches.length - 1] ?? [];
  }

  /** Set to make the next `executeTransaction` body throw after it runs. */
  public failTransactionCommit = false;

  public addItem(item: Partial<FakeItem> & { key: string }): FakeItem {
    const created: FakeItem = {
      id: item.id ?? this.items.length + 1,
      libraryID: item.libraryID ?? USER_LIBRARY_ID,
      itemType: item.itemType ?? "journalArticle",
      attachmentContentType: item.attachmentContentType ?? null,
      attachmentIDs: item.attachmentIDs ?? [],
      noteIDs: item.noteIDs ?? [],
      json: item.json ?? {},
      note: item.note ?? "",
      parentKey: item.parentKey,
      tags: item.tags ?? [],
      collectionIDs: item.collectionIDs ?? [],
      related: item.related ?? [],
      key: item.key,
    };
    this.items.push(created);
    return created;
  }

  public addCollection(
    collection: Partial<FakeCollection> & { key: string },
  ): FakeCollection {
    const created: FakeCollection = {
      id: collection.id ?? this.collections.length + 1,
      libraryID: collection.libraryID ?? USER_LIBRARY_ID,
      name: collection.name ?? "Collection",
      key: collection.key,
    };
    this.collections.push(created);
    return created;
  }

  public async getItemByKey(
    _libraryID: number,
    key: string,
  ): Promise<Zotero.Item | false> {
    // Deliberately ignores libraryID, mirroring the real hazard: a lookup that
    // does not constrain the library can hand back a group object, which is why
    // ItemResolver asserts libraryID itself.
    const found = this.items.find((item) => item.key === key);
    return found ? (toZoteroItem(found) as unknown as Zotero.Item) : false;
  }

  public getItemByID(itemID: number): Zotero.Item | false {
    const found = this.items.find((item) => item.id === itemID);
    return found ? (toZoteroItem(found) as unknown as Zotero.Item) : false;
  }

  public async getItemsByID(itemIDs: number[]): Promise<Zotero.Item[]> {
    return itemIDs
      .map((id) => this.items.find((item) => item.id === id))
      .filter((item): item is FakeItem => Boolean(item))
      .map((item) => toZoteroItem(item) as unknown as Zotero.Item);
  }

  public getCollectionsByLibrary(
    _libraryID: number,
    _recursive: boolean,
  ): Zotero.Collection[] {
    return this.collections as unknown as Zotero.Collection[];
  }

  public async getAllTags(
    _libraryID: number,
  ): Promise<{ tag: string; type: number }[]> {
    return this.tags;
  }

  /** Records every condition added, which is what the search tests assert on. */
  public createSearch(_libraryID: number): SearchHandle {
    const conditions: RecordedCondition[] = [];
    this.searches.push(conditions);
    const results = this.searchResults;
    return {
      addCondition: (condition, operator, value) => {
        if (this.rejectConditions.has(condition)) {
          throw new Error(`Invalid condition ${condition}`);
        }
        conditions.push({ condition, operator, value });
      },
      search: async () => results,
    };
  }

  public canSearchFullText(_text: string): boolean {
    return this.fullTextSearchable;
  }

  public fulltextCachePath(_item: Zotero.Item): string | null {
    return this.cachePath;
  }

  public async getAttachmentPath(_item: Zotero.Item): Promise<string | null> {
    return this.attachmentPath;
  }

  public generateObjectKey(): string {
    this.keyCounter += 1;
    return `NEWKEY${String(this.keyCounter).padStart(2, "0")}`;
  }

  public async saveAnnotation(
    attachment: Zotero.Item,
    json: Record<string, unknown>,
    saveOptions: Record<string, unknown> = {},
  ): Promise<Zotero.Item> {
    this.savedAnnotations.push({
      attachmentKey: attachment.key,
      json,
      saveOptions,
    });
    return {
      ...(json as object),
      key: json.key,
      itemType: "annotation",
      libraryID: USER_LIBRARY_ID,
    } as unknown as Zotero.Item;
  }

  public async runScript(
    source: string,
    env: Record<string, unknown>,
  ): Promise<unknown> {
    this.scriptRuns.push({ source, env });
    if (this.scriptImplementation) return this.scriptImplementation(env);
    return undefined;
  }

  public async importByIdentifier(
    identifier: string,
    collectionIDs: number[],
  ): Promise<Zotero.Item[]> {
    this.importedIdentifiers.push({ identifier, collectionIDs });
    const failure = this.identifierFailures.get(identifier);
    if (failure) throw new Error(failure);
    const created = this.addItem({
      key: this.generateObjectKey(),
      itemType: "journalArticle",
      json: { title: `Resolved ${identifier}` },
    });
    return [toZoteroItem(created) as unknown as Zotero.Item];
  }

  public async importFile(input: {
    path: string;
    parentItemID: number;
    linked: boolean;
    title?: string;
  }): Promise<Zotero.Item> {
    this.importedFiles.push(input);
    const created = this.addItem({
      key: this.generateObjectKey(),
      itemType: "attachment",
      attachmentContentType: "application/pdf",
    });
    return toZoteroItem(created) as unknown as Zotero.Item;
  }

  public async createItem(input: {
    itemType: string;
    fields: Record<string, unknown>;
    creators?: unknown[];
    collectionIDs?: number[];
  }): Promise<Zotero.Item> {
    this.createdItems.push(input);
    const created = this.addItem({
      key: this.generateObjectKey(),
      itemType: input.itemType,
      json: input.fields,
    });
    return toZoteroItem(created) as unknown as Zotero.Item;
  }

  public getFieldsForItemType(itemType: string): string[] {
    return this.fieldsByItemType.get(itemType) ?? ["title", "date", "extra"];
  }

  public isValidItemType(itemType: string): boolean {
    return !this.invalidItemTypes.has(itemType);
  }

  public async renameTag(
    libraryID: number,
    from: string,
    to: string,
  ): Promise<void> {
    this.tagOperations.push({ op: "rename", libraryID, from, to });
  }

  public async deleteTag(libraryID: number, tag: string): Promise<void> {
    this.tagOperations.push({ op: "delete", libraryID, from: tag });
  }

  public async setTagColor(
    libraryID: number,
    tag: string,
    color: string | false,
  ): Promise<void> {
    this.tagOperations.push({
      op: "setColor",
      libraryID,
      from: tag,
      to: color === false ? null : color,
    });
  }

  public async createCollection(input: {
    name: string;
    parentCollectionID?: number;
  }): Promise<Zotero.Collection> {
    const created = this.addCollection({
      key: this.generateObjectKey(),
      name: input.name,
    });
    this.createdCollections.push(input);
    return created as unknown as Zotero.Collection;
  }

  public async saveCollection(
    collection: Zotero.Collection,
    saveOptions: Record<string, unknown> = {},
  ): Promise<void> {
    this.savedCollections.push({ key: collection.key, saveOptions });
  }

  public async eraseCollection(
    collection: Zotero.Collection,
    deleteItems: boolean,
  ): Promise<void> {
    this.erasedCollections.push({ key: collection.key, deleteItems });
  }

  public async mergeItems(
    master: Zotero.Item,
    others: Zotero.Item[],
  ): Promise<void> {
    this.merges.push({
      masterKey: master.key,
      otherKeys: others.map((item) => item.key),
    });
  }

  public async createNote(
    html: string,
    parent: Zotero.Item | null,
  ): Promise<Zotero.Item> {
    const key = this.generateObjectKey();
    this.createdNotes.push({ key, html, parentKey: parent?.key ?? null });
    const created = this.addItem({
      key,
      itemType: "note",
      note: html,
      parentKey: parent?.key,
    });
    return toZoteroItem(created) as unknown as Zotero.Item;
  }

  public async saveItem(
    item: Zotero.Item,
    saveOptions: Record<string, unknown> = {},
  ): Promise<void> {
    this.savedItems.push({ key: item.key, saveOptions });
  }

  public async trashItem(
    item: Zotero.Item,
    saveOptions: Record<string, unknown> = {},
  ): Promise<void> {
    this.trashedItems.push({ key: item.key, saveOptions });
  }

  public async readTextFile(_path: string): Promise<string> {
    return this.cacheText;
  }

  public async getSdtReader(_itemID: number): Promise<SdtReader | null> {
    return this.sdtReader;
  }

  public async getPdfFullText(
    _itemID: number,
  ): Promise<{ text?: string; pageChars?: number[] } | null> {
    return this.pdfText;
  }

  public async getCollectionByKey(
    _libraryID: number,
    key: string,
  ): Promise<Zotero.Collection | false> {
    const found = this.collections.find((c) => c.key === key);
    return found ? (found as unknown as Zotero.Collection) : false;
  }

  public async executeTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    const result = await fn();
    if (this.failTransactionCommit) {
      this.failTransactionCommit = false;
      throw new Error("simulated commit failure");
    }
    return result;
  }

  public stageUndoAction(action: string, args?: Record<string, unknown>): void {
    this.stagedUndoActions.push({ action, args });
  }

  public registerLocalization(files: string[]): void {
    this.registeredLocalizations.push(...files);
  }

  public unregisterLocalization(files: string[]): void {
    this.registeredLocalizations = this.registeredLocalizations.filter(
      (file) => !files.includes(file),
    );
  }

  public getPref(key: string): unknown {
    return this.prefs.get(key);
  }

  public setPref(key: string, value: unknown): void {
    this.prefs.set(key, value);
  }

  public getZoteroPref(key: string): unknown {
    return this.zoteroPrefs.get(key);
  }

  public isHttpServerEnabled(): boolean {
    return this.httpServerEnabled;
  }

  public httpServerPort(): number {
    return this.port;
  }

  public hasEndpoint(path: string): boolean {
    return this.endpoints.has(path);
  }

  public registerEndpoint(path: string, endpoint: EndpointConstructor): void {
    this.endpoints.set(path, endpoint);
  }

  public unregisterEndpoint(path: string): void {
    this.endpoints.delete(path);
  }

  public showPopup(title: string, body: string, isError: boolean): void {
    this.popups.push({ title, body, isError });
  }

  public log(...args: unknown[]): void {
    this.logs.push(args);
  }
}

function toZoteroItem(item: FakeItem) {
  return {
    ...item,
    isAttachment: () => item.itemType === "attachment",
    isAnnotation: () => item.itemType === "annotation",
    isRegularItem: () =>
      item.itemType !== "attachment" && item.itemType !== "note",
    getField: (field: string) => String((item.json ?? {})[field] ?? ""),
    setField: (field: string, value: string) => {
      item.json = { ...(item.json ?? {}), [field]: value };
    },
    getCreators: () => [],
    getTags: () => (item.tags ?? []).map((tag) => ({ tag })),
    addTag: (tag: string) => {
      item.tags = [...new Set([...(item.tags ?? []), tag])];
      return true;
    },
    removeTag: (tag: string) => {
      item.tags = (item.tags ?? []).filter((existing) => existing !== tag);
    },
    setCreators: () => {},
    addToCollection: (id: number) => {
      item.collectionIDs = [...new Set([...(item.collectionIDs ?? []), id])];
    },
    removeFromCollection: (id: number) => {
      item.collectionIDs = (item.collectionIDs ?? []).filter((c) => c !== id);
    },
    getCollections: () => item.collectionIDs ?? [],
    addRelatedItem: (other: { key: string }) => {
      const before = item.related ?? [];
      if (before.includes(other.key)) return false;
      item.related = [...before, other.key];
      return true;
    },
    removeRelatedItem: (other: { key: string }) => {
      const before = item.related ?? [];
      if (!before.includes(other.key)) return false;
      item.related = before.filter((key) => key !== other.key);
      return true;
    },
    getAttachments: () => item.attachmentIDs ?? [],
    getNotes: () => item.noteIDs ?? [],
    getAnnotations: () => [],
    getNote: () => item.note ?? "",
    setNote: (html: string) => {
      item.note = html;
    },
    setTags: (tags: { tag: string }[]) => {
      item.tags = tags.map((entry) => entry.tag);
    },
    saveTx: async () => {},
    toJSON: () => item.json ?? {},
  };
}
