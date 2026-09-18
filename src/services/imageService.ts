/**
 * Image reading: hands an MCP client the actual pixels behind a Zotero object.
 *
 * Four sources, each resolved to base64 image bytes:
 *   - `annotation`: an area (image) or ink annotation's rendered region.
 *   - `attachment`: an image attachment's file (e.g. an EPUB-embedded image).
 *   - `page`: a PDF page rendered through the reader's PDF.js engine.
 *   - `reader`: the reader's currently visible viewport (scroll, zoom and
 *     cross-page views included), captured from any open reader.
 *   - `region`: an explicit rectangle of a PDF page, cropped and rendered.
 *   - `figure`: a figure or table located automatically from Zotero 10's
 *     Structured Document Text layout model, then cropped like `region`.
 *
 * The privileged rendering and file IO live on the gateway; this service only
 * validates the request, picks the source and shapes the result.
 */

import {
  FileMissingError,
  InvalidArgumentError,
  UnsupportedAttachmentError,
} from "../errors";
import { EPUB_CONTENT_TYPE, PDF_CONTENT_TYPE } from "./documentTextService";
import type { FigureLocator } from "./figureLocator";
import type { ItemResolver } from "./itemResolver";
import type { ZoteroGateway } from "./zoteroGateway";

export type ImageSource =
  "annotation" | "attachment" | "page" | "reader" | "region" | "figure";

export const IMAGE_SOURCES: ImageSource[] = [
  "annotation",
  "attachment",
  "page",
  "reader",
  "region",
  "figure",
];

export interface ImageReadOptions {
  source: ImageSource;
  /** Attachment key, for the `attachment`, `page`, `reader`, `region` and `figure` sources. */
  attachmentKey?: unknown;
  /** Annotation key, for the `annotation` source. */
  annotationKey?: unknown;
  /** 1-based page number, for the `page` and `region` sources (optional for `figure`). */
  page?: unknown;
  /** Page-coordinate rectangle [x1, y1, x2, y2], for the `region` source. */
  rect?: unknown;
  /** Figure or table label to locate, for the `figure` source, e.g. "Figure 1". */
  figure?: unknown;
}

export interface ImageReadResult {
  source: ImageSource;
  mimeType: string;
  /** Base64-encoded image bytes, without a data-URI prefix. */
  base64: string;
  attachmentKey?: string;
  annotationKey?: string;
  page?: number;
  bytes?: number;
  width?: number;
  height?: number;
  /** For `figure`: the matched label and the rect that was rendered. */
  label?: string;
  rect?: [number, number, number, number];
}

/** Cap on an attachment image handed back inline, to keep responses sane. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export class ImageService {
  public constructor(
    private readonly gateway: ZoteroGateway,
    private readonly resolver: ItemResolver,
    private readonly figures: FigureLocator,
  ) {}

  public async read(options: ImageReadOptions): Promise<ImageReadResult> {
    switch (options.source) {
      case "annotation":
        return this.readAnnotation(options.annotationKey);
      case "attachment":
        return this.readAttachment(options.attachmentKey);
      case "page":
        return this.readPage(options.attachmentKey, options.page);
      case "reader":
        return this.readReader(options.attachmentKey);
      case "region":
        return this.readRegion(
          options.attachmentKey,
          options.page,
          options.rect,
        );
      case "figure":
        return this.readFigure(
          options.attachmentKey,
          options.figure,
          options.page,
        );
      default:
        throw new InvalidArgumentError(
          `Unknown source ${JSON.stringify(options.source)}: expected one of ` +
            `${IMAGE_SOURCES.join(", ")}.`,
        );
    }
  }

  private async readAnnotation(key: unknown): Promise<ImageReadResult> {
    const annotation = await this.resolver.resolveItem(key);
    if (String(annotation.itemType) !== "annotation") {
      throw new InvalidArgumentError(
        `Item "${annotation.key}" is not an annotation (item type ` +
          `"${annotation.itemType}").`,
      );
    }
    const annType = (annotation as unknown as { annotationType?: string })
      .annotationType;
    if (annType !== "image" && annType !== "ink") {
      throw new InvalidArgumentError(
        `Annotation "${annotation.key}" is a "${annType ?? "unknown"}" ` +
          `annotation and has no image; only image and ink annotations do.`,
      );
    }

    const base64 = await this.gateway.renderAnnotationImage(annotation);
    if (!base64) {
      throw new FileMissingError(annotation.key, null);
    }
    return {
      source: "annotation",
      annotationKey: annotation.key,
      mimeType: "image/png",
      base64,
    };
  }

  private async readAttachment(key: unknown): Promise<ImageReadResult> {
    const attachment = await this.resolver.resolveAttachment(key);
    const contentType = attachment.attachmentContentType;
    if (!contentType || !contentType.startsWith("image/")) {
      throw new UnsupportedAttachmentError(
        attachment.key,
        contentType ?? null,
        "an image attachment (content type image/*)",
      );
    }

    const path = await this.gateway.getAttachmentPath(attachment);
    if (!path) {
      throw new FileMissingError(attachment.key, null);
    }

    const file = await this.gateway.readBinaryFileAsBase64(
      path,
      MAX_ATTACHMENT_BYTES,
    );
    if (!file) {
      throw new FileMissingError(attachment.key, path);
    }

    return {
      source: "attachment",
      attachmentKey: attachment.key,
      mimeType: contentType,
      base64: file.base64,
      bytes: file.bytes,
    };
  }

  private async readPage(
    key: unknown,
    page: unknown,
  ): Promise<ImageReadResult> {
    const attachment = await this.resolver.resolveAttachment(key);
    this.assertPdf(attachment);
    const pageIndex = this.pageIndex(page);

    const rendered = await this.gateway.renderPdfPageImage(
      attachment.id,
      pageIndex,
      { openIfNeeded: true },
    );
    if (!rendered) {
      throw new InvalidArgumentError(
        `Could not render page ${pageIndex + 1} of attachment ` +
          `"${attachment.key}". The page may not exist, or the PDF could not ` +
          `be opened in a reader.`,
      );
    }

    return {
      source: "page",
      attachmentKey: attachment.key,
      page: pageIndex + 1,
      mimeType: rendered.mimeType,
      base64: rendered.base64,
      width: rendered.width,
      height: rendered.height,
    };
  }

  private async readReader(key: unknown): Promise<ImageReadResult> {
    let targetItemID: number | undefined;
    let attachment: Zotero.Item | undefined;
    if (key !== undefined && key !== null) {
      attachment = await this.resolver.resolveAttachment(key);
      targetItemID = attachment.id;
    }

    const active = this.gateway.getActiveReader(targetItemID);
    if (!active) {
      throw new InvalidArgumentError(
        key
          ? `Attachment "${(key as string) ?? ""}" is not open in any reader.`
          : "No reader is currently open in Zotero.",
      );
    }

    const item = attachment ?? this.gateway.getItemByID(active.itemID);
    if (!item) {
      throw new InvalidArgumentError(
        `Reader attachment ${active.itemID} could not be loaded.`,
      );
    }
    this.resolver.assertUserLibraryObject("item", item.key, item.libraryID);

    // Capture exactly what the reader is showing — scroll position, zoom and
    // continuous cross-page views included — rather than a flat page render.
    const rendered = await this.gateway.captureReaderViewport(item.id);
    if (!rendered) {
      throw new InvalidArgumentError(
        `Could not capture the current view of reader "${item.key}".`,
      );
    }

    const pageIndex = active.state?.pageIndex;
    return {
      source: "reader",
      attachmentKey: item.key,
      ...(pageIndex === undefined ? {} : { page: pageIndex + 1 }),
      mimeType: rendered.mimeType,
      base64: rendered.base64,
      width: rendered.width,
      height: rendered.height,
    };
  }

  private async readRegion(
    key: unknown,
    page: unknown,
    rect: unknown,
  ): Promise<ImageReadResult> {
    const attachment = await this.resolver.resolveAttachment(key);
    this.assertPdf(attachment);
    const pageIndex = this.pageIndex(page);
    const parsed = this.parseRect(rect);

    const rendered = await this.gateway.renderPdfRegionImage(
      attachment.id,
      pageIndex,
      parsed,
      { openIfNeeded: true },
    );
    if (!rendered) {
      throw new InvalidArgumentError(
        `Could not render the region ${JSON.stringify(parsed)} on page ` +
          `${pageIndex + 1} of attachment "${attachment.key}".`,
      );
    }

    return {
      source: "region",
      attachmentKey: attachment.key,
      page: pageIndex + 1,
      rect: parsed,
      mimeType: rendered.mimeType,
      base64: rendered.base64,
      width: rendered.width,
      height: rendered.height,
    };
  }

  private async readFigure(
    key: unknown,
    figure: unknown,
    page: unknown,
  ): Promise<ImageReadResult> {
    const attachment = await this.resolver.resolveAttachment(key);
    if (typeof figure !== "string" || !figure.trim()) {
      throw new InvalidArgumentError(
        '"figure" must be a label such as "Figure 1" or "Table 2".',
      );
    }
    const label = figure.trim();
    const contentType = attachment.attachmentContentType;

    // An EPUB has no page geometry to render; its figures are embedded image
    // files, so the graphic is pulled straight from the EPUB zip.
    if (contentType === EPUB_CONTENT_TYPE) {
      const found = await this.gateway.extractEpubFigureImage(
        attachment,
        label,
      );
      if (!found) {
        throw new InvalidArgumentError(
          `Could not locate "${figure}" in EPUB "${attachment.key}". The label ` +
            `may not match a figure caption, or the figure is not an embedded ` +
            `image.`,
        );
      }
      return {
        source: "figure",
        attachmentKey: attachment.key,
        label: found.label,
        mimeType: found.mimeType,
        base64: found.base64,
      };
    }

    this.assertPdf(attachment);
    const restrictPage =
      page === undefined || page === null ? undefined : this.pageIndex(page);

    const located = await this.locateFigure(attachment, label, restrictPage);
    if (!located) {
      throw new InvalidArgumentError(
        `Could not locate "${figure}" in attachment "${attachment.key}". ` +
          `The document may have no Structured Document Text layout, or the ` +
          `label may not match a caption. Pass a page and rect instead.`,
      );
    }

    const rendered = await this.gateway.renderPdfRegionImage(
      attachment.id,
      located.pageIndex,
      located.rect,
      { openIfNeeded: true },
    );
    if (!rendered) {
      throw new InvalidArgumentError(
        `Located "${located.label}" on page ${located.pageIndex + 1} but could ` +
          `not render its region in attachment "${attachment.key}".`,
      );
    }

    return {
      source: "figure",
      attachmentKey: attachment.key,
      label: located.label,
      page: located.pageIndex + 1,
      rect: located.rect,
      mimeType: rendered.mimeType,
      base64: rendered.base64,
      width: rendered.width,
      height: rendered.height,
    };
  }

  private async locateFigure(
    attachment: Zotero.Item,
    label: string,
    restrictPage?: number,
  ): Promise<{
    label: string;
    pageIndex: number;
    rect: [number, number, number, number];
  } | null> {
    return this.figures.locate(attachment.id, label, restrictPage);
  }

  private parseRect(rect: unknown): [number, number, number, number] {
    if (
      !Array.isArray(rect) ||
      rect.length !== 4 ||
      rect.some((n) => typeof n !== "number" || !Number.isFinite(n))
    ) {
      throw new InvalidArgumentError(
        `"rect" must be four finite numbers [x1, y1, x2, y2] in PDF user ` +
          `space, got ${JSON.stringify(rect)}.`,
      );
    }
    const [ax, ay, bx, by] = rect as number[];
    const x1 = Math.min(ax, bx);
    const y1 = Math.min(ay, by);
    const x2 = Math.max(ax, bx);
    const y2 = Math.max(ay, by);
    if (!(x2 > x1) || !(y2 > y1)) {
      throw new InvalidArgumentError(
        `"rect" has zero area: ${JSON.stringify(rect)}.`,
      );
    }
    return [x1, y1, x2, y2];
  }

  private assertPdf(attachment: Zotero.Item): void {
    if (attachment.attachmentContentType !== PDF_CONTENT_TYPE) {
      throw new UnsupportedAttachmentError(
        attachment.key,
        attachment.attachmentContentType ?? null,
        "a PDF attachment",
      );
    }
  }

  private pageIndex(page: unknown): number {
    const num = Number(page);
    if (!Number.isInteger(num) || num < 1) {
      throw new InvalidArgumentError(
        `"page" must be a 1-based integer page number, got ${JSON.stringify(page)}.`,
      );
    }
    return num - 1;
  }
}
