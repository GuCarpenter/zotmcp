/**
 * Search. Every mode is a translation from tool arguments to Zotero search
 * conditions — this module owns no matching logic of its own.
 *
 * Verified against Zotero 10's `searchConditions.js`:
 * - `resultLevel` carries the level in the *operator* (`'item'`, `'annotation'`,
 *   …), like `joinMode`. It replaces the old resolve-to-parents dance for
 *   conditions that match children.
 * - `addCondition`'s legacy `required` argument now throws, so it is never
 *   passed; boolean structure uses `groupStart`/`groupEnd` + `joinMode`.
 * - `fulltextWord` is gone; `fulltextContent` is index-backed.
 * - `deleted` takes the operator `true`/`false` and no value.
 */

import { InvalidArgumentError } from "../errors";
import type { ItemResolver } from "./itemResolver";
import type { SearchHandle, ZoteroGateway } from "./zoteroGateway";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const SNIPPET_RADIUS = 120;

export type SearchMode =
  "keyword" | "conditions" | "tag" | "citationKey" | "fulltext" | "annotation";

export interface SearchCondition {
  condition: string;
  operator: string;
  value?: string;
}

export interface SearchInput {
  mode?: SearchMode;
  query?: string;
  conditions?: SearchCondition[];
  joinMode?: "all" | "any";
  itemType?: string;
  collectionKey?: string;
  deleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchOutcome {
  itemIDs: number[];
  /** Total matches before pagination, so a caller knows more exist. */
  total: number;
  limit: number;
  offset: number;
  /** Set when a mode could not run as asked but produced a usable answer. */
  note?: string;
}

export class SearchService {
  constructor(
    private readonly gateway: ZoteroGateway,
    private readonly resolver: ItemResolver,
  ) {}

  public normalizeLimit(limit: unknown): number {
    if (limit === undefined || limit === null) return DEFAULT_LIMIT;
    const value = Number(limit);
    if (!Number.isFinite(value) || value < 1) {
      throw new InvalidArgumentError(
        `Invalid limit ${JSON.stringify(limit)}: expected a number from 1 to ${MAX_LIMIT}.`,
      );
    }
    return Math.min(Math.floor(value), MAX_LIMIT);
  }

  public normalizeOffset(offset: unknown): number {
    if (offset === undefined || offset === null) return 0;
    const value = Number(offset);
    if (!Number.isFinite(value) || value < 0) {
      throw new InvalidArgumentError(
        `Invalid offset ${JSON.stringify(offset)}: expected a number >= 0.`,
      );
    }
    return Math.floor(value);
  }

  public async run(input: SearchInput): Promise<SearchOutcome> {
    const limit = this.normalizeLimit(input.limit);
    const offset = this.normalizeOffset(input.offset);
    const mode: SearchMode = input.mode ?? "keyword";

    const search = this.gateway.createSearch(this.gateway.userLibraryID);
    let note: string | undefined;

    // Trash is opt-in: Zotero excludes deleted items unless asked, and a caller
    // listing the trash wants only the trash.
    if (input.deleted) search.addCondition("deleted", "true");
    if (input.itemType) search.addCondition("itemType", "is", input.itemType);
    if (input.collectionKey) {
      const collection = await this.resolver.resolveCollection(
        input.collectionKey,
      );
      search.addCondition("collection", "is", collection.key);
      search.addCondition("recursive", "true");
    }

    switch (mode) {
      case "keyword":
        this.applyKeyword(search, this.requireQuery(input, mode));
        break;
      case "conditions":
        this.applyConditions(search, input);
        break;
      case "tag":
        this.applyTag(search, this.requireQuery(input, mode), input.joinMode);
        break;
      case "citationKey":
        note = this.applyCitationKey(search, this.requireQuery(input, mode));
        break;
      case "fulltext":
        this.applyFullText(search, this.requireQuery(input, mode));
        break;
      case "annotation":
        this.applyAnnotation(search, input);
        break;
      default:
        throw new InvalidArgumentError(
          `Unknown search mode ${JSON.stringify(mode)}.`,
        );
    }

    const all = await search.search();
    return {
      itemIDs: all.slice(offset, offset + limit),
      total: all.length,
      limit,
      offset,
      ...(note ? { note } : {}),
    };
  }

  /** Ranked metadata search over title, creators, year and citation key. */
  private applyKeyword(search: SearchHandle, query: string): void {
    search.addCondition("quicksearch-titleCreatorYear", "contains", query);
  }

  private applyConditions(search: SearchHandle, input: SearchInput): void {
    const conditions = input.conditions ?? [];
    if (!conditions.length) {
      throw new InvalidArgumentError(
        "Mode 'conditions' requires a non-empty conditions array.",
      );
    }

    // A single group keeps the caller's joinMode from leaking into the
    // library/trash conditions applied above.
    search.addCondition("groupStart", "true");
    search.addCondition("joinMode", input.joinMode ?? "all");
    for (const item of conditions) {
      if (!item || typeof item.condition !== "string" || !item.condition) {
        throw new InvalidArgumentError(
          `Each condition needs a string "condition": got ${JSON.stringify(item)}.`,
        );
      }
      if (typeof item.operator !== "string" || !item.operator) {
        throw new InvalidArgumentError(
          `Condition "${item.condition}" needs a string "operator".`,
        );
      }
      search.addCondition(item.condition, item.operator, item.value);
    }
    search.addCondition("groupEnd", "true");
  }

  /**
   * Boolean tag expressions. `AND` is Zotero's default join, `OR` becomes a
   * group with `joinMode any`, and a leading `-`/`NOT` becomes `isNot`.
   */
  private applyTag(
    search: SearchHandle,
    query: string,
    joinMode?: "all" | "any",
  ): void {
    const orParts = query
      .split(/\s+OR\s+/i)
      .map((part) => part.trim())
      .filter(Boolean);

    const useAny = joinMode === "any" || orParts.length > 1;
    search.addCondition("groupStart", "true");
    search.addCondition("joinMode", useAny ? "any" : "all");

    for (const part of orParts) {
      const terms = part
        .split(/\s+AND\s+/i)
        .map((term) => term.trim())
        .filter(Boolean);
      for (const term of terms) {
        const negated = /^(?:-|NOT\s+)/i.test(term);
        const tag = term.replace(/^(?:-|NOT\s+)/i, "").trim();
        if (!tag) continue;
        search.addCondition("tag", negated ? "isNot" : "is", tag);
      }
    }

    search.addCondition("groupEnd", "true");
  }

  /**
   * Citation keys live in `Extra` when supplied by Better BibTeX. Zotero's own
   * `citationKey` condition is tried first; when it is unavailable the search
   * falls back to `Extra`, and the caller is told which path answered.
   */
  private applyCitationKey(
    search: SearchHandle,
    key: string,
  ): string | undefined {
    try {
      search.addCondition("citationKey", "is", key);
      return undefined;
    } catch {
      search.addCondition("extra", "contains", key);
      return (
        "Zotero has no citation-key index here, so the key was matched against " +
        "the Extra field. Install Better BibTeX for exact citation-key lookup."
      );
    }
  }

  /**
   * Full-text matches are attachments, so `resultLevel: 'item'` rolls them up to
   * the owning item — the supported replacement for resolving parents by hand.
   */
  private applyFullText(search: SearchHandle, query: string): void {
    search.addCondition("resultLevel", "item");
    search.addCondition("fulltextContent", "contains", query);
  }

  /** Annotation hits are returned as annotations so page and colour survive. */
  private applyAnnotation(search: SearchHandle, input: SearchInput): void {
    search.addCondition("resultLevel", "annotation");

    const filters: SearchCondition[] = [];
    if (input.query) {
      filters.push({
        condition: "annotationText",
        operator: "contains",
        value: input.query,
      });
    }
    for (const condition of input.conditions ?? []) {
      filters.push(condition);
    }

    if (!filters.length) {
      throw new InvalidArgumentError(
        "Mode 'annotation' requires a query or at least one condition " +
          "(annotationColor, annotationComment, tag, …).",
      );
    }

    search.addCondition("groupStart", "true");
    search.addCondition("joinMode", input.joinMode ?? "all");
    for (const filter of filters) {
      search.addCondition(filter.condition, filter.operator, filter.value);
    }
    search.addCondition("groupEnd", "true");
  }

  private requireQuery(input: SearchInput, mode: SearchMode): string {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) {
      throw new InvalidArgumentError(`Mode '${mode}' requires a query string.`);
    }
    return query;
  }

  /**
   * Cuts a bounded snippet around the first match in an attachment's cached
   * extracted text. Absent cache means no snippet, never no result.
   */
  public async snippetFor(
    attachment: Zotero.Item,
    query: string,
  ): Promise<string | null> {
    const path = this.gateway.fulltextCachePath(attachment);
    if (!path) return null;

    let text: string;
    try {
      text = await this.gateway.readTextFile(path, 1_000_000);
    } catch {
      return null;
    }

    return cutSnippet(text, query);
  }
}

export function cutSnippet(
  text: string,
  query: string,
  radius = SNIPPET_RADIUS,
): string | null {
  if (!text || !query) return null;

  const haystack = text.toLowerCase();
  // Try the whole phrase, then its longest word, so a multi-word query still
  // lands somewhere useful.
  const candidates = [
    query,
    ...query.split(/\s+/).sort((a, b) => b.length - a.length),
  ]
    .map((term) => term.toLowerCase().trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const at = haystack.indexOf(candidate);
    if (at === -1) continue;

    const start = Math.max(0, at - radius);
    const end = Math.min(text.length, at + candidate.length + radius);
    const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
    return `${start > 0 ? "…" : ""}${snippet}${end < text.length ? "…" : ""}`;
  }

  return null;
}
