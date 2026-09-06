/**
 * Typed errors. Every one carries a message that names the offending value, so
 * a caller can act on it without a second lookup (spec E-1).
 */

export type ZotmcpErrorCode =
  | "not_found"
  | "group_library_unsupported"
  | "no_text_layer"
  | "invalid_argument"
  | "file_missing"
  | "timeout"
  | "unsupported_attachment"
  | "internal";

export class ZotmcpError extends Error {
  public readonly code: ZotmcpErrorCode;

  constructor(code: ZotmcpErrorCode, message: string) {
    super(message);
    this.name = "ZotmcpError";
    this.code = code;
  }
}

export class NotFoundError extends ZotmcpError {
  constructor(kind: string, key: string | number) {
    super("not_found", `No ${kind} found for key "${key}" in My Library.`);
    this.name = "NotFoundError";
  }
}

/**
 * Zotero item keys are unique per library, not globally. A group key must never
 * fall through to a same-keyed My Library object, so the resolver refuses it
 * explicitly rather than returning the wrong object (spec LB-2).
 */
export class GroupLibraryUnsupportedError extends ZotmcpError {
  constructor(kind: string, key: string | number, libraryID: number) {
    super(
      "group_library_unsupported",
      `The ${kind} "${key}" belongs to library ${libraryID}, not My Library. ` +
        `Group libraries are not supported.`,
    );
    this.name = "GroupLibraryUnsupportedError";
  }
}

export class NoTextLayerError extends ZotmcpError {
  constructor(key: string) {
    super(
      "no_text_layer",
      `Attachment "${key}" has no extractable text. It is most likely a ` +
        `scanned PDF with no text layer; run OCR before reading it.`,
    );
    this.name = "NoTextLayerError";
  }
}

export class InvalidArgumentError extends ZotmcpError {
  constructor(message: string) {
    super("invalid_argument", message);
    this.name = "InvalidArgumentError";
  }
}

export class FileMissingError extends ZotmcpError {
  constructor(key: string, path: string | null) {
    super(
      "file_missing",
      path
        ? `Attachment "${key}" points at "${path}", which does not exist on disk.`
        : `Attachment "${key}" has no file on disk.`,
    );
    this.name = "FileMissingError";
  }
}

export class TimeoutError extends ZotmcpError {
  constructor(what: string, ms: number) {
    super("timeout", `${what} did not finish within ${ms} ms.`);
    this.name = "TimeoutError";
  }
}

export class UnsupportedAttachmentError extends ZotmcpError {
  constructor(key: string, contentType: string | null, expected: string) {
    super(
      "unsupported_attachment",
      `Attachment "${key}" has content type "${contentType ?? "unknown"}"; ` +
        `this operation requires ${expected}.`,
    );
    this.name = "UnsupportedAttachmentError";
  }
}

export function isZotmcpError(value: unknown): value is ZotmcpError {
  return value instanceof ZotmcpError;
}

/** Message for any thrown value, for surfacing as a tool error. */
export function describeError(value: unknown): string {
  if (isZotmcpError(value) || value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
