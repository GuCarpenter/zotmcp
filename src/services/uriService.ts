/**
 * All `zotero://` construction lives here.
 *
 * Only the `library` path segment is ever emitted, because the plugin supports
 * My Library only — there is no group branch to get wrong (spec U-5). Page
 * numbers are converted to 1-based at this boundary: Zotero stores a 0-based
 * `pageIndex` internally, while the URI form expects a 1-based `page`.
 */

export interface ItemUris {
  select: string;
  /** Attachments only: opens the file in its handler. */
  open?: string;
  /** PDF attachments only: opens Zotero's PDF reader. */
  openPdf?: string;
}

const LIBRARY_PATH = "library";

export function buildSelectUri(itemKey: string): string {
  return `zotero://select/${LIBRARY_PATH}/items/${itemKey}`;
}

export function buildCollectionSelectUri(collectionKey: string): string {
  return `zotero://select/${LIBRARY_PATH}/collections/${collectionKey}`;
}

export function buildOpenUri(
  attachmentKey: string,
  params?: UriLocation,
): string {
  return withParams(
    `zotero://open/${LIBRARY_PATH}/items/${attachmentKey}`,
    params,
  );
}

export function buildOpenPdfUri(
  attachmentKey: string,
  params?: UriLocation,
): string {
  return withParams(
    `zotero://open-pdf/${LIBRARY_PATH}/items/${attachmentKey}`,
    params,
  );
}

export interface UriLocation {
  /** 1-based page number, as the URI form expects. */
  page?: number;
  /** Zotero's 0-based reader page index; converted to `page` here. */
  pageIndex?: number;
  annotationKey?: string;
}

function withParams(base: string, location?: UriLocation): string {
  if (!location) return base;

  const params: string[] = [];

  const page =
    typeof location.page === "number"
      ? location.page
      : typeof location.pageIndex === "number"
        ? location.pageIndex + 1
        : undefined;
  if (typeof page === "number" && Number.isFinite(page) && page > 0) {
    params.push(`page=${Math.floor(page)}`);
  }

  if (location.annotationKey) {
    params.push(`annotation=${location.annotationKey}`);
  }

  return params.length ? `${base}?${params.join("&")}` : base;
}

/** Attachment-aware URI set. `contentType` decides whether `openPdf` applies. */
export function buildItemUris(input: {
  key: string;
  isAttachment: boolean;
  contentType?: string | null;
  location?: UriLocation;
}): ItemUris {
  const uris: ItemUris = { select: buildSelectUri(input.key) };

  if (input.isAttachment) {
    uris.open = buildOpenUri(input.key, input.location);
    if (input.contentType === "application/pdf") {
      uris.openPdf = buildOpenPdfUri(input.key, input.location);
    }
  }

  return uris;
}
