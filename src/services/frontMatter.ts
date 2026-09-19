/**
 * Minimal YAML front-matter support for Markdown imports.
 *
 * Only the small subset a note's front matter actually uses is parsed: a
 * leading `--- … ---` block of `key: value` lines, inline `[a, b]` arrays and
 * indented `- item` lists. Anything more elaborate is ignored rather than
 * pulling in a YAML dependency.
 */

export interface FrontMatter {
  data: Record<string, string | string[]>;
  body: string;
}

const FRONT_MATTER = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

export function extractFrontMatter(markdown: string): FrontMatter {
  const match = FRONT_MATTER.exec(markdown);
  if (!match) return { data: {}, body: markdown };
  return {
    data: parseBlock(match[1]),
    body: markdown.slice(match[0].length).replace(/^\r?\n+/, ""),
  };
}

function parseBlock(block: string): Record<string, string | string[]> {
  const data: Record<string, string | string[]> = {};
  const lines = block.split(/\r?\n/);
  let key: string | null = null;
  let list: string[] | null = null;

  const commit = () => {
    if (key && list) data[key] = list;
    list = null;
  };

  for (const line of lines) {
    if (!line.trim()) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && key) {
      (list ??= []).push(unquote(item[1]));
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    commit();
    key = pair[1];
    const value = pair[2].trim();

    if (value === "") {
      // Value continues as an indented list on the following lines.
      list = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((entry) => unquote(entry.trim()))
        .filter(Boolean);
    } else {
      data[key] = unquote(value);
    }
  }
  commit();
  return data;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export interface MappedMetadata {
  fields: Record<string, string>;
  creators: { creatorType: "author"; name: string }[];
  tags: string[];
}

/**
 * Maps common front-matter keys onto Zotero fields and creators. The caller is
 * responsible for only applying fields the target item type actually has.
 */
export function frontMatterToMetadata(
  data: Record<string, string | string[]>,
): MappedMetadata {
  const first = (value: string | string[] | undefined): string =>
    Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  const many = (value: string | string[] | undefined): string[] =>
    Array.isArray(value) ? value : value ? [value] : [];

  const fields: Record<string, string> = {};
  const title = first(data.title);
  if (title) fields.title = title;

  const date = first(data.published ?? data.date);
  if (date) fields.date = date;

  const url = first(data.url);
  if (url) fields.url = url;

  const abstract = first(data.abstract ?? data.description ?? data.summary);
  if (abstract) fields.abstractNote = abstract;

  const source = first(data.source ?? data.site ?? data.publication);
  if (source) {
    fields.websiteTitle = source;
    fields.publicationTitle = source;
    fields.blogTitle = source;
  }

  const authors = many(data.authors ?? data.author);
  const creators = authors
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ creatorType: "author" as const, name }));

  const tags = many(data.tags ?? data.keywords)
    .map((tag) => tag.trim())
    .filter(Boolean);

  return { fields, creators, tags };
}
