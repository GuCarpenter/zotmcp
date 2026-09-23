/**
 * The single seam between this plugin and Zotero.
 *
 * Every other module takes a `ZoteroGateway` rather than reaching for the global
 * `Zotero` object, which keeps the whole codebase unit-testable in plain Node
 * against a fake. Nothing outside this file may reference `Zotero` directly.
 */

import type { CfiDomNode, EpubSpine } from "./epubCfi";
import Defuddle from "defuddle/full";
import { parseHTML } from "linkedom";
import * as temmlModule from "temml";
import { extractFrontMatter, frontMatterToMetadata } from "./frontMatter";
import { markdownToNoteHtml, noteHtmlToMarkdown } from "./noteService";
import { config } from "../../package.json";

// Temml ships a default-only ESM bundle; unwrap it to the render API.
const temml = ((temmlModule as { default?: unknown }).default ??
  temmlModule) as {
  renderToString(
    latex: string,
    options?: { displayMode?: boolean; throwOnError?: boolean },
  ): string;
};

/** Zotero's default connector-server port. */
export const DEFAULT_HTTP_PORT = 23119;

/** A current desktop-Firefox User-Agent, sent when fetching pages to import. */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

/** How long to let a page's client-side scripts (e.g. MathJax) settle. */
const RENDER_SETTLE_MS = 4000;

/**
 * How long to keep waiting for an anti-bot interstitial (Cloudflare's "Just a
 * moment...", etc.) to clear itself in the hidden browser, and how often to
 * re-check. The JS challenge runs non-interactively and then navigates to the
 * real page, so polling the document until the markers disappear captures the
 * article instead of the holding page.
 */
const CHALLENGE_MAX_WAIT_MS = 20000;
const CHALLENGE_POLL_MS = 1000;

/**
 * Whether an HTML document is an anti-bot holding page rather than real
 * content. Recognises Cloudflare's interstitial (title "Just a moment...", the
 * challenge-platform script, `cf_chl`/Turnstile widgets) and the common
 * "checking your browser" / "enable JavaScript and cookies" phrasings. Kept
 * intentionally narrow so ordinary articles that merely mention Cloudflare do
 * not trip it.
 */
export function looksLikeAntiBotChallenge(html: string): boolean {
  if (!html) return false;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  if (/^just a moment/i.test(title)) return true;
  return (
    /challenge-platform\//i.test(html) ||
    /window\._cf_chl_opt/i.test(html) ||
    /cf-browser-verification/i.test(html) ||
    /\bcf_chl_/i.test(html) ||
    /\/turnstile\//i.test(html) ||
    /checking your browser before accessing/i.test(html) ||
    /(enable|turn on) javascript and cookies to continue/i.test(html) ||
    /performing security verification/i.test(html) ||
    /verify(ing)? you are (not a|human)/i.test(html)
  );
}

/** The readable article Defuddle extracts from a full HTML page. */
export interface ReadableResult {
  /** Clean article HTML, chrome and boilerplate removed. */
  html: string;
  /** Markdown rendering of the clean HTML, math converted to LaTeX. */
  markdown: string;
  title: string;
  author: string;
  published: string;
  description: string;
  wordCount: number;
}

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

  /** Key of the collection currently selected in the main window, if any. */
  getSelectedCollectionKey(): string | null;

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

  /** Fetches a URL as text over Zotero's HTTP stack (cookies, redirects). */
  fetchText(url: string): Promise<string>;

  /**
   * Fetches a binary resource (e.g. an image) and returns it as a `data:` URI,
   * or null when the request fails or the type is not an image. Used to inline
   * a clean snapshot's images so it reads offline.
   */
  fetchDataUri(url: string): Promise<string | null>;

  /**
   * Creates a webpage item with a self-contained HTML snapshot attachment from
   * already-extracted content. Returns both new keys.
   */
  saveWebpageSnapshot(input: {
    url: string;
    title: string;
    snapshotContent: string;
    fields?: Record<string, unknown>;
    creators?: unknown[];
    collectionIDs?: number[];
  }): Promise<{ itemKey: string; attachmentKey: string }>;

  /**
   * Renders a local Markdown file to a themed HTML snapshot and attaches it to
   * the given item, so Markdown reads like the plugin's web captures.
   */
  importMarkdownSnapshot(input: {
    path: string;
    parentItemID: number;
    title: string;
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
   * Extracts the readable article from a full HTML page, discarding chrome,
   * ads and navigation. Returns clean article HTML, its Markdown rendering
   * (math converted to LaTeX) and the article metadata. Privileged: it parses
   * HTML with a DOM and runs the bundled Defuddle extractor, so it lives here.
   */
  extractReadable(html: string, url: string): Promise<ReadableResult>;

  /**
   * Reads a file's raw bytes and returns them base64-encoded, or null when the
   * file is missing or larger than `maxBytes`. Used to hand image bytes back to
   * an MCP client. Privileged (raw file IO), so it lives on the gateway.
   */
  readBinaryFileAsBase64(
    path: string,
    maxBytes?: number,
  ): Promise<{ base64: string; bytes: number } | null>;

  /**
   * Renders an image or ink annotation to a base64 PNG (no data-URI prefix),
   * populating Zotero's annotation image cache first when needed. Null when the
   * annotation is not renderable or its parent PDF is unavailable.
   */
  renderAnnotationImage(annotation: Zotero.Item): Promise<string | null>;

  /**
   * Renders a single PDF page to a base64 PNG using the reader's PDF.js engine.
   * Requires an open reader for the attachment; when `openIfNeeded` is set and
   * none is open, a background reader is opened, used and left in place. Null
   * when no reader is available or the page cannot be rendered.
   */
  renderPdfPageImage(
    attachmentItemID: number,
    pageIndex: number,
    options?: { openIfNeeded?: boolean },
  ): Promise<{
    base64: string;
    mimeType: string;
    width: number;
    height: number;
  } | null>;

  /**
   * Renders a rectangular region of a PDF page to a base64 PNG, cropped to the
   * given page-coordinate rect `[x1, y1, x2, y2]` (PDF user space, the same
   * space annotation rects use). Same reader requirement as `renderPdfPageImage`.
   */
  renderPdfRegionImage(
    attachmentItemID: number,
    pageIndex: number,
    rect: [number, number, number, number],
    options?: { openIfNeeded?: boolean },
  ): Promise<{
    base64: string;
    mimeType: string;
    width: number;
    height: number;
  } | null>;

  /**
   * Captures the reader's currently visible viewport for an open attachment as
   * a base64 PNG — exactly what is painted, including scroll offset, zoom and a
   * continuous view spanning two pages. Works for any reader type (PDF, EPUB,
   * snapshot). Null when the attachment is not open in a reader.
   */
  captureReaderViewport(attachmentItemID: number): Promise<{
    base64: string;
    mimeType: string;
    width: number;
    height: number;
  } | null>;

  /**
   * Extracts an EPUB's embedded figure image by caption label (e.g.
   * "Figure 3.5"): finds the caption in the spine, resolves the associated
   * `<img>` inside its `<figure>` (or the nearest one), and reads that image
   * entry's bytes from the EPUB zip. Null when the attachment is not an EPUB or
   * the label cannot be matched to an image.
   */
  extractEpubFigureImage(
    attachment: Zotero.Item,
    label: string,
  ): Promise<{
    base64: string;
    mimeType: string;
    entry: string;
    label: string;
  } | null>;

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
   * Reads an EPUB attachment's spine into parsed content documents plus the
   * `<spine>` element's position in the package, everything the CFI builder
   * needs. Null when the attachment is not an EPUB or its file is unreadable.
   * Privileged (zip reading and XHTML parsing), so it lives here.
   */
  readEpubSpine(attachment: Zotero.Item): Promise<EpubSpine | null>;

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

  /** Inspects the currently active reader or a reader for the given attachment item ID. */
  getActiveReader(attachmentItemID?: number): ActiveReaderDetails | null;

  /** Lists all currently open readers in tabs or windows. */
  getOpenReaders(): ActiveReaderDetails[];

  /**
   * Opens an attachment in Zotero's reader, or navigates the reader already open
   * for it. Mirrors the `zotero://open` protocol path: a `location` moves the
   * view to a page, annotation or EPUB CFI. Resolves once the open/navigate call
   * has been issued.
   */
  openReader(input: ReaderOpenInput): Promise<void>;
}

/** A reader target, shaped like Zotero's own `Reader.Location`. */
export interface ReaderNavLocation {
  /** 0-based PDF page index. */
  pageIndex?: number;
  /** Physical page label, when navigating by printed page number. */
  pageLabel?: string;
  /** Annotation key to scroll to and select. */
  annotationID?: string;
  /** Selector position, e.g. an EPUB `FragmentSelector` carrying a CFI. */
  position?: Record<string, unknown>;
}

export interface ReaderOpenInput {
  itemID: number;
  location?: ReaderNavLocation;
  /** Open without stealing focus / selecting the tab. */
  openInBackground?: boolean;
  /** Open in a standalone reader window rather than a tab. */
  openInWindow?: boolean;
}

export interface ActiveReaderDetails {
  readerID?: string;
  tabID?: string;
  windowID?: string;
  itemID: number;
  type: "pdf" | "epub" | "snapshot" | string;
  title: string;
  readOnly?: boolean;
  state?: {
    pageIndex?: number;
    cfi?: string;
    scrollYPercent?: number;
    scrollXPercent?: number;
    scale?: string | number;
    top?: number;
    left?: number;
    scrollMode?: number;
    spreadMode?: number;
  };
  selection?: {
    type: "text" | "annotation";
    text: string;
    position?: Record<string, unknown>;
    pageIndex?: number;
    pageLabel?: string;
    annotationKey?: string;
    annotationType?: string;
    comment?: string;
    color?: string;
  } | null;
  pageLabel?: string;
  totalPages?: number;
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
    /** Packed per-glyph geometry for a PDF text leaf; see pdfTextMap.ts. */
    textMap?: string;
  };
}

export interface SdtOutlineItem {
  title?: string;
  /** Path to the block the entry points at; the first element is block index. */
  ref?: number[];
  /**
   * How the entry entered the outline: `"native"` for the document's authored
   * outline (what the reader's left panel shows), `"detected"` for headings the
   * packer inferred heuristically. Absent on older packs.
   */
  source?: "native" | "detected" | string;
  target?: { position?: { pageIndex?: number } };
  items?: SdtOutlineItem[];
  children?: SdtOutlineItem[];
}

export interface SdtCatalog {
  pages?: {
    label?: string;
    /**
     * Block span of the page as `[[startBlockIndex], [endBlockIndex]]`, the
     * first element giving the page's opening top-level block.
     */
    contentRange?: number[][];
  }[];
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

  public getSelectedCollectionKey(): string | null {
    try {
      const win = (
        Zotero as unknown as { getMainWindow?(): Window | undefined }
      ).getMainWindow?.();
      const pane = (
        win as unknown as {
          ZoteroPane?: { getSelectedCollection?(): { key?: string } | false };
        }
      )?.ZoteroPane;
      const collection = pane?.getSelectedCollection?.();
      return collection && collection.key ? collection.key : null;
    } catch {
      return null;
    }
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

  public async fetchText(url: string): Promise<string> {
    // Load in a hidden browser so the page's own JavaScript runs, exactly as
    // Zotero's connector does. This renders client-side content (e.g. MathJax
    // turns LaTeX into MathML that Gecko can display offline) and clears cookie
    // or JS anti-bot challenges that a plain HTTP GET trips. Falls back to a
    // direct HTTP fetch if the hidden browser is unavailable.
    try {
      return await this.fetchRenderedHtml(url);
    } catch (e) {
      this.log("WARN fetchRenderedHtml failed, using HTTP", url, e);
      return this.fetchHttpText(url);
    }
  }

  private async fetchRenderedHtml(url: string): Promise<string> {
    const { HiddenBrowser } = ChromeUtils.importESModule(
      "chrome://zotero/content/HiddenBrowser.mjs",
    ) as {
      HiddenBrowser: new (options?: Record<string, unknown>) => {
        load(url: string, options?: unknown): Promise<void>;
        waitForDocument?(): Promise<void>;
        getDocument(): Promise<Document>;
        destroy(): void;
      };
    };

    const browser = new HiddenBrowser({ blockRemoteResources: false });
    try {
      await browser.load(url);
      await browser.waitForDocument?.();

      // An anti-bot interstitial (Cloudflare's "Just a moment...") loads first,
      // runs its JS challenge, then navigates to the real page. Serializing
      // immediately would capture the holding page, so poll until the markers
      // clear (a clearance cookie makes later loads pass at once).
      let html = await this.serializeDocument(browser);
      const deadline = Date.now() + CHALLENGE_MAX_WAIT_MS;
      while (looksLikeAntiBotChallenge(html) && Date.now() < deadline) {
        await Zotero.Promise.delay(CHALLENGE_POLL_MS);
        html = await this.serializeDocument(browser);
      }

      // Client-side typesetting (MathJax) finishes after load; give it a moment
      // so the rendered MathML is in the DOM before we serialize.
      await Zotero.Promise.delay(RENDER_SETTLE_MS);
      return await this.serializeDocument(browser);
    } finally {
      try {
        browser.destroy();
      } catch {
        // A failed teardown must not mask a successful (or failed) load.
      }
    }
  }

  private async serializeDocument(browser: {
    getDocument(): Promise<Document>;
  }): Promise<string> {
    const doc = await browser.getDocument();
    return String(doc.documentElement?.outerHTML ?? "");
  }

  private async fetchHttpText(url: string): Promise<string> {
    const http = Zotero.HTTP as unknown as {
      request(
        method: string,
        url: string,
        options?: Record<string, unknown>,
      ): Promise<{ responseText: string }>;
    };
    // A browser-like User-Agent and Accept headers: some sites answer the
    // default Zotero agent with a 403 or an anti-bot interstitial. Such a
    // challenge often sets a cookie on the first response, so one retry through
    // Zotero's shared cookie store then succeeds.
    const options = {
      responseType: "text",
      timeout: 30_000,
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en,zh-CN;q=0.9,zh;q=0.8",
      },
    };
    try {
      const response = await http.request("GET", url, options);
      return response.responseText ?? "";
    } catch {
      const response = await http.request("GET", url, options);
      return response.responseText ?? "";
    }
  }

  public async fetchDataUri(url: string): Promise<string | null> {
    try {
      const http = Zotero.HTTP as unknown as {
        request(
          method: string,
          url: string,
          options?: Record<string, unknown>,
        ): Promise<{
          response: ArrayBuffer;
          getResponseHeader(name: string): string | null;
        }>;
      };
      const response = await http.request("GET", url, {
        responseType: "arraybuffer",
        timeout: 30_000,
      });
      const contentType = (
        response.getResponseHeader("Content-Type") ?? ""
      ).split(";")[0];
      if (!contentType.startsWith("image/")) return null;
      const base64 = base64FromBytes(new Uint8Array(response.response));
      return `data:${contentType};base64,${base64}`;
    } catch {
      return null;
    }
  }

  public async saveWebpageSnapshot(input: {
    url: string;
    title: string;
    snapshotContent: string;
    fields?: Record<string, unknown>;
    creators?: unknown[];
    collectionIDs?: number[];
  }): Promise<{ itemKey: string; attachmentKey: string }> {
    const item = await this.createItem({
      itemType: "webpage",
      fields: { title: input.title, url: input.url, ...(input.fields ?? {}) },
      creators: input.creators,
      collectionIDs: input.collectionIDs,
    });

    const attachments = Zotero.Attachments as unknown as {
      importFromSnapshotContent(options: {
        url: string;
        snapshotContent: string;
        parentItemID: number;
        title?: string;
      }): Promise<Zotero.Item>;
    };
    const attachment = await attachments.importFromSnapshotContent({
      url: input.url,
      snapshotContent: wrapSnapshotHtml(
        input.title,
        renderSnapshotMath(input.snapshotContent),
      ),
      parentItemID: item.id,
      title: input.title,
    });

    return { itemKey: item.key, attachmentKey: attachment.key };
  }

  public async importMarkdownSnapshot(input: {
    path: string;
    parentItemID: number;
    title: string;
  }): Promise<Zotero.Item> {
    const markdown = await this.readTextFile(input.path);
    const { data, body } = extractFrontMatter(markdown);
    const meta = frontMatterToMetadata(data);

    await this.applyFrontMatterToParent(input.parentItemID, meta);

    const title = meta.fields.title || input.title;
    const bodyHtml = markdownToNoteHtml(renderMarkdownMath(body));
    const snapshotContent = wrapSnapshotHtml(title, bodyHtml);

    const attachments = Zotero.Attachments as unknown as {
      importFromSnapshotContent(options: {
        url: string;
        snapshotContent: string;
        parentItemID: number;
        title?: string;
      }): Promise<Zotero.Item>;
    };
    return attachments.importFromSnapshotContent({
      url: pathToFileUri(input.path),
      snapshotContent,
      parentItemID: input.parentItemID,
      title,
    });
  }

  /**
   * Fills a Markdown import's parent item from its front matter. Only fields the
   * item type actually has and that are currently empty are set, so a manually
   * curated item is never clobbered; creators and tags are added only when none
   * exist yet.
   */
  private async applyFrontMatterToParent(
    parentItemID: number,
    meta: {
      fields: Record<string, string>;
      creators: { creatorType: "author"; name: string }[];
      tags: string[];
    },
  ): Promise<void> {
    const item = Zotero.Items.get(parentItemID);
    if (!item) return;

    const valid = new Set(this.getFieldsForItemType(String(item.itemType)));
    let changed = false;

    for (const [field, value] of Object.entries(meta.fields)) {
      if (!valid.has(field) || !value) continue;
      let current: string;
      try {
        current = String(item.getField(field as never) ?? "");
      } catch {
        continue;
      }
      if (current) continue;
      item.setField(field as never, value);
      changed = true;
    }

    if (meta.creators.length && item.getCreators().length === 0) {
      item.setCreators(
        meta.creators.map((creator) => ({
          creatorType: creator.creatorType,
          name: creator.name,
          fieldMode: 1,
        })) as never,
      );
      changed = true;
    }

    if (meta.tags.length) {
      for (const tag of meta.tags) item.addTag(tag);
      changed = true;
    }

    if (changed) await item.saveTx();
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

  public async extractReadable(
    html: string,
    url: string,
  ): Promise<ReadableResult> {
    ensureExtractionGlobals();
    // linkedom, not Gecko's DOMParser: Defuddle's content scoring isolates the
    // article on a linkedom document but returns the whole page body on a Zotero
    // DOMParser document. The full build's parse() fills each MathML node's
    // data-latex (via mathml-to-latex); we then render the clean HTML to
    // Markdown ourselves, turning that data-latex into LaTeX, rather than
    // calling the bundled turndown, whose HTML parser is unreliable here.
    const { document } = parseHTML(html);
    const result = new Defuddle(document as unknown as Document, {
      url,
      useAsync: false,
    }).parse();
    const cleanHtml = result.content ?? "";
    return {
      html: cleanHtml,
      markdown: cleanHtml ? noteHtmlToMarkdown(cleanHtml) : "",
      title: result.title ?? "",
      author: result.author ?? "",
      published: result.published ?? "",
      description: result.description ?? "",
      wordCount: typeof result.wordCount === "number" ? result.wordCount : 0,
    };
  }

  public async readBinaryFileAsBase64(
    path: string,
    maxBytes?: number,
  ): Promise<{ base64: string; bytes: number } | null> {
    try {
      const io = IOUtils as unknown as {
        stat(path: string): Promise<{ size: number }>;
        read(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
      };
      if (maxBytes !== undefined) {
        const info = await io.stat(path);
        if (typeof info?.size === "number" && info.size > maxBytes) {
          this.log(
            "WARN readBinaryFileAsBase64 exceeds maxBytes",
            path,
            info.size,
            maxBytes,
          );
          return null;
        }
      }
      const bytes = await io.read(path);
      return { base64: base64FromBytes(bytes), bytes: bytes.length };
    } catch (e) {
      // A missing or unreadable file is a normal "no image" outcome, not a crash.
      this.log("WARN readBinaryFileAsBase64 failed", path, e);
      return null;
    }
  }

  public async renderAnnotationImage(
    annotation: Zotero.Item,
  ): Promise<string | null> {
    try {
      const annotations = Zotero.Annotations as unknown as {
        getCacheImagePath(item: { libraryID: number; key: string }): string;
        hasCacheImage(item: {
          libraryID: number;
          key: string;
        }): Promise<boolean>;
      };
      const annType = (annotation as unknown as { annotationType?: string })
        .annotationType;
      if (annType !== "image" && annType !== "ink") return null;

      // For a PDF parent the image cache may not exist yet; the PDF worker
      // renders every missing image/ink annotation on demand.
      const parent = (annotation as unknown as { parentItem?: Zotero.Item })
        .parentItem;
      const isPdf = Boolean(
        parent &&
        (
          parent as unknown as { isPDFAttachment?(): boolean }
        ).isPDFAttachment?.(),
      );
      if (isPdf && parent && !(await annotations.hasCacheImage(annotation))) {
        try {
          await (
            Zotero as unknown as {
              PDFWorker: {
                renderAttachmentAnnotations(
                  itemID: number,
                  isPriority?: boolean,
                ): Promise<number>;
              };
            }
          ).PDFWorker.renderAttachmentAnnotations(parent.id, true);
        } catch (e) {
          this.log(
            "WARN renderAttachmentAnnotations failed",
            annotation.key,
            e,
          );
        }
      }

      const path = annotations.getCacheImagePath(annotation);
      const result = await this.readBinaryFileAsBase64(path);
      return result?.base64 ?? null;
    } catch (e) {
      this.log("WARN renderAnnotationImage failed", annotation.key, e);
      return null;
    }
  }

  public async renderPdfPageImage(
    attachmentItemID: number,
    pageIndex: number,
    options: { openIfNeeded?: boolean } = {},
  ): Promise<{
    base64: string;
    mimeType: string;
    width: number;
    height: number;
  } | null> {
    return this.renderViaReader(attachmentItemID, pageIndex, null, options);
  }

  public async renderPdfRegionImage(
    attachmentItemID: number,
    pageIndex: number,
    rect: [number, number, number, number],
    options: { openIfNeeded?: boolean } = {},
  ): Promise<{
    base64: string;
    mimeType: string;
    width: number;
    height: number;
  } | null> {
    return this.renderViaReader(attachmentItemID, pageIndex, rect, options);
  }

  /**
   * Renders a PDF page, or a page-coordinate region of it, by driving the open
   * reader's own PDF.js renderer (`_pdfRenderer.renderRegionCrops`). That keeps
   * the whole render inside the reader's content scope — the only place the
   * viewer's document and canvases are usable — and returns a PNG data URL. A
   * null `rect` renders the full page view box.
   */
  private async renderViaReader(
    attachmentItemID: number,
    pageIndex: number,
    rect: [number, number, number, number] | null,
    options: { openIfNeeded?: boolean },
  ): Promise<{
    base64: string;
    mimeType: string;
    width: number;
    height: number;
  } | null> {
    try {
      let reader = this.findReaderByItemID(attachmentItemID);
      if (!reader && options.openIfNeeded) {
        reader = await this.openBackgroundReader(attachmentItemID);
      }
      if (!reader) return null;

      const ctx = this.getReaderRenderContext(reader);
      if (!ctx) return null;
      const { win, renderer, pdfDocument } = ctx;

      const pageNumber = pageIndex + 1;
      if (pageNumber < 1 || pageNumber > pdfDocument.numPages) return null;

      // A null rect means the whole page: fall back to the page's view box.
      let region = rect;
      if (!region) {
        const page = waiveXrays(await pdfDocument.getPage(pageNumber)) as {
          view: number[];
        };
        const v = page.view;
        if (!v || v.length < 4) return null;
        region = [v[0], v[1], v[2], v[3]];
      }

      // renderRegionCrops runs in the reader's content scope, so the rect array
      // must be cloned into that scope or the content code cannot read it.
      const crops = waiveXrays(
        await renderer.renderRegionCrops(pageIndex, cloneInto([region], win)),
      ) as string[];
      const dataUrl = crops?.[0];
      if (typeof dataUrl !== "string" || !dataUrl) return null;

      const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      const dims = pngDimensions(base64);
      return {
        base64,
        mimeType: "image/png",
        width: dims?.width ?? 0,
        height: dims?.height ?? 0,
      };
    } catch (e) {
      this.log("WARN renderViaReader failed", attachmentItemID, pageIndex, e);
      return null;
    }
  }

  public async captureReaderViewport(attachmentItemID: number): Promise<{
    base64: string;
    mimeType: string;
    width: number;
    height: number;
  } | null> {
    try {
      const reader = this.findReaderByItemID(attachmentItemID);
      if (!reader) return null;
      const internal = reader._internalReader as
        Record<string, unknown> | undefined;
      const primaryView = (internal?._primaryView ?? reader._primaryView) as
        Record<string, unknown> | undefined;
      const cwin = primaryView?._iframeWindow as
        (Window & { devicePixelRatio?: number }) | undefined;
      if (!cwin) return null;

      const mainWin = (
        Zotero as unknown as { getMainWindow?(): Window | undefined }
      ).getMainWindow?.();
      if (!mainWin) return null;

      const dpr = cwin.devicePixelRatio || 1;
      const cssWidth = cwin.innerWidth;
      const cssHeight = cwin.innerHeight;
      if (!(cssWidth > 0) || !(cssHeight > 0)) return null;

      // pdf.js renders pages lazily: a page just scrolled into view can still be
      // mid-render (renderingState RUNNING) with a blank canvas, which
      // drawWindow would capture as an empty page. Force and await rendering of
      // the visible pages first. No-op for EPUB/snapshot readers.
      await this.waitForVisiblePdfPages(cwin);

      const canvas = mainWin.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas",
      ) as HTMLCanvasElement;
      canvas.width = Math.floor(cssWidth * dpr);
      canvas.height = Math.floor(cssHeight * dpr);

      // drawWindow is a privileged, chrome-only 2D-context method that paints a
      // DOM window's current pixels — the faithful "screenshot" of the reader's
      // visible area, including scroll, zoom and cross-page content.
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D & {
        drawWindow(
          window: Window,
          x: number,
          y: number,
          w: number,
          h: number,
          bgColor: string,
        ): void;
      };
      ctx.scale(dpr, dpr);
      ctx.drawWindow(cwin, 0, 0, cssWidth, cssHeight, "rgb(255,255,255)");

      const dataUrl = canvas.toDataURL("image/png") as string;
      canvas.width = 0;
      canvas.height = 0;

      return {
        base64: dataUrl.replace(/^data:image\/png;base64,/, ""),
        mimeType: "image/png",
        width: Math.floor(cssWidth * dpr),
        height: Math.floor(cssHeight * dpr),
      };
    } catch (e) {
      this.log("WARN captureReaderViewport failed", attachmentItemID, e);
      return null;
    }
  }

  public async extractEpubFigureImage(
    attachment: Zotero.Item,
    label: string,
  ): Promise<{
    base64: string;
    mimeType: string;
    entry: string;
    label: string;
  } | null> {
    if (attachment.attachmentContentType !== "application/epub+zip")
      return null;
    const parsed = parseFigureLabel(label);
    if (!parsed) return null;

    let zip: ZipHandle | null = null;
    try {
      const path = await this.getAttachmentPath(attachment);
      if (!path) return null;

      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
        Ci.nsIZipReader,
      ) as unknown as ZipHandle;
      zip.open(file);

      const readText = (entry: string): string => {
        const stream = zip!.getInputStream(entry);
        const converter = Cc[
          "@mozilla.org/intl/converter-input-stream;1"
        ].createInstance(Ci.nsIConverterInputStream);
        converter.init(stream as never, "UTF-8", 0, 0);
        let text = "";
        const chunk: { value: string } = { value: "" };
        while (converter.readString(65536, chunk) !== 0) text += chunk.value;
        converter.close();
        return text;
      };

      const parser = new DOMParser();
      const container = parser.parseFromString(
        readText("META-INF/container.xml"),
        "application/xml",
      );
      const opfPath = container
        .querySelector("rootfile")
        ?.getAttribute("full-path");
      if (!opfPath) return null;
      const opfDir = opfPath.includes("/") ? opfPath.replace(/[^/]+$/, "") : "";

      const opf = parser.parseFromString(readText(opfPath), "application/xml");
      const manifest = new Map<string, string>();
      opf.querySelectorAll("manifest > item").forEach((item: Element) => {
        const id = item.getAttribute("id");
        const href = item.getAttribute("href");
        if (id && href) manifest.set(id, href);
      });
      const itemrefs = Array.prototype.slice.call(
        opf.querySelectorAll("spine > itemref"),
      ) as Element[];

      for (const itemref of itemrefs) {
        const idref = itemref.getAttribute("idref");
        const href = idref ? manifest.get(idref) : undefined;
        if (!href) continue;
        const docEntry = resolveEpubPath(opfDir, href);
        let xhtml: string;
        try {
          xhtml = readText(docEntry);
        } catch {
          continue;
        }
        if (!/figure|table/i.test(xhtml)) continue;

        const doc = parser.parseFromString(xhtml, "application/xhtml+xml");
        if (doc.querySelector("parsererror")) continue;

        const src = this.findEpubFigureImageSrc(doc, parsed);
        if (!src) continue;

        // Resolve the img src (relative to the doc's folder) to a zip entry.
        const docDir = docEntry.includes("/")
          ? docEntry.replace(/[^/]+$/, "")
          : "";
        const imgEntry = resolveEpubPath(docDir, src);
        const bytes = this.readZipEntryBytes(zip!, imgEntry);
        if (!bytes) continue;

        return {
          base64: base64FromBytes(bytes),
          mimeType: mimeFromExtension(imgEntry),
          entry: imgEntry,
          label: parsed.canonical,
        };
      }
      return null;
    } catch (e) {
      this.log("WARN extractEpubFigureImage failed", attachment.key, e);
      return null;
    } finally {
      try {
        zip?.close();
      } catch {
        // Best-effort close.
      }
    }
  }

  /**
   * Finds the `<img>` src for a figure caption in a parsed EPUB document.
   * Prefers a `<figure>` whose `<figcaption>` matches the label (the image is
   * inside that figure); otherwise matches a caption-like block and takes the
   * nearest preceding image, then the nearest following one.
   */
  private findEpubFigureImageSrc(
    doc: Document,
    parsed: { kind: FigureKind; num: string; canonical: string },
  ): string | null {
    const matches = (text: string): boolean => {
      const other = parseFigureLabel(text);
      return !!other && other.kind === parsed.kind && other.num === parsed.num;
    };

    // 1. Semantic <figure>/<figcaption>.
    const figures = Array.prototype.slice.call(
      doc.querySelectorAll("figure"),
    ) as Element[];
    for (const figure of figures) {
      const caption = figure.querySelector("figcaption");
      if (
        caption &&
        matches((caption.textContent ?? "").replace(/\s+/g, " "))
      ) {
        const img = figure.querySelector("img");
        const src = img?.getAttribute("src");
        if (src) return src;
      }
    }

    // 2. A caption-like block, then the nearest image by document position. A
    //    bare cross-reference link ("see Figure 3.5") is skipped by requiring
    //    the caption to carry text beyond the label itself.
    const imgs = Array.prototype.slice.call(
      doc.querySelectorAll("img"),
    ) as Element[];
    if (!imgs.length) return null;
    const blocks = Array.prototype.slice.call(
      doc.querySelectorAll("p, div, figcaption, caption"),
    ) as Element[];
    for (const block of blocks) {
      if (block.tagName.toLowerCase() === "a") continue;
      const text = (block.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!matches(text)) continue;
      if (text.length <= parsed.canonical.length + 3) continue;

      let prev: Element | null = null;
      let next: Element | null = null;
      for (const img of imgs) {
        const rel = block.compareDocumentPosition(img);
        if (rel & 2 /* PRECEDING */) prev = img;
        else if (rel & 4 /* FOLLOWING */ && !next) next = img;
      }
      const src =
        prev?.getAttribute("src") ?? next?.getAttribute("src") ?? null;
      if (src) return src;
    }
    return null;
  }

  private readZipEntryBytes(zip: ZipHandle, entry: string): Uint8Array | null {
    try {
      const stream = zip.getInputStream(entry);
      const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
        Ci.nsIBinaryInputStream,
      );
      binary.setInputStream(stream as never);
      const parts: number[][] = [];
      let total = 0;
      for (;;) {
        const available = binary.available();
        if (!available) break;
        const bytes = binary.readByteArray(Math.min(available, 1 << 20));
        if (!bytes.length) break;
        parts.push(bytes);
        total += bytes.length;
      }
      binary.close();
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    } catch {
      return null;
    }
  }

  /**
   * For a PDF reader, forces and waits for every page intersecting the visible
   * viewport to finish rendering (pdf.js `RenderingState.FINISHED` = 3), so a
   * subsequent capture is not blank. Best-effort and bounded by a timeout; a
   * no-op for readers without a pdf.js viewer (EPUB, snapshot).
   */
  private async waitForVisiblePdfPages(
    cwin: Window,
    timeoutMs = 3000,
  ): Promise<void> {
    try {
      const app = (cwin as unknown as { PDFViewerApplication?: unknown })
        .PDFViewerApplication;
      if (!app) return;
      const viewer = waiveXrays((app as { pdfViewer?: unknown }).pdfViewer) as {
        container?: { scrollTop: number; clientHeight: number };
        _pages?: {
          div?: { offsetTop: number; offsetHeight: number };
          renderingState?: number;
        }[];
        forceRendering?: () => void;
      };
      const container = viewer?.container;
      if (!viewer || !container) return;

      const visiblePending = (): boolean => {
        const top = container.scrollTop;
        const bottom = top + container.clientHeight;
        const pages = viewer._pages ?? [];
        for (const page of pages) {
          const el = page?.div;
          if (!el) continue;
          const elTop = el.offsetTop;
          const elBottom = elTop + el.offsetHeight;
          if (elBottom > top && elTop < bottom && page.renderingState !== 3) {
            return true;
          }
        }
        return false;
      };

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && visiblePending()) {
        try {
          viewer.forceRendering?.();
        } catch {
          // Rendering nudge is best-effort.
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    } catch (e) {
      this.log("WARN waitForVisiblePdfPages failed", e);
    }
  }

  /** Finds an open reader instance (tab or window) for the given attachment. */
  private findReaderByItemID(itemID: number): Record<string, unknown> | null {
    try {
      const readers = (
        Zotero as unknown as { Reader?: { _readers?: unknown[] } }
      ).Reader?._readers;
      if (!Array.isArray(readers)) return null;
      const found = (readers as Record<string, unknown>[]).find(
        (r) =>
          r && !r._isTabClosed && !r._isUninitialized && r.itemID === itemID,
      );
      return found ?? null;
    } catch {
      return null;
    }
  }

  private async openBackgroundReader(
    itemID: number,
  ): Promise<Record<string, unknown> | null> {
    try {
      await (
        Zotero as unknown as {
          Reader: {
            open(
              itemID: number,
              location?: unknown,
              options?: Record<string, unknown>,
            ): Promise<unknown>;
          };
        }
      ).Reader.open(itemID, null, { openInBackground: true });
    } catch (e) {
      this.log("WARN could not open background reader", itemID, e);
      return null;
    }

    // The reader initialises asynchronously; wait for its PDF document.
    for (let attempt = 0; attempt < 100; attempt++) {
      const reader = this.findReaderByItemID(itemID);
      if (reader && this.getReaderRenderContext(reader)) return reader;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.findReaderByItemID(itemID);
  }

  /**
   * Assembles what a render needs from an open reader: the iframe window (to
   * clone args into its scope), the reader's own `_pdfRenderer` and the loaded
   * PDF document, both waived out of their Xray wrappers so their methods are
   * callable. Null until the reader has finished loading its document.
   */
  private getReaderRenderContext(reader: Record<string, unknown>): {
    win: Window & typeof globalThis;
    renderer: {
      renderRegionCrops(
        pageIndex: number,
        rects: number[][],
      ): Promise<string[]>;
    };
    pdfDocument: {
      numPages: number;
      getPage(n: number): Promise<unknown>;
    };
  } | null {
    const internal = reader._internalReader as
      Record<string, unknown> | undefined;
    const primaryView = (internal?._primaryView ?? reader._primaryView) as
      Record<string, unknown> | undefined;
    if (!primaryView) return null;

    const win = primaryView._iframeWindow as
      | ({ PDFViewerApplication?: { pdfDocument?: unknown } } & Window)
      | undefined;
    const renderer = primaryView._pdfRenderer;
    if (!win || !renderer) return null;

    const app = win.PDFViewerApplication;
    const pdfDocument = app?.pdfDocument;
    if (!pdfDocument) return null;

    return {
      win: win as Window & typeof globalThis,
      renderer: waiveXrays(renderer) as {
        renderRegionCrops(
          pageIndex: number,
          rects: number[][],
        ): Promise<string[]>;
      },
      pdfDocument: waiveXrays(pdfDocument) as {
        numPages: number;
        getPage(n: number): Promise<unknown>;
      },
    };
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

  public async readEpubSpine(
    attachment: Zotero.Item,
  ): Promise<EpubSpine | null> {
    try {
      if (attachment.attachmentContentType !== "application/epub+zip") {
        return null;
      }
      const path = await this.getAttachmentPath(attachment);
      if (!path) return null;

      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
        Ci.nsIZipReader,
      );
      zip.open(file);

      try {
        const read = (entry: string): string => {
          const stream = zip.getInputStream(entry);
          const converter = Cc[
            "@mozilla.org/intl/converter-input-stream;1"
          ].createInstance(Ci.nsIConverterInputStream);
          converter.init(stream, "UTF-8", 0, 0);
          let text = "";
          const chunk: { value: string } = { value: "" };
          while (converter.readString(65536, chunk) !== 0) text += chunk.value;
          converter.close();
          return text;
        };

        const parser = new DOMParser();

        const container = parser.parseFromString(
          read("META-INF/container.xml"),
          "application/xml",
        );
        const opfPath = container
          .querySelector("rootfile")
          ?.getAttribute("full-path");
        if (!opfPath) return null;
        const opfDir = opfPath.includes("/")
          ? opfPath.replace(/[^/]+$/, "")
          : "";

        const opf = parser.parseFromString(read(opfPath), "application/xml");
        const packageElement = opf.documentElement;
        const spineElement = opf.querySelector("spine");
        if (!packageElement || !spineElement) return null;

        const spineElementChildIndex = Array.prototype.indexOf.call(
          packageElement.children,
          spineElement,
        );
        if (spineElementChildIndex < 0) return null;

        const manifest = new Map<string, string>();
        opf.querySelectorAll("manifest > item").forEach((item: Element) => {
          const id = item.getAttribute("id");
          const href = item.getAttribute("href");
          if (id && href) manifest.set(id, href);
        });

        const documents: EpubSpine["documents"] = [];
        const itemrefs = Array.prototype.slice.call(
          opf.querySelectorAll("spine > itemref"),
        ) as Element[];

        itemrefs.forEach((itemref, index) => {
          const idref = itemref.getAttribute("idref");
          const href = idref ? manifest.get(idref) : undefined;
          if (!href) return;

          const entry = resolveEpubPath(opfDir, href);
          let xhtml: string;
          try {
            xhtml = read(entry);
          } catch {
            // A spine item whose file is missing is skipped, not fatal: the rest
            // of the book still yields usable locations.
            return;
          }

          const doc = parser.parseFromString(xhtml, "application/xhtml+xml");
          if (doc.querySelector("parsererror") || !doc.documentElement) return;

          documents.push({
            index,
            root: doc.documentElement as unknown as CfiDomNode,
          });
        });

        if (!documents.length) return null;
        return { spineElementChildIndex, documents };
      } finally {
        zip.close();
      }
    } catch (e) {
      this.log("WARN readEpubSpine failed", attachment.key, e);
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

  public getOpenReaders(): ActiveReaderDetails[] {
    try {
      const zoteroAny = Zotero as unknown as {
        Reader?: { _readers?: unknown[] };
      };
      if (!Array.isArray(zoteroAny.Reader?._readers)) return [];
      const readers = zoteroAny.Reader._readers as Record<string, unknown>[];
      return readers
        .filter((r) => r && !r._isTabClosed && !r._isUninitialized)
        .map((r) => this.extractReaderDetails(r))
        .filter((r): r is ActiveReaderDetails => r !== null);
    } catch (e) {
      this.log("WARN failed to get open readers", e);
      return [];
    }
  }

  public getActiveReader(
    attachmentItemID?: number,
  ): ActiveReaderDetails | null {
    try {
      const zoteroAny = Zotero as unknown as {
        Reader?: {
          _readers?: unknown[];
          getByTabID?(tabID: string): unknown;
        };
        getMainWindow?(): {
          Zotero_Tabs?: { selectedID?: string };
        };
      };
      if (!Array.isArray(zoteroAny.Reader?._readers)) return null;
      const readers = zoteroAny.Reader._readers as Record<string, unknown>[];
      const openReaders = readers.filter(
        (r) => r && !r._isTabClosed && !r._isUninitialized,
      );
      if (!openReaders.length) return null;

      if (attachmentItemID !== undefined) {
        const found = openReaders.find((r) => r.itemID === attachmentItemID);
        return found ? this.extractReaderDetails(found) : null;
      }

      // 1. Check if the most recent active window is a standalone reader window
      try {
        const services =
          typeof Services !== "undefined"
            ? (Services as unknown as {
                wm?: { getMostRecentWindow(type: string | null): unknown };
              })
            : null;
        const win = services?.wm?.getMostRecentWindow(null) as
          { reader?: Record<string, unknown> } | undefined;
        if (
          win?.reader &&
          !win.reader._isTabClosed &&
          !win.reader._isUninitialized
        ) {
          return this.extractReaderDetails(win.reader);
        }
      } catch {
        // Fall through
      }

      // 2. Check main window selected tab
      try {
        const mainWin = zoteroAny.getMainWindow?.();
        const selectedID = mainWin?.Zotero_Tabs?.selectedID;
        if (selectedID && zoteroAny.Reader?.getByTabID) {
          const tabReader = zoteroAny.Reader.getByTabID(selectedID) as
            Record<string, unknown> | undefined;
          if (
            tabReader &&
            !tabReader._isTabClosed &&
            !tabReader._isUninitialized
          ) {
            return this.extractReaderDetails(tabReader);
          }
        }
      } catch {
        // Fall through
      }

      // 3. Fallback to the first open reader
      return this.extractReaderDetails(openReaders[0]);
    } catch (e) {
      this.log("WARN failed to get active reader", e);
      return null;
    }
  }

  public async openReader(input: ReaderOpenInput): Promise<void> {
    const zoteroAny = Zotero as unknown as {
      Reader?: {
        open(
          itemID: number,
          location?: unknown,
          options?: Record<string, unknown>,
        ): Promise<unknown>;
      };
    };
    if (!zoteroAny.Reader?.open) {
      throw new Error("Zotero.Reader is unavailable.");
    }

    const location =
      input.location && Object.keys(input.location).length
        ? input.location
        : null;

    await zoteroAny.Reader.open(input.itemID, location, {
      openInBackground: input.openInBackground ?? false,
      openInWindow: input.openInWindow ?? false,
      allowDuplicate: input.openInWindow ?? false,
    });
  }

  private extractReaderDetails(
    reader: Record<string, unknown>,
  ): ActiveReaderDetails | null {
    if (!reader || typeof reader.itemID !== "number") return null;

    const internal = reader._internalReader as
      Record<string, unknown> | undefined;
    const primaryView = (internal?._primaryView ?? reader._primaryView) as
      Record<string, unknown> | undefined;

    const primaryState = ((internal?._state as Record<string, unknown>)
      ?.primaryViewState ??
      (reader._state as Record<string, unknown>)?.primaryViewState ??
      reader._viewState ??
      {}) as Record<string, unknown>;

    let pageIndex =
      typeof primaryState.pageIndex === "number"
        ? primaryState.pageIndex
        : undefined;

    const pdfViewer = (
      primaryView?._iframeWindow as
        | { PDFViewerApplication?: { pdfViewer?: Record<string, unknown> } }
        | undefined
    )?.PDFViewerApplication?.pdfViewer;

    const totalPages =
      typeof pdfViewer?.pagesCount === "number"
        ? pdfViewer.pagesCount
        : undefined;

    if (
      pageIndex === undefined &&
      typeof pdfViewer?.currentPageNumber === "number"
    ) {
      pageIndex = pdfViewer.currentPageNumber - 1;
    }

    let pageLabel: string | undefined = undefined;
    if (pageIndex !== undefined) {
      if (typeof primaryView?._getPageLabel === "function") {
        try {
          pageLabel = (
            primaryView._getPageLabel as (idx: number, phys: boolean) => string
          )(pageIndex, true);
        } catch {
          // Ignore
        }
      }
      if (
        !pageLabel &&
        Array.isArray((internal?._state as Record<string, unknown>)?.pageLabels)
      ) {
        const labels = (internal?._state as { pageLabels: string[] })
          .pageLabels;
        if (labels[pageIndex]) pageLabel = String(labels[pageIndex]);
      }
    }

    let selection: ActiveReaderDetails["selection"] = null;

    // 1. Check selection popup
    const internalState = internal?._state as
      Record<string, unknown> | undefined;
    const lastView = internal?._lastView as Record<string, unknown> | undefined;

    const popup = (lastView?._selectionPopup ??
      (internal?._lastViewPrimary
        ? internalState?.primaryViewSelectionPopup
        : internalState?.secondaryViewSelectionPopup) ??
      internalState?.primaryViewSelectionPopup) as
      { annotation?: Record<string, unknown> } | undefined;

    if (popup?.annotation?.text) {
      const ann = popup.annotation;
      const annPos = ann.position as Record<string, unknown> | undefined;
      selection = {
        type: "text",
        text: String(ann.text).trim(),
        position: annPos,
        pageIndex:
          typeof annPos?.pageIndex === "number" ? annPos.pageIndex : pageIndex,
        pageLabel:
          typeof ann.pageLabel === "string" ? ann.pageLabel : pageLabel,
      };
    }

    // 2. Check PDF selection ranges
    if (
      !selection &&
      Array.isArray(primaryView?._selectionRanges) &&
      primaryView._selectionRanges.length > 0
    ) {
      const ranges = (
        primaryView._selectionRanges as Record<string, unknown>[]
      ).filter((r) => !r.collapsed && r.text);
      if (ranges.length > 0) {
        const firstPos = ranges[0].position as
          Record<string, unknown> | undefined;
        selection = {
          type: "text",
          text: ranges
            .map((r) => String(r.text))
            .join(" ")
            .trim(),
          position: firstPos,
          pageIndex:
            typeof ranges[0].pageIndex === "number"
              ? ranges[0].pageIndex
              : typeof firstPos?.pageIndex === "number"
                ? firstPos.pageIndex
                : pageIndex,
          pageLabel,
        };
      }
    }

    // 3. Check window / iframe DOM selection
    if (!selection) {
      try {
        const iframeWin = primaryView?._iframeWindow as
          | {
              getSelection?: () => { isCollapsed: boolean; toString(): string };
            }
          | undefined;
        const winSel = iframeWin?.getSelection?.();
        const selText =
          winSel && !winSel.isCollapsed ? winSel.toString().trim() : "";
        if (selText) {
          selection = {
            type: "text",
            text: selText,
            pageIndex,
            pageLabel,
          };
        }
      } catch {
        // Ignore
      }
    }

    // 4. Check selected annotation IDs
    if (!selection && Array.isArray(internalState?.selectedAnnotationIDs)) {
      const selectedIDs = internalState.selectedAnnotationIDs as unknown[];
      if (selectedIDs.length > 0 && Array.isArray(internalState?.annotations)) {
        const annId = selectedIDs[0];
        const annotations = internalState.annotations as Record<
          string,
          unknown
        >[];
        const ann = annotations.find((a) => a.id === annId);
        if (ann) {
          const annPos = ann.position as Record<string, unknown> | undefined;
          selection = {
            type: "annotation",
            text: String(ann.text ?? "").trim(),
            position: annPos,
            pageIndex:
              typeof annPos?.pageIndex === "number"
                ? annPos.pageIndex
                : pageIndex,
            pageLabel:
              typeof ann.pageLabel === "string" ? ann.pageLabel : pageLabel,
            annotationKey: typeof ann.id === "string" ? ann.id : undefined,
            annotationType: typeof ann.type === "string" ? ann.type : undefined,
            comment: typeof ann.comment === "string" ? ann.comment : undefined,
            color: typeof ann.color === "string" ? ann.color : undefined,
          };
        }
      }
    }

    return {
      readerID:
        typeof reader._instanceID === "string" ? reader._instanceID : undefined,
      tabID: typeof reader.tabID === "string" ? reader.tabID : undefined,
      itemID: reader.itemID as number,
      type: String(reader._type ?? reader.type ?? "pdf"),
      title: String(reader._title ?? ""),
      readOnly: Boolean(reader._readOnly || internalState?.readOnly),
      state: {
        pageIndex,
        cfi:
          typeof primaryState.cfi === "string" ? primaryState.cfi : undefined,
        scrollYPercent:
          typeof primaryState.scrollYPercent === "number"
            ? primaryState.scrollYPercent
            : undefined,
        scrollXPercent:
          typeof primaryState.scrollXPercent === "number"
            ? primaryState.scrollXPercent
            : undefined,
        scale:
          typeof primaryState.scale === "string" ||
          typeof primaryState.scale === "number"
            ? primaryState.scale
            : undefined,
        top:
          typeof primaryState.top === "number" ? primaryState.top : undefined,
        left:
          typeof primaryState.left === "number" ? primaryState.left : undefined,
        scrollMode:
          typeof primaryState.scrollMode === "number"
            ? primaryState.scrollMode
            : undefined,
        spreadMode:
          typeof primaryState.spreadMode === "number"
            ? primaryState.spreadMode
            : undefined,
      },
      selection,
      pageLabel,
      totalPages,
    };
  }
}

/** Minimal view of `nsIZipReader` used for EPUB image extraction. */
interface ZipHandle {
  open(file: unknown): void;
  close(): void;
  getInputStream(entry: string): unknown;
}

type FigureKind = "figure" | "table";

/**
 * Parses a figure/table label into its kind, number and a canonical display
 * form. Shared shape with FigureLocator, kept local to avoid a module cycle.
 */
function parseFigureLabel(
  label: string,
): { kind: FigureKind; num: string; canonical: string } | null {
  const match = label
    .toLowerCase()
    .match(/^\s*(figure|fig\.?|table|tbl\.?)\s*([0-9]+(?:[.-][0-9]+)*)/);
  if (!match) return null;
  const kind: FigureKind = match[1].startsWith("t") ? "table" : "figure";
  const canonical = `${kind === "table" ? "Table" : "Figure"} ${match[2]}`;
  return { kind, num: match[2], canonical };
}

/** Best-guess image MIME type from a file entry's extension. */
function mimeFromExtension(entry: string): string {
  const ext = entry.toLowerCase().replace(/^.*\./, "");
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

/**
 * Strips a Firefox Xray wrapper so a content object's own methods (pdf.js
 * pages, the reader's renderer) can be called from the plugin's chrome scope.
 */
function waiveXrays<T>(value: T): T {
  const cu = (Components as unknown as { utils?: { waiveXrays<U>(v: U): U } })
    .utils;
  return cu?.waiveXrays ? cu.waiveXrays(value) : value;
}

/**
 * Clones a plain value into a content window's scope, so content code (the
 * reader's renderer) can read it across the Xray boundary.
 */
function cloneInto<T>(value: T, targetWindow: unknown): T {
  const cu = (
    Components as unknown as {
      utils?: { cloneInto<U>(v: U, win: unknown): U };
    }
  ).utils;
  return cu?.cloneInto ? cu.cloneInto(value, targetWindow) : value;
}

/**
 * Reads a PNG's pixel dimensions from its base64 bytes by decoding the IHDR
 * chunk: an 8-byte signature, a 4-byte length and the "IHDR" tag, then the
 * big-endian width and height. Null when the header is too short to trust.
 */
function pngDimensions(
  base64: string,
): { width: number; height: number } | null {
  try {
    const header = atob(base64.slice(0, 44));
    if (header.length < 24) return null;
    const at = (i: number): number => header.charCodeAt(i) & 0xff;
    const width = (at(16) << 24) | (at(17) << 16) | (at(18) << 8) | at(19);
    const height = (at(20) << 24) | (at(21) << 16) | (at(22) << 8) | at(23);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Renders a snapshot's math for offline reading. A page fetched over HTTP keeps
 * its math as LaTeX inside `<math data-latex="…">` elements that the site's
 * client-side MathJax would have typeset; we never run that JS, so Temml turns
 * each into native MathML, which Gecko renders without scripts or fonts. A
 * LaTeX string Temml cannot parse is left as its original element.
 */
function renderSnapshotMath(html: string): string {
  return html.replace(
    /<math\b([^>]*)>[\s\S]*?<\/math>/gi,
    (whole, attrs: string) => {
      const latex = decodeHtmlEntities(
        /\bdata-latex="([^"]*)"/i.exec(attrs)?.[1] ?? "",
      ).trim();
      if (!latex) return whole;
      const displayMode = /display\s*=\s*"block"/i.test(attrs);
      try {
        return temml.renderToString(latex, {
          displayMode,
          throwOnError: false,
        });
      } catch {
        return whole;
      }
    },
  );
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Renders `$$…$$` and `$…$` math in Markdown source to MathML with Temml, so a
 * Markdown import displays equations like the web captures do. Fenced and inline
 * code spans are protected first so a `$` inside code is never treated as math;
 * a fragment Temml cannot parse is left as its original text.
 */
function renderMarkdownMath(markdown: string): string {
  const guarded: string[] = [];
  const stash = (text: string): string => {
    guarded.push(text);
    return `\uE001${guarded.length - 1}\uE001`;
  };

  let s = markdown
    .replace(/```[\s\S]*?```/g, stash)
    .replace(/~~~[\s\S]*?~~~/g, stash)
    .replace(/`[^`\n]+`/g, stash);

  const render = (latex: string, displayMode: boolean, original: string) => {
    const trimmed = latex.trim();
    if (!trimmed) return original;
    try {
      return temml.renderToString(trimmed, {
        displayMode,
        throwOnError: false,
      });
    } catch {
      return original;
    }
  };

  s = s
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, tex: string) => render(tex, true, m))
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, tex: string) => render(tex, true, m))
    .replace(/(?<![\\$])\$(?!\$)([^\n$]+?)\$(?!\$)/g, (m, tex: string) =>
      render(tex, false, m),
    )
    .replace(/\\\(([\s\S]+?)\\\)/g, (m, tex: string) => render(tex, false, m));

  return s.replace(/\uE001(\d+)\uE001/g, (_m, i: string) => guarded[Number(i)]);
}

/** A local file path as a `file://` URI, for a snapshot's source URL. */
function pathToFileUri(path: string): string {
  try {
    const zf = Zotero.File as unknown as { pathToFileURI?(p: string): string };
    if (typeof zf.pathToFileURI === "function") return zf.pathToFileURI(path);
  } catch {
    // Fall through to a manual construction.
  }
  const normalized = path.replace(/\\/g, "/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized)}`;
}

/**
 * Wraps clean article HTML in a minimal UTF-8 document so the saved snapshot
 * reads correctly. Without an explicit charset the bare fragment is decoded as
 * Latin-1 and non-ASCII text (e.g. CJK) turns to mojibake; the <article>
 * wrapper also gives the reader and any re-extraction a clear content root.
 */
function wrapSnapshotHtml(title: string, bodyHtml: string): string {
  const escaped = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="und"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escaped}</title>\n<style>${SNAPSHOT_STYLES}</style></head>\n` +
    `<body><article>${bodyHtml}</article></body></html>`
  );
}

/**
 * A self-contained reader theme for saved snapshots: system fonts (no network),
 * a comfortable measure, and light/dark support via color-scheme. Kept terse
 * because it is inlined into every snapshot.
 */
const SNAPSHOT_STYLES = `
:root{color-scheme:light dark;--fg:#1a1a1a;--muted:#6b7280;--bg:#ffffff;--accent:#2f6feb;--border:#e5e7eb;--code-bg:#f4f5f7;}
@media (prefers-color-scheme:dark){:root{--fg:#e6e6e6;--muted:#9aa4b2;--bg:#1b1e23;--accent:#6ea8fe;--border:#2c313a;--code-bg:#23272e;}}
html{font-size:18px;}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;}
article{max-width:44rem;margin:0 auto;padding:3rem 1.25rem 5rem;}
h1,h2,h3,h4,h5,h6{line-height:1.3;margin:2.2rem 0 .8rem;font-weight:650;}
article> :first-child{margin-top:0;}
h1{font-size:2rem;font-weight:700;}
h2{font-size:1.5rem;border-bottom:1px solid var(--border);padding-bottom:.3rem;}
h3{font-size:1.25rem;}
p{margin:0 0 1.1rem;}
a{color:var(--accent);text-decoration:none;}
a:hover{text-decoration:underline;}
img{max-width:100%;height:auto;border-radius:6px;display:block;margin:1.4rem auto;}
figure{margin:1.6rem 0;}
figcaption{color:var(--muted);font-size:.85em;text-align:center;margin-top:.5rem;}
blockquote{margin:1.4rem 0;padding:.4rem 1.1rem;border-left:3px solid var(--accent);color:var(--muted);}
code{background:var(--code-bg);padding:.15em .4em;border-radius:4px;font-size:.9em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
pre{background:var(--code-bg);padding:1rem 1.1rem;border-radius:8px;overflow:auto;line-height:1.5;}
pre code{background:none;padding:0;}
table{border-collapse:collapse;width:100%;margin:1.4rem 0;font-size:.95em;}
th,td{border:1px solid var(--border);padding:.5rem .7rem;text-align:left;}
th{background:var(--code-bg);}
hr{border:none;border-top:1px solid var(--border);margin:2.5rem 0;}
ul,ol{padding-left:1.4rem;margin:0 0 1.1rem;}
li{margin:.3rem 0;}
math{font-size:1.05em;}
math[display="block"]{display:block;overflow-x:auto;margin:1.3rem 0;}
`.trim();

/**
 * Base64-encodes raw bytes without exhausting the call stack: `btoa` needs a
 * binary string, and spreading a large `Uint8Array` into `fromCharCode` can
 * overflow, so the string is built in fixed-size chunks.
 */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Defuddle's bundled turndown picks its HTML parser at first use: it needs a
 * global `DOMParser` (Zotero has one lexically but not always on `globalThis`),
 * and it logs through a global `console`, which Zotero's module scope lacks.
 * Publish both to `globalThis` once so Markdown conversion neither falls back to
 * a missing `document` nor throws a ReferenceError.
 */
function ensureExtractionGlobals(): void {
  const scope = globalThis as unknown as {
    console?: unknown;
    DOMParser?: unknown;
  };
  if (!scope.DOMParser && typeof DOMParser !== "undefined") {
    scope.DOMParser = DOMParser;
  }
  if (scope.console) return;
  const sink = (...args: unknown[]): void => {
    try {
      Zotero.debug(args.map((a) => String(a)).join(" "));
    } catch {
      // Logging is best-effort; never let it break extraction.
    }
  };
  scope.console = {
    log: sink,
    info: sink,
    warn: sink,
    error: sink,
    debug: sink,
    trace: sink,
    group: sink,
    groupEnd: sink,
  };
}

/**
 * Resolves a manifest `href` (relative to the OPF's directory) to a zip entry
 * path, collapsing `.`/`..` and decoding percent-escapes so it matches the
 * archive's literal entry names.
 */
function resolveEpubPath(opfDir: string, href: string): string {
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    // A malformed escape means the href is used as-is; the read simply fails
    // and that spine item is skipped.
  }
  const segments = `${opfDir}${decoded}`.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}
