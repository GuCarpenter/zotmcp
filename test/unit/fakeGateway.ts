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
    isRegularItem: () =>
      item.itemType !== "attachment" && item.itemType !== "note",
  };
}
