/**
 * The single seam between this plugin and Zotero.
 *
 * Every other module takes a `ZoteroGateway` rather than reaching for the global
 * `Zotero` object, which keeps the whole codebase unit-testable in plain Node
 * against a fake. Nothing outside this file may reference `Zotero` directly.
 */

export interface ZoteroGateway {
  /** My Library's numeric ID. All operations are scoped to it (spec LB-1). */
  readonly userLibraryID: number;

  /** Zotero application version, e.g. "8.0.3". */
  readonly version: string;

  /** Gecko major version: 115 (Zotero 7.0), 128 (7.1 beta), 140 (Zotero 8). */
  readonly platformMajorVersion: number;

  getItemByKey(libraryID: number, key: string): Promise<Zotero.Item | false>;
  getItemByID(itemID: number): Zotero.Item | false;
  getCollectionByKey(
    libraryID: number,
    key: string,
  ): Promise<Zotero.Collection | false>;

  /**
   * Runs `fn` inside a Zotero DB transaction. Multi-save operations rely on this
   * for atomicity — notably bidirectional related-item links, where a failure on
   * the second side must roll back the first (spec W-9).
   */
  executeTransaction<T>(fn: () => Promise<T>): Promise<T>;

  getPref(key: string): unknown;
  setPref(key: string, value: unknown): void;

  log(...args: unknown[]): void;
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

  public async getCollectionByKey(
    libraryID: number,
    key: string,
  ): Promise<Zotero.Collection | false> {
    return Zotero.Collections.getByLibraryAndKeyAsync(libraryID, key);
  }

  public async executeTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return Zotero.DB.executeTransaction(fn);
  }

  public getPref(key: string): unknown {
    return Zotero.Prefs.get(key, true);
  }

  public setPref(key: string, value: unknown): void {
    Zotero.Prefs.set(key, value as never, true);
  }

  public log(...args: unknown[]): void {
    ztoolkit.log(...args);
  }
}
