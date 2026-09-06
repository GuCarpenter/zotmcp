# Design: Zotero MCP Plugin (`zotmcp`)

Implements `specs.md`. Requirement IDs in parentheses.

---

## Overview

A Zotero 8 plugin that registers a single stateless MCP endpoint on Zotero's own
HTTP server and serves eleven modal tools plus three resources, backed only by
Zotero's internal JavaScript API.

Layering, strict one-way dependencies:

```
Zotero.Server  →  transport/  →  protocol/  →  tools/  →  services/  →  ZoteroGateway  →  global Zotero
```

Two rules make the whole thing testable and keep the spec's structural
guarantees:

1. **Only `ZoteroGateway` touches the global `Zotero` object.** Every service
   takes it injected, so unit tests substitute a fake and never need a running
   Zotero.
2. **Every item lookup goes through one resolver and every URI through one
   builder.** That is what makes LB-2 and U-5 impossible to violate in a single
   forgotten code path — the class of bug zotero-mcp-ts shipped.

## Existing System

### Verified against prior-art source

`Zotero.Server.Endpoints` takes a class keyed by path. Confirmed shape
(`llm-for-zotero/src/agent/mcp/server.ts:2114-2143`):

```ts
class Endpoint {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];
  init = async (options): Promise<[number, string, string]> => { ... };
}
Zotero.Server.Endpoints["/zotmcp/mcp"] = Endpoint;
delete Zotero.Server.Endpoints["/zotmcp/mcp"];   // shutdown
```

Consequences taken as design inputs:

- The return tuple is `[status, contentType, body]` — **no response headers**.
  This independently confirms the stateless decision: there is no clean way to
  emit `Mcp-Session-Id` (S-6).
- Zotero owns the socket, body read, UTF-8 decoding, and size limits. The whole
  bug class that forced zotero-mcp-ts to hand-roll `httpRequestReader.ts` is
  absent, and S-13 is satisfied structurally rather than by our own code.
- `options.data` arrives already JSON-parsed for `application/json`; handle both
  object and string.

`Zotero.PDFWorker.getFullText(itemID)` returns `{ text, pageChars }`, where
`pageChars` is per-page cumulative character offsets
(`llm-for-zotero/src/modules/contextPanel/pdfContext.ts:466-477`). This is the
primitive for both fulltext (R-2) and page-range reads (R-3) — no worker cloning
needed, unlike zotero-mcp-ts's `pdfProcessor.ts`.

Zotero's own full-text index (`Zotero.Fulltext`) is the fallback when
`PDFWorker` returns nothing despite indexed text existing — a real case
documented at `pdfContext.ts:484-486`.

### Unverified — design assumptions

- **EPUB.** No prior art in-plugin. Design assumes reading the file and parsing
  it ourselves (unzip + spine walk).
- **esbuild target.** Zotero 7 is Firefox 115 ESR; Zotero 8's Gecko base needs
  confirming. Use `firefox115` as a conservative floor.

PDF outline reading is out of scope, so no outline spike is needed; `sections`
applies to EPUB only. Method/content-type rejection is delegated to Zotero's
server, so no status code is asserted.

## Proposed Approach

### Module layout

```
src/
  index.ts                     entry; wires hooks
  hooks.ts                     startup/shutdown lifecycle
  transport/
    endpoint.ts                Zotero.Server endpoint class (S-1..S-3, S-7)
    httpServerCheck.ts         httpServer.enabled probe + loud failure (S-3)
  protocol/
    jsonRpc.ts                 parse/serialize, error codes, array rejection
    dispatch.ts                initialize | tools/* | resources/* | notifications/* | ping
    capabilities.ts            protocol version + advertised capabilities (S-4, S-5)
  tools/
    registry.ts                ToolSpec type, register(), list() (S-9)
    index.ts                   the eleven specs, in one place
    librarySearch.ts  libraryRead.ts   paperRead.ts
    libraryImport.ts  libraryUpdate.ts collectionUpdate.ts
    libraryDelete.ts  attachmentUpdate.ts
    noteWrite.ts      annotationWrite.ts zoteroScript.ts
  resources/
    index.ts                   three MCP resources (S-10)
  services/
    zoteroGateway.ts           ONLY module referencing global Zotero
    itemResolver.ts            key → item, enforces My Library (LB-1..LB-3)
    uriService.ts              all zotero:// construction (U-1..U-5)
    searchService.ts           Zotero.Search + Fulltext (SR-*)
    readService.ts             sectioned item read (R-1)
    pdfService.ts              PDFWorker + pageChars + fallbacks (R-2, R-3, R-6, R-7)
    epubService.ts             unzip, spine, text, sections (R-2, R-5)
    epubCfi.ts                 CFI generation (A-3, U-4)
    annotationService.ts       create/update/delete annotations (A-1..A-5)
    noteService.ts             Markdown → note HTML (A-6)
    mutationService.ts         write queue + transactions (E-2, W-9)
    importService.ts           translators, files, manual (W-1..W-3)
  errors.ts                    typed errors → actionable messages (E-1, E-4)
  prefs.ts
test/
  unit/                        fake gateway; no Zotero required
  integration/                 zotero-plugin test, real Zotero
```

### Transport (S-1, S-2, S-3, S-7)

One endpoint class, registered in `hooks.ts` after
`Zotero.initializationPromise` and `uiReadyPromise` resolve, deleted on shutdown.
`init()` hands the body to `protocol/dispatch` and returns its tuple. The port is
never chosen by us; `extensions.zotero.httpServer.port` is read only to _display_
the connection URL in the prefs pane.

If `httpServer.enabled` is false, startup fails loudly (S-3): a Zotero
notification popup, an error-level log line naming the preference, and a
persistent banner in the plugin's prefs pane showing the exact pref to flip. No
fallback socket — that was the decision, and it keeps us off a second port.

Path-collision check: if `Zotero.Server.Endpoints["/zotmcp/mcp"]` is already
occupied at registration, log a warning and overwrite (edge case in specs).

### Protocol (S-4..S-10)

Hand-rolled JSON-RPC 2.0 — roughly 200 lines, no MCP SDK. The SDK's transports
assume Node, and prior art (both plugins) hand-rolls it for the same reason.

Statelessness is enforced by construction: `dispatch` is a pure function of
`(method, params)` plus injected services. No module holds per-client state, so
`tools/call` without a prior `initialize` simply works (S-6), and concurrent
callers cannot interfere except through the write queue.

Error mapping (E-4): malformed JSON → `-32700`; batch array → `-32600` with an
explanatory message; unknown method → `-32601`; bad params → `-32602`. Tool
failures are _not_ JSON-RPC errors — they return a normal `tools/call` result
with `isError: true` and the actionable message, which is what MCP clients
surface to the model.

### Tool registry (S-9, S-12)

```ts
interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  mutability: "read" | "write";
  handler(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

`tools/list` is generated from the registry, never hand-maintained — the fix for
the stale-doc drift in both prior-art projects. Two unit tests guard it:

- exact-surface test comparing registry names to a frozen array of eleven (S-9);
- a description scanner failing on the forbidden vocabulary — semantic,
  embedding, vector, undo, approval, confirmation, group library, OpenAlex (S-12).

`mutability` drives MCP tool annotations (`readOnlyHint`) and write-queue
routing. It is _not_ a permission gate; writes are ungated by decision (S-11).

### Library scope (LB-1..LB-3)

`itemResolver.ts` is the single door:

```ts
resolveItem(key: string): Zotero.Item          // throws GroupLibraryUnsupported
resolveAttachment(key: string): Zotero.Item
resolveCollection(key: string): Zotero.Collection
```

Each looks the object up with `Zotero.Libraries.userLibraryID` explicitly, then
asserts `item.libraryID === userLibraryID`. Because Zotero keys are unique only
_per library_, a group key must never be allowed to fall through to a same-keyed
My Library object — hence the explicit assert rather than a plain lookup (LB-2).
Searches always pass the user library ID as a search condition (LB-3).

### URIs (U-1..U-5)

`uriService.ts` exposes `buildItemUris(item)` and
`buildAnnotationUri(annotation, page?)`, emitting only the `library` path
segment. No group branch exists in the codebase, so U-5 holds structurally. Page
numbers are converted to 1-based at this boundary, since Zotero stores 0-based
`pageIndex` internally and the URI form expects 1-based (U-3).

### Search (SR-1..SR-9)

All modes map onto `Zotero.Search` conditions; the tool is a translator, not a
search engine.

| Mode         | Mapping                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| keyword      | `quicksearch-titleCreatorYear`, ranked, paginated                                         |
| conditions[] | conditions passed through with `joinMode`                                                 |
| tag          | `tag` conditions; boolean expression compiled to conditions + joinMode                    |
| citation key | `extra` `contains` on the BBT `Citation Key:` line; absence reported (SR-4)               |
| full text    | `fulltextContent` + `resolveToParents`, snippet cut from `Zotero.Fulltext` around the hit |
| annotation   | `annotationText` / color / tag, resolved to parent + page                                 |

Child-matching conditions (`fulltextContent`, `annotationText`) require
resolve-to-parents or matches vanish — the trap documented in zotero-mcp's tool
descriptions. Default limit 25, hard cap 100 (SR-1, E-3).

### Reading (R-1, R-2, R-3, R-5, R-6, R-7)

`pdfService.getText(attachment)` fallback chain, mirroring proven prior art:

1. `Zotero.PDFWorker.getFullText(id)` → `{ text, pageChars }`
2. Zotero full-text cache/index
3. no text → `NoTextLayerError` naming scanned PDFs as the likely cause (R-6)

Page ranges (R-3) slice `text` on cumulative `pageChars`; when `pageChars` is
missing or invalid, fall back to form-feed (`\f`) splitting, then report that page
boundaries are approximate. Output is capped and truncation is reported in-band
(R-7).

EPUB (R-2, R-5): read the file via `IOUtils.read`, unzip with `fflate`, resolve
`META-INF/container.xml` → `.opf`, walk the spine in order, strip each XHTML to
text. `sections` groups by spine document; requesting `sections` for a PDF is an
error pointing the caller at `pages` or `fulltext` (R-5).

### EPUB CFI (A-3, U-4)

`epubCfi.ts` generates `epubcfi(/6/<spine*2>!/<steps>,/<start>,/<end>)`. An
HTML parser walks the target XHTML tracking DOM position while accumulating
text, then maps a found offset back to (element path, text node, char offset).
The spec's interleaved parity — elements even `(i+1)*2`, text nodes odd
`1+2*i` — is the part that silently breaks highlights if wrong, so it gets
dedicated unit tests with fixtures. Algorithm follows foliate-js, the same
lineage zotero-mcp ported to Python.

### Annotations (A-1..A-5)

Highlights are annotation child items with `annotationType`,
`annotationPosition` (JSON: `pageIndex` + `rects` for PDF; `FragmentSelector`
with the CFI for EPUB), `annotationText`, `annotationSortIndex`.

Text-locating (A-1) searches extracted page text for the quote, then derives
rects. Where exact rects cannot be derived, return an error rather than an
annotation at a guessed position — a wrong-position highlight is worse than a
refusal. Area annotations (A-2) take caller-supplied PDF-user-space rects
directly. Non-PDF/EPUB attachments are rejected naming the content type.

### Mutations (E-2, W-9, W-14)

One promise-chain queue serializes every write:

```ts
enqueue<T>(label: string, fn: () => Promise<T>): Promise<T>
```

Multi-save operations run inside `Zotero.DB.executeTransaction`. This is how W-9
gets atomic related-links **for free**: both `item.addRelatedItem(other)` and
`other.addRelatedItem(item)` saves live in one transaction, so a second-side
failure rolls back the first. No manual compensation logic — which is what both
zotero-mcp and zotero-mcp-ts got wrong by doing two independent saves.

Batch `operations[]` (W-5) executes sequentially through the queue with
per-operation results, so a mid-batch failure reports exactly what did and did
not apply. Every mutating result carries a changed-fields summary (W-14).

### `zotero_script` (X-1..X-4)

`new Function("Zotero", "env", body)` invoked with the real `Zotero` and a small
`env` (log, libraryID, shouldStop, remainingMs). `mode: write` routes through the
write queue; `mode: read` runs directly. Timeout via `Promise.race` (default 30 s,
max 120 s), exceptions returned as tool errors with stack, description echoed
back. No approval gate, no undo instrumentation — deliberate, per decision.

## Data Flow

`tools/call library_search` (full-text mode):

```
POST /zotmcp/mcp
  → Zotero.Server (socket, decode, JSON parse)
  → endpoint.init(options)
  → protocol/dispatch  method=tools/call
  → registry.get("library_search").handler(args, ctx)
  → searchService.fulltext(query, limit, offset)
      → gateway.newSearch(userLibraryID)  + fulltextContent + resolveToParents
      → gateway.fulltextSnippet(itemID, query)
  → itemResolver validates each hit is My Library
  → uriService.buildItemUris(item)
  → ToolResult (JSON content)
  → [200, "application/json", body]
```

`tools/call library_update kind:'related'`:

```
handler → mutationService.enqueue("related")
        → Zotero.DB.executeTransaction(async () => {
              a.addRelatedItem(b); await a.save();
              b.addRelatedItem(a); await b.save();     // throw ⇒ both roll back
          })
        → changed-summary result
```

## Tradeoffs

- **Hand-rolled JSON-RPC over the MCP SDK.** ~200 lines and zero Node
  assumptions, versus losing SDK-tracked protocol updates. Both prior-art
  plugins made the same call.
- **Sharing Zotero's port instead of our own socket.** Gains: no HTTP parsing, no
  UTF-8 bugs, no second port, no firewall surface. Costs: a hard dependency on
  Zotero's connector server being enabled, no response headers, and an endpoint
  on a port browsers already reach — which, with ungated writes, is the single
  largest risk in this design.
- **Stateless.** Simplifies everything and matches the endpoint API's lack of
  response headers. Cost: no server-initiated messages, ever. Nothing in scope
  needs them.
- **One global write queue.** Correctness over throughput. Zotero's data layer is
  effectively single-threaded, so parallel writes buy little and risk much.
- **Eleven modal tools over ~50 narrow ones.** Small context cost, no toolset
  gating machinery. Cost: fatter per-tool schemas and mode-validation logic.
- **Refuse rather than guess on annotation placement.** Fewer successful
  highlights, no silently misplaced ones.

## Risks And Mitigations

| Risk                                                | Mitigation                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Ungated writes on a browser-reachable port          | Loopback only; prominent README/prefs warning; keep bearer auth as a designed-in future option (single check in `endpoint.init`) |
| `Zotero.PDFWorker` shape changes across versions    | Confined to `pdfService`; three-step fallback chain; integration test asserts `{text, pageChars}`                                |
| PDF text unavailable for scanned files              | Three-step fallback then `NoTextLayerError` naming the cause (R-6)                                                               |
| CFI parity errors put highlights in the wrong place | Fixture-based unit tests on the parity rule; refuse rather than guess                                                            |
| EPUB replaced ⇒ stale CFIs                          | Always compute against the current file; never reuse a stored CFI for a new annotation                                           |
| Long reads/searches blow client context             | Hard caps + pagination everywhere (E-3, R-7)                                                                                     |
| Zotero busy / sync in progress                      | Bounded queue wait, then actionable error (E-2)                                                                                  |
| Surface drift                                       | Registry-generated `tools/list` + exact-surface test + vocabulary scanner                                                        |

## Verification

1. `npm run build` (scaffold build + `tsc --noEmit`) must pass.
2. **Unit tests, fake gateway, no Zotero:** JSON-RPC parsing incl. array
   rejection; dispatch table; exact-surface and vocabulary tests; URI builder
   incl. page/annotation params; search-argument mapping; CFI generation
   fixtures; Markdown→note HTML; error mapping.
3. **Integration tests, real Zotero (`zotero-plugin test`):** endpoint
   registration/unregistration; `initialize`→`tools/list`; stateless
   `tools/call` with no prior initialize; group-key refusal; PDF fulltext and
   page-range against a fixture PDF; PDF and EPUB highlight round trips;
   related-link atomicity with an injected second-side failure; import by DOI;
   trash/restore; CJK/emoji round trip.
4. **Manual smoke:** connect a real MCP client to
   `http://127.0.0.1:23119/zotmcp/mcp`, list tools, run one read and one write.
5. **Spike, before its dependent task:** Zotero 8 esbuild/Gecko target.

## Open Questions

- Should the prefs pane show the ready-to-paste client config
  (`http://127.0.0.1:<port>/zotmcp/mcp`)? Cheap and useful; not currently a
  requirement.
