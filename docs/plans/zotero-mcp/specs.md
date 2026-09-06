# Specs: Zotero MCP Plugin (`zotmcp`)

Audience: implementer and tester. Every requirement is independently testable.
Requirement IDs are referenced by `design.md` and `tasks.md`.

Prior-art lessons that became hard requirements are marked **[PA]**.

Scope reminders: **Zotero 10 only**, **My Library only**, no group libraries, no
semantic search, no external scholarly search, writes enabled by default, undo
supplied by Zotero's own undo stack.

---

## Requirements

### S — Server, transport, protocol

- **S-0** The plugin declares `strict_min_version` 10.0 and installs on
  Zotero 10. Zotero enforces the declared range in release builds, so an
  out-of-range manifest disables the plugin rather than warning.
- **S-1** The plugin registers its MCP endpoint on **Zotero's own HTTP server**
  at path `/zotmcp/mcp`, using the port from
  `extensions.zotero.httpServer.port` (default 23119) read at runtime. The plugin
  opens no socket of its own and implements no HTTP parsing.
- **S-2** The endpoint is registered at plugin startup after Zotero is fully
  initialized, and unregistered on plugin shutdown, leaving no stale endpoint.
- **S-3** If Zotero's HTTP server is disabled, the plugin surfaces an actionable
  message (plugin UI and log) naming the preference to enable. It does not open a
  fallback socket.
- **S-4** `POST /zotmcp/mcp` with `Content-Type: application/json` speaks MCP over
  JSON-RPC 2.0 and completes `initialize`, negotiating a protocol version no newer
  than `2025-06-18` and echoing the client's requested version when supported.
- **S-5** `initialize` advertises capabilities for `tools` and `resources` only.
- **S-6** The server is **stateless**. It issues no `Mcp-Session-Id`, keeps no
  per-client state between requests, and every request is independently valid.
  An `Mcp-Session-Id` sent by a client is ignored, never rejected. A `tools/call`
  succeeds without a prior `initialize` on the same connection, and correctness
  never depends on request ordering or connection reuse.
- **S-7** The endpoint declares `POST` as its only supported method and
  `application/json` as its only supported data type; method and content-type
  rejection is delegated to Zotero's server, with no status code specified by
  this project. JSON-RPC batch arrays are rejected with a JSON-RPC error object
  rather than silently ignored. **[PA: T]**
- **S-8** `notifications/*` requests are accepted and answered without error.
- **S-9** `tools/list` returns exactly the eleven tools of §T and nothing else. A
  unit test asserts the exact tool-name set against the registry, so surface
  drift fails CI. **[PA: T's stale docs; L's ineffective drift test]**
- **S-10** `resources/list` returns `zotero://collections`,
  `zotero://items/{itemKey}`, and `zotero://collections/{collectionKey}/items`;
  `resources/read` returns their current content.
- **S-11** Mutating tools work on a fresh install with default preferences — no
  write gate, no confirmation step.
- **S-12** No tool name, description, or schema mentions semantic search,
  embeddings, vector search, undo, approval, confirmation, group libraries, or
  external literature search. **[PA]**
- **S-13** Non-ASCII text (CJK, accents, emoji) survives a round trip through
  search, read, note write, and annotation create. **[PA: T's UTF-8 bug class]**
- **S-14** The endpoint does **not** set `allowRequestsFromUnsafeWebContent`.
  Zotero 10's local-server hardening therefore applies: a request with a
  browser-like `User-Agent` or any `Origin` header is dropped unless it sends
  `Zotero-Allowed-Request`, and a request whose `Host` is not `localhost`,
  `127.0.0.1` or `[::1]` is refused. This is the primary mitigation for ungated
  writes, so re-enabling web content requires a scope decision, not a code
  change. Client-facing docs must state the header requirements.
- **S-14b** Requests Zotero rejects before dispatch — malformed JSON, a
  non-`POST` method, a non-`application/json` content type, a non-loopback
  `Host` — are answered by Zotero as HTTP 400 with a plain-text body, not a
  JSON-RPC error object. This is Zotero's behaviour, not something the plugin
  overrides; client docs must not promise a JSON-RPC error for a malformed body.
- **S-15** The manifest declares `strict_max_version` covering the Zotero
  versions the plugin is tested against; Zotero enforces it in release builds, so
  an un-bumped maximum silently disables the plugin after a Zotero upgrade.

### T — Tool surface (exhaustive)

| #   | Tool                | Covers                                                                                                                                |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `library_search`    | keyword / advanced-conditions / tag / citation-key / full-text / annotation search; entities: items, collections, tags; trash listing |
| 2   | `library_read`      | item metadata, abstract, children, attachments (incl. file path), tags, notes, annotations                                            |
| 3   | `paper_read`        | modes `fulltext`, `pages`, `sections`; PDF and EPUB                                                                                   |
| 4   | `library_import`    | identifiers (DOI/ISBN/arXiv/PMID/URL), local files, manual creation                                                                   |
| 5   | `library_update`    | metadata, item tags, library-wide tag ops, reparent, related links; batch `operations[]`                                              |
| 6   | `collection_update` | create, rename, move, delete, add/remove membership                                                                                   |
| 7   | `library_delete`    | trash, restore, merge duplicates                                                                                                      |
| 8   | `attachment_update` | rename, relink, delete                                                                                                                |
| 9   | `note_write`        | create, update, append (Markdown → HTML)                                                                                              |
| 10  | `annotation_write`  | create text highlight, create area annotation, update, delete                                                                         |
| 11  | `zotero_script`     | arbitrary privileged JS, `mode: read \| write`                                                                                        |

### LB — Library scope

- **LB-1** All operations act on My Library (`Zotero.Libraries.userLibraryID`).
  No tool takes a library parameter.
- **LB-2** A request naming an item, collection, attachment, or annotation that
  exists only in a group library returns an actionable error stating that group
  libraries are unsupported. It must not silently operate on a same-keyed
  My Library object.
- **LB-3** Searches never return group-library results.

### U — URIs

- **U-1** Every returned item record includes `uri.select` =
  `zotero://select/library/items/{KEY}`.
- **U-2** Attachment records include `uri.open`; PDF attachments also include
  `uri.openPdf`.
- **U-3** Results carrying a page location include a URI with `?page=N` using
  1-based page numbers; results carrying an annotation identity include
  `?annotation=KEY`. Both parameters combine when both are known.
- **U-4** _(removed — EPUB annotation writing is out of scope.)_
- **U-5** URIs use the `library` path segment consistently; no code path emits a
  `groups/` URI. **[PA: T emits the wrong form for group items — here the class
  of bug is removed by scope]**

### SR — Search

- **SR-1** `library_search` performs ranked keyword search over item metadata
  (title, creators, year, item type) with `limit`/`offset` pagination, default
  limit ≤ 25, hard cap ≤ 100.
- **SR-2** `conditions[]` accepts structured Zotero search conditions
  (field / operator / value) with `joinMode: all | any`.
- **SR-3** Tag search accepts boolean tag expressions and returns matching items.
- **SR-4** Citation-key lookup resolves a BetterBibTeX citation key to its item.
  With BetterBibTeX absent, the tool reports that citation keys are unavailable
  rather than failing opaquely.
- **SR-5** Full-text search queries Zotero's built-in full-text index and returns
  matching items each with a bounded context snippet around the match.
- **SR-6** Annotation search filters by text, color, and tag, returning the parent
  item and page/location per hit.
- **SR-7** `entity: collections` returns a flat list or a recursive tree with item
  counts; `entity: tags` returns tags with counts.
- **SR-8** `filters.deleted: true` lists only trashed items.
- **SR-9** Every search returns an explicit empty-result structure,
  distinguishable from an error.

### R — Reading

- **R-1** `library_read` returns any requested subset of sections: `metadata`,
  `abstract`, `children`, `attachments` (content type, on-disk path, URIs),
  `tags`, `notes`, `annotations`.
- **R-2** `paper_read` `mode: fulltext` returns text for PDF and EPUB attachments
  using only Zotero's built-in extraction; no external process is invoked.
- **R-3** `mode: pages` returns a 1-based page range with page numbers preserved.
- **R-4** _(removed — PDF outline reading is out of scope.)_
- **R-5** `mode: sections` groups EPUB text by spine document. PDFs do not
  support `sections`; requesting it for a PDF returns an error directing the
  caller to `pages` or `fulltext`.
- **R-5a** `mode: sections` accepts a `select` array; only sections whose titles
  start with or contain a selector are returned, so reading a late section costs
  nothing for the sections before it. A numeric selector also matches its
  subsections (`"3.1"` matches `3.1.1`). A selector that matches nothing is
  reported back.
- **R-5b** A selected section still ends where the next section begins, whether
  or not that next section was selected.
- **R-5c** `mode: sections` accepts `perSectionMaxChars`, capping each section's
  text independently so one long section cannot exhaust the total budget. Each
  section reports its own truncation and its full character count.
- **R-6** A PDF with no text layer returns an actionable error naming the cause
  (scanned document, no text layer) rather than empty output.
- **R-7** All read output is bounded by an explicit character/page cap, reported
  in the result when truncation occurs.

### A — Annotations and notes

- **A-1** `annotation_write` create-with-text locates the requested text in a PDF
  and creates a highlight that renders at the correct position in Zotero's PDF
  reader.
- **A-2** create-with-rect creates an area annotation from a PDF-user-space
  rectangle (origin bottom-left, points) on a given page.
- **A-3** _(removed — EPUB highlight creation is out of scope. Zotero positions
  EPUB annotations by CFI, which requires a DOM path into the EPUB's XHTML;
  structured document text exposes blocks, not DOM structure.)_
- **A-4** update modifies an existing annotation's comment, color, or tags by
  annotation key.
- **A-5** delete trashes an annotation by key.
- **A-6** `note_write` creates, updates, or appends to a note, converting
  Markdown input to Zotero note HTML.
- **A-7** Annotation and note operations accept a parent item or attachment and
  parent the created child item correctly.

### W — Writes and library management

- **W-1** `library_import` with identifiers resolves DOI, ISBN, arXiv ID, PMID,
  and URL through Zotero's own translators, creates the item, and returns its
  record with URIs.
- **W-2** `library_import` with a local file creates an imported-file or
  linked-file attachment on a parent item.
- **W-3** `library_import` manual creates an item from explicit fields, validating
  against the item type and rejecting an invalid field with the list of valid
  fields for that type.
- **W-4** `library_update` `kind: metadata` updates fields and creators and
  reports each changed field.
- **W-5** `library_update` accepts a batch `operations[]` array, returning
  per-operation results.
- **W-6** `kind: tags` supports add, remove, and set (replace the whole tag list)
  per item.
- **W-7** `kind: tag` performs library-wide tag operations: rename, merge, delete,
  set color.
- **W-8** `kind: parent` reparents a note or attachment, or detaches it to top
  level.
- **W-9** `kind: related` adds or removes related-item links writing both sides;
  if the second side fails the first is rolled back so no half-link remains. A
  test injects a second-side failure. **[PA: P and T leave half-links]**
- **W-10** `collection_update` creates (with optional parent), renames, moves,
  and deletes collections. Delete takes an explicit `deleteItems` opt-in that
  also trashes members; default leaves items in place.
- **W-11** `collection_update` adds and removes item membership.
- **W-12** `library_delete` supports `mode: trash`, `mode: restore`, and
  `mode: merge` (merge duplicates into a designated master).
- **W-13** `attachment_update` renames the file on disk, relinks to a new path,
  and deletes (trashes) an attachment.
- **W-14** Every mutating tool reports what changed, so a caller can verify the
  effect without a second read.

### ND — Undo (Zotero 10 native stack)

- **ND-1** Every write that modifies an existing object saves with an
  `undoAction` label, so the change appears in Zotero's Undo menu and is
  reversible with Ctrl+Z.
- **ND-2** A write that saves several objects stages one undo action inside its
  transaction, so the whole operation undoes as a single step rather than
  object by object.
- **ND-3** Every `undoAction` ID used by the plugin exists in the plugin's FTL,
  which is registered with `Zotero.ftl` at startup and removed at shutdown. A
  missing ID would surface as a raw message ID in the Undo menu.
- **ND-4** Every result states whether Zotero can reverse the operation.
  Creating an object and permanently erasing one are not undoable; editing,
  trashing, merging and collection deletion are, because Zotero 10 trashes
  rather than erases and stages its own undo actions.
- **ND-6** `zotero_script` in write mode accepts `transaction: true`, running the
  script inside one transaction with a staged undo action so its saves become a
  single undo step. Without it a script's writes are not undoable, since a
  script's own `saveTx()` carries no label. The result reports which applied.
- **ND-5** Failure to stage an undo label never fails the write itself; it is
  logged and the write proceeds.

### X — Privileged script execution

- **X-1** `zotero_script` executes caller JavaScript in the Zotero runtime with
  the global `Zotero` available, in `mode: read` or `mode: write`, with no
  confirmation gate.
- **X-2** Thrown exceptions are returned as tool errors with message and stack,
  never as successful results.
- **X-3** Scripts run under a configurable timeout (default 30 s, max 120 s) and
  are aborted with an error on expiry.
- **X-4** The tool accepts a human-readable description, echoed verbatim in the
  result for auditability.

### E — Errors, concurrency, boundaries

- **E-1** Every tool returns an actionable error for: unknown item / attachment /
  collection / annotation key, attachment file missing on disk, and invalid
  arguments. Errors name the offending value.
- **E-2** All mutating operations are serialized through a single write queue;
  concurrent `tools/call` invocations never interleave Zotero transactions.
- **E-3** All list-shaped results are bounded by `limit`; unbounded enumeration is
  impossible by default.
- **E-4** A tool error is returned as an MCP tool error result, distinguishable
  from a JSON-RPC protocol error.

---

## Acceptance Scenarios

### Scenario: client initializes on Zotero's port

Given Zotero 8 running with the plugin installed and its HTTP server enabled
When a client POSTs MCP `initialize` to `http://127.0.0.1:23119/zotmcp/mcp`
Then the response is a valid `initialize` result advertising `tools` and
`resources`, and a subsequent `tools/list` returns exactly the eleven tools of
§T. (S-1, S-4, S-5, S-9)

### Scenario: stateless operation

Given a running endpoint
When a client POSTs `tools/call` with no prior `initialize` and no session header,
and a second client POSTs a different `tools/call` concurrently
Then both calls succeed independently and neither is rejected for a missing or
unknown session. (S-6)

### Scenario: Zotero HTTP server disabled

Given Zotero's HTTP server preference is off
When the plugin starts
Then it logs and displays an actionable message naming the preference, and opens
no socket of its own. (S-3)

### Scenario: group-library item is refused

Given an item that exists only in a group library
When any tool is called with its key
Then the result is an error stating group libraries are unsupported, and no
My Library object is modified. (LB-2)

### Scenario: full-text search with snippets

Given a PDF whose indexed text contains a distinctive phrase
When `library_search` runs a full-text query for that phrase
Then the result contains the owning item and a bounded snippet around the
phrase. (SR-5)

### Scenario: page-range read

Given a PDF attachment with 20 pages of extractable text
When `paper_read` requests pages 3–5
Then the result contains exactly pages 3, 4, 5, each labeled with its 1-based
number, plus an `open-pdf` URI containing `?page=3`. (R-3, U-3)

### Scenario: PDF text highlight round trip

Given a PDF attachment
When `annotation_write` creates a highlight on an exact quoted sentence
Then a Zotero annotation child item exists, renders over that sentence in the
reader, and the result includes its key and an `?annotation=KEY` URI.
(A-1, U-3)

### Scenario: related-link atomicity

Given items A and B with no relation, and an injected fault on the second save
When `library_update kind: related` links A↔B
Then the operation reports failure and A's relations are unchanged — no
half-link. (W-9)

### Scenario: batch update with per-operation results

Given three items
When `library_update` submits an `operations[]` array tagging all three
Then each operation result is reported individually and all three items carry the
new tag. (W-5, W-6)

### Scenario: import by DOI

Given an empty collection
When `library_import` runs with a valid DOI
Then one item is created with resolved metadata, filed in the collection, and
returned with URIs. (W-1)

### Scenario: trash and restore

Given an item in the trash, listed via `filters.deleted`
When `library_delete mode: restore` targets it
Then it reappears in normal listings and leaves the trash listing. (SR-8, W-12)

### Scenario: an MCP metadata edit is undoable in Zotero

Given an item edited through `library_update kind:'metadata'`
When the user opens Zotero's Edit menu
Then Undo is enabled with the plugin's label, and choosing it restores the
previous field values. (ND-1, ND-3)

### Scenario: a batch write undoes as one step

Given three items tagged in a single `library_update` call
When the user chooses Undo once
Then all three items lose the tag together. (ND-2)

### Scenario: writes work out of the box

Given a fresh install with default preferences
When a client calls any mutating tool
Then it executes with no preference change, confirmation, or approval step.
(S-11, X-1)

### Scenario: drifted tool surface fails CI

Given a developer adds a twelfth tool without updating the surface test
When the exact-surface unit test runs
Then it fails. (S-9)

### Scenario: no-text-layer PDF

Given a scanned PDF with no text layer
When `paper_read` requests fulltext or pages
Then the tool returns an error naming the cause, not empty output. (R-6)

### Scenario: CJK round trip

Given an item with a Chinese title and a note containing emoji
When the item is searched, read, and its note appended to
Then all characters are byte-identical to the input. (S-13)

---

## Edge Cases

- **Endpoint path collision** — another plugin registering `/zotmcp/mcp` is a
  programming error; startup logs a warning if the path is already taken.
- **Browser reachability** — Zotero's port 23119 is reachable from web pages;
  since writes are ungated this is an accepted, documented risk (see proposal).
- **BetterBibTeX absent** — citation-key search degrades with an explanatory
  message (SR-4).
- **PDF outline absent** — n/a; outline reading is out of scope.
- **Zotero busy / sync in progress** — the write queue waits, and a bounded
  timeout yields an actionable error (E-2).
- **Very large libraries** — collection trees and tag lists paginate (E-3).
- **Annotation on a non-PDF/non-EPUB attachment** — rejected with an error naming
  the attachment's content type.
- **`zotero_script` returning non-serializable values** — coerced or reported as
  an error, never silently dropped.

## Out Of Scope

Zotero 8 and 9 support; a plugin-owned change journal, multi-step revert tooling
and `undo_last_action`/`revert_changes` MCP tools (Zotero's own undo stack covers
this instead); group libraries and multi-library management; semantic/vector search and any
embedding code; external scholarly search (OpenAlex, arXiv, Europe PMC, Scite)
and citation-graph traversal; undo, revert, change journals, approval cards;
authentication and remote binding; SSE/server push; MinerU and all external
conversion runtimes; RSS feeds; MCP prompts; ChatGPT connector; runtime write
gating; BibTeX/CSL-JSON import (identifier, file, and manual only); related-item
read tooling; EPUB annotation creation and CFI generation; batch note writing; figure extraction, page rendering, reader
capture; PDF outline / table-of-contents reading and PDF section-aware reading;
recent-items, duplicate _detection_, PDF-coverage audit; standalone
CLI; Docker; client-config generation; third-party tool registration.
