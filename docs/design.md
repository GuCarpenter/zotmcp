# zotmcp design notes

As-built notes on how zotmcp works and why, written after the fact. For usage see
the [README](../README.md).

## What it is

A Zotero 10 plugin that serves eleven MCP tools and three resources over Zotero's
own HTTP server, so any MCP client can search, read, annotate and manage
My Library.

## Decisions

| Decision                               | Why                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zotero plugin, not an external process | Uses Zotero's internal JS API directly: no web-API keys, no SQLite reading, no sync lag. The cost is that Zotero must be running.                                                                             |
| Endpoint on Zotero's own HTTP server   | Zotero owns the socket, body reading, UTF-8 decoding and size limits. Nothing to reimplement, no second port, and Zotero 10's request hardening applies for free.                                             |
| Stateless                              | Zotero's endpoint contract returns `[status, contentType, body]` with **no response headers**, so there is nowhere to put an `Mcp-Session-Id`. Statelessness is forced by the platform, not merely preferred. |
| Eleven modal tools                     | The full surface is sent on every request, so it stays small: `paper_read mode:'…'` rather than four read tools. No toolset gating machinery needed.                                                          |
| My Library only                        | Group libraries double every code path for no user this project has. Group keys are refused rather than silently mixed in.                                                                                    |
| No semantic search                     | Would mean an embedding provider, a vector store, an index lifecycle, and a staleness problem. Zotero 10's FTS5 full-text index covers the actual need.                                                       |
| Writes ungated                         | A deliberate choice: no confirmation step. Mitigated by loopback-only binding, Zotero 10 dropping browser-originated requests, and Zotero's native undo stack.                                                |
| Undo via Zotero, not a journal         | Zotero 10 records undo for any labelled save. One argument per save replaces a whole plugin-owned change journal.                                                                                             |
| Reading via `Zotero.SDT`               | Structured document text gives typed blocks, a page catalogue and an outline for PDF **and** EPUB, cached and hash-invalidated. Replaced a planned PDF path plus a hand-written EPUB zip/spine parser.        |

## Architecture

Strict one-way dependencies:

```text
Zotero.Server  →  transport/  →  protocol/  →  tools/  →  services/  →  ZoteroGateway  →  global Zotero
```

Two rules carry most of the weight:

**Only `ZoteroGateway` touches the global `Zotero` object.** Every service takes
it injected, so the whole codebase is unit-testable in plain Node against
`FakeGateway`, with no Zotero process.

**Every item lookup goes through one resolver; every URI through one builder.**
`ItemResolver` asserts `libraryID` on each lookup — Zotero keys are unique per
library, so a group key can collide with a different My Library object, and the
assert is what makes that unwriteable from a forgotten call site. `uriService`
has no group branch at all, so a wrong-form deep link cannot be emitted.

### Modules

```text
src/
  transport/     Zotero.Server endpoint, HTTP-server availability check
  protocol/      JSON-RPC framing, capabilities, method dispatch
  tools/         eleven tool specs (schemas + descriptions) and their handlers
  resources/     three MCP resources
  services/      search, reading, annotations, notes, writes, script, undo, URIs
  services/zoteroGateway.ts   the only file referencing global Zotero
```

### Request path

```text
POST /zotmcp/mcp
  → Zotero.Server (socket, decode, JSON parse)
  → endpoint.init(options)
  → protocol/dispatch
  → registry.get(name).handler(args, ctx)
  → services → ZoteroGateway → Zotero
  → [200, "application/json", body]
```

Dispatch is a pure function of `(method, params)` plus injected services. No
per-client state exists anywhere, so `tools/call` works with no prior
`initialize` and concurrent callers cannot interfere except through the write
queue.

A **tool failure** returns a normal result with `isError: true`, not a JSON-RPC
error, so clients show it to the model instead of treating it as a transport
fault. Protocol errors (`-32600`, `-32601`, `-32602`) are reserved for genuine
protocol problems.

### Writes

All mutations pass through one promise-chain queue with a bounded 45-second
deadline. Zotero's data layer is effectively single-threaded, and MCP calls
arrive concurrently, so unserialized writes interleave transactions.

Multi-object operations run inside `Zotero.DB.executeTransaction`. This is how
bidirectional related links get atomicity for free: both `addRelatedItem` saves
live in one transaction, so a failure on the second rolls back the first and no
half-link survives — the failure mode both comparable projects ship.

**`saveTx()` must not be called inside a transaction.** It waits for a
transaction that cannot commit until the caller returns, so the write deadlocks
until the queue deadline fires. `gateway.saveItem()` therefore checks
`Zotero.DB.inTransaction()` and calls `save()` inside one, `saveTx()` outside.
This bug shipped briefly and broke five write paths; it was invisible to unit
tests because `FakeGateway` treated both cases identically.

### Undo

`undoLabel(action, count)` produces `saveTx` options for a single-object edit;
`stageUndo()` labels a transaction so several saves collapse into one undo step.
Labels live in the plugin's FTL, registered with `Zotero.ftl` at startup —
Zotero formats undo labels through `Zotero.ftl`, not window l10n.

What Zotero can reverse is wider than first assumed: **only object creation and
permanent erasure are irreversible.** Editing, trashing, merging and collection
deletion are all undoable, because Zotero 10 trashes rather than erases. Every
tool result states which applies.

## Zotero 10 platform notes

Findings that shaped the implementation, all verified against Zotero 10.0.1's
own source (extracted from `omni.ja`) rather than assumed.

### Local HTTP server hardening

- A request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` gets a 400.
- A request with a `Mozilla/`-prefixed `User-Agent` or **any** `Origin` header is
  dropped with no response, unless it sends `Zotero-Allowed-Request`.
- An endpoint can opt out with `allowRequestsFromUnsafeWebContent`. This plugin
  deliberately does **not**, because that flag would re-open the exposure that
  makes ungated writes acceptable.

Verified empirically: curl works untouched; an `Origin` header or browser
user-agent produces "Empty reply from server"; adding `Zotero-Allowed-Request: 1`
makes the identical request succeed.

Zotero also answers before dispatch for malformed JSON, a non-`POST` method, a
wrong content type, and a non-loopback `Host` — all as HTTP 400 with a plain-text
body, not a JSON-RPC error. Clients must not expect a JSON-RPC error for a broken
body.

### Search

`resultLevel` carries its level in the _operator_, like `joinMode`, and is the
supported way to roll child matches up to their item — it replaces the old
resolve-to-parents dance for `fulltextContent` and annotation conditions.
`addCondition` throws on the legacy `required` argument. `fulltextWord` is gone
and `fulltextContent` is FTS5-backed. `quicksearch-titleCreatorYear` already
covers title, publicationTitle, shortTitle, court, year and citationKey, so
keyword search is one condition.

### Structured document text

`Zotero.SDT.getReader(itemID)` returns a cached, hash-invalidated parse of a PDF,
EPUB or snapshot attachment: typed blocks (`heading`, `paragraph`, `caption`), a
page catalogue with labels, and an outline. Consequences:

- Pages come from `getPageBlocks(i)` — no character-offset arithmetic, no
  form-feed fallback, and the document's own page labels survive.
- PDF and EPUB share one code path.
- Sections are real structure. A PDF's outline merges its embedded outline with
  style-detected headings; an EPUB's comes from its navigation document.

Two limits the format imposes. A block's page lives in
`anchor.pageRects[0][0]` — `[pageIndex, x1, y1, x2, y2]` — and there is no bare
`pageIndex` field. And the read module exports no glyph-geometry decoder, only
text, so character-precise rects are unavailable without reimplementing an
undocumented packed format.

PDF outline entries carry no page (`target` holds only a `url`), so section start
pages are derived from the block each entry points at. EPUB entries do carry
`target.position.pageIndex`. PDF outlines nest under `children`, EPUB under
`items`; both are accepted.

### Other

`Zotero.Items.merge()` is deprecated in favour of `mergeItems.mjs`, which already
wraps itself in a transaction and stages `undo-action-merge-items`. A collection's
`erase()` inserts into `deletedCollections` — it trashes rather than erases.
`setType()` and the attachment path setters now throw where they used to corrupt.
Preference panes run in their own global scope. The build prefixes locale
filenames with the plugin namespace, so `strings.ftl` ships as
`zotmcp-strings.ftl` and must be registered under that name.

## Known limitations

**Text-located highlights are paragraph-level.** Zotero renders a highlight from
`position.rects`, and precise rects are not derivable from SDT (above). A
text-located highlight therefore covers the block containing the quote and
reports `granularity: "block"`; callers wanting exact geometry pass rects. Text
matching more than one block is refused with the match count rather than placed
at the first hit — a misplaced highlight is worse than a coarse one.

**Section outlines inherit Zotero's heading detection.** On papers with algorithm
blocks, pseudocode lines such as `6: for 1 ≤ j ≤ Tc do` appear as sections. The
pack strips provenance before a consumer sees it, so native-outline entries
cannot be told from style-recovered ones, and no supported API exposes the
embedded outline alone.

**No EPUB annotation writing.** Zotero positions EPUB annotations by CFI, a DOM
path into the book's XHTML; SDT exposes blocks, not DOM structure.

**No "move" between collections in one call.** `collection_update` has
`addItems` and `removeItems` only.

**`zotero_script` writes are not undoable by default**, since a script's own
`saveTx()` carries no label. `transaction: true` makes them one undo step, at the
cost of holding the database for the script's run.

## Verification

- 277 unit tests in plain Node against `FakeGateway`; no Zotero required.
- 18 integration tests inside Zotero 10 via `zotero-plugin test`, against a
  scratch profile and data directory.
- The full tool surface exercised over the live endpoint against a real library.
- A test pins the exact eleven-tool surface, and another scans tool text for
  out-of-scope vocabulary, so `tools/list` cannot drift from the code.

Worth recording: every bug found in this project came from running against a real
library or inspecting the built XPI, not from the test suite — the write
deadlock, the `anchor.pageRects` shape, duplicate tag rows, a section selector
matching `2.3.1` for `3.1`, and the FTL filename prefix. The tests validate the
code against a model of Zotero, so anywhere that model was wrong, only the real
thing could tell.
