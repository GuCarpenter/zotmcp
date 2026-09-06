/**
 * In-memory ZoteroGateway for unit tests. Lets every service be exercised in
 * plain Node with no Zotero process.
 */

import type { ZoteroGateway } from "../../src/services/zoteroGateway";

export const USER_LIBRARY_ID = 1;
export const GROUP_LIBRARY_ID = 7;

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
  public logs: unknown[][] = [];
  public transactionCount = 0;

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

  public getPref(key: string): unknown {
    return this.prefs.get(key);
  }

  public setPref(key: string, value: unknown): void {
    this.prefs.set(key, value);
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
