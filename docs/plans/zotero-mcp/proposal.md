# Proposal: Zotero MCP Plugin (`zotmcp`)

## Problem

LLM clients need a reliable MCP interface to search, read, annotate, organize,
and modify a Zotero library. Zotero exposes none of this to MCP clients today.
The project provides it from inside Zotero through the internal Zotero
JavaScript API, keeping the tool surface small and focused on Zotero's own core
functions.

## Goals

- Ship a Zotero 10 plugin with an embedded MCP server.
- Implement MCP `tools/list`, `tools/call`, and MCP resources over Streamable
  HTTP, served from Zotero's own HTTP server on its existing port.
- Provide lexical metadata and full-text search with no embedding or vector
  dependency.
- Provide item, collection, attachment, PDF/EPUB, annotation, note, import, tag,
  relation, duplicate, trash, and restore operations selected in `FEATURES.md`.
- Return `zotero://` navigation and reader links, including PDF page and
  annotation targets.
- Keep the surface compact by combining related operations behind explicit modes
  and operation kinds instead of many narrow tools.
- Let local clients perform writes and privileged scripts with no approval-card
  workflow.

## Non-Goals

- Operation while Zotero is closed.
- Group libraries, multi-library management, or runtime library switching.
- Semantic/vector search, embeddings, ANN indexes, or hybrid ranking.
- External scholarly search or any external bibliographic discovery service
  (OpenAlex, arXiv, Europe PMC, Semantic Scholar, Scite) — unrelated to Zotero
  core functions.
- Citation-graph traversal, retraction checks, citation metrics.
- RSS feeds, MCP prompts, ChatGPT connector compatibility, standalone CLI,
  Docker packaging, client configuration generation.
- MinerU, PDF Inspector, Poppler, or any external document-conversion runtime.
- Automatic citation-to-Related-item linking.
- A plugin-owned durable change journal, multi-step revert, write approval
  cards. (Zotero 10's own undo stack is used instead — see Decisions.)
- Third-party plugin tool registration.

## Scope

### Server and access

- Zotero plugin with the MCP endpoint registered on **Zotero's own HTTP server**
  (default port 23119, read from `extensions.zotero.httpServer.port` at runtime).
  No separate socket, no separate port, no hand-rolled HTTP parsing.
- Streamable HTTP MCP over `POST`, loopback only.
- Direct internal Zotero JavaScript API access.
- **My Library only.** Group libraries are out of scope; requests targeting one
  return an actionable error.
- No authentication, by explicit decision. Loopback binding is the only access
  control.

### Search and retrieval

- Keyword and metadata search.
- Structured AND/OR search conditions.
- Boolean tag search and citation-key lookup.
- Full-text search with context snippets.
- Item metadata, abstracts, full text, children, attachments, tags, and trash.
- Collections as flat lists or recursive trees, plus collection contents.
- Item, attachment, PDF, EPUB, page, and annotation URIs.

### Documents and annotations

- Zotero built-in PDF/full-text extraction only.
- Page-range text reading; EPUB section-aware reading by spine document.
- EPUB text extraction and EPUB CFI generation.
- Read/search/create/update/delete annotations, including text highlights and
  rectangular area annotations.
- Read and create/update/append Zotero notes.

### Library writes

- Import by DOI, ISBN, arXiv, PMID, URL, local file, or manual metadata, using
  Zotero's own translators.
- Update metadata and creators, batch updates, tag operations (item-level and
  library-wide), collection CRUD and membership, attachment management,
  relations, duplicate merging, trash/restore, reparenting.
- Related-item writes are bidirectional and must not leave a half-link when the
  second side fails.

### Advanced runtime operation

- `zotero_script` with read and write modes, no approval gate.

## Success Criteria

- A supported MCP client initializes against Zotero's HTTP server and can
  list/call every in-scope tool.
- Searches and reads return correct results from My Library.
- Full-text and page/section reads use Zotero's built-in extraction only.
- Returned records carry correct `zotero://` URIs, including page and annotation
  parameters where applicable.
- PDF and EPUB annotations created over MCP render at the requested location in
  Zotero Reader, including CFI-based EPUB highlights.
- All selected write operations update Zotero correctly and report actionable
  errors.
- Related-item operations leave both items linked, or both unchanged.
- The plugin builds, passes unit tests, and its tool list contains exactly the
  eleven in-scope tools.

## Risks

- **Unrestricted writes and privileged scripts are high risk.** Any local
  process — including a web page able to reach the port — can modify or delete
  library data. Mitigation for now is loopback binding plus documentation; bearer
  auth and confirmation remain future options. Zotero 10's local-server
  hardening already drops browser-originated requests, which removes the worst
  case, and every undoable write lands on Zotero's undo stack.
- **Sharing Zotero's HTTP server** means the endpoint depends on Zotero's
  connector server being enabled, and puts the MCP endpoint on a port that
  browsers already talk to. Endpoint path must be namespaced to avoid collision
  with Zotero and other plugins.
- Zotero's internal APIs are async and effectively single-threaded; mutations
  need serialization.
- Zotero's Related model is symmetric and unlabeled.
- EPUB CFI positions become invalid if EPUB content is replaced.
- Zotero full-text extraction is incomplete for scanned PDFs.
- Large result sets and batch writes can exceed client context or timeouts,
  requiring pagination and bounded output.

## Decisions

- **Minimum Zotero version: 10.0** (`strict_min_version` 10.0,
  `strict_max_version` 10.0.*). Zotero 10 changed the search API and full-text
  layer enough that supporting 8 and 9 would mean branching the two services
  this plugin is built around, for no user this project has.
- **Built independently** — fresh codebase; prior art is reference only.
- **Transport: POST-only, stateless Streamable HTTP** on Zotero's existing HTTP
  server at port 23119, endpoint path `/zotmcp/mcp`. No sessions, no
  `Mcp-Session-Id`, no SSE. Method and content-type rejection is delegated to
  Zotero's server. Zotero's server owns body reading,
  decoding, and size limits.
- **Public API: eleven modal tools** — `library_search`, `library_read`,
  `paper_read`, `library_update`, `library_delete`, `collection_update`,
  `attachment_update`, `note_write`, `annotation_write`, `library_import`,
  `zotero_script` — plus three MCP resources.
- **Writes enabled by default**, no gate.
- **My Library only**; no library parameter, no `libraries` entity, no
  `switch_library`.
- **Undo via Zotero 10's native stack** — every write that modifies an existing
  object is saved with an `undoAction` label, and multi-object transactions stage
  a single undo step, so an MCP edit is reversible with Ctrl+Z in Zotero's own
  UI. This replaces the rejected plugin-owned journal: the cost is one argument
  per save. Zotero cannot undo object creation or permanent deletion, so tools
  whose effect is not undoable say so in their result.
- **External scholarly search removed** as out of Zotero's core scope.

## Open Questions

- Behavior when Zotero's HTTP server is disabled by the user: fail loudly in the
  plugin UI, or attempt a fallback socket? (Proposed: fail loudly, no fallback.)
