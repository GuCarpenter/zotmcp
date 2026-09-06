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
