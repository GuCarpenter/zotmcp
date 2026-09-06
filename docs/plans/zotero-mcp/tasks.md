# Tasks: Zotero MCP Plugin (`zotmcp`)

Implements `design.md` against `specs.md`. Each task is one focused edit.
"Covers" lists the spec IDs a task satisfies.

Order matters: phases 1–3 produce a callable server with one tool, so every later
phase can be verified end to end against a real MCP client.

---

## Phase 0 — Spike

- [x] 0.1 Confirm Zotero 8's Gecko/Firefox base and set the esbuild target
      accordingly. **Result: Zotero 8 is built on Firefox 140 ESR** (Zotero 7.0 =
      115, the "7.1" beta = 128), per Zotero 8 for Developers. Target set to
      `firefox140`. Related platform facts recorded in `design.md`.

## Phase 1 — Project skeleton

- [x] 1.1 `package.json`: scaffold + esbuild + TypeScript + mocha; deps
      `zotero-plugin-toolkit`, `fflate` (EPUB unzip), `marked` (Markdown→HTML).
      Scripts: `build` (`zotero-plugin build && tsc --noEmit`), `start`, `test`,
      `test:unit`.
- [x] 1.2 `tsconfig.json`, `eslint`/`prettier` config, `.gitignore`
      (include `.scaffold/`).
- [x] 1.3 `addon/manifest.json`: WebExtension-style manifest, addon ID,
      `strict_min_version` 8.0. Covers: proposal decision (Zotero 8 minimum).
- [x] 1.4 `addon/bootstrap.js` + `zotero-plugin.config.ts`: entry `src/index.ts`,
      bundle output, target from task 0.1.
- [x] 1.5 `addon/prefs.js`: `mcp.server.enabled` default `true`. No write gate
      pref. Covers: S-2, S-11.
- [x] 1.6 `typings/`: minimal ambient declarations for `Zotero`, `IOUtils`, and
      the `Zotero.Server` endpoint contract.
- [x] 1.7 Verify `npm run build` produces an XPI and `tsc --noEmit` is clean.

## Phase 2 — Gateway and cross-cutting services

These come before the server because every tool depends on them, and they are the
modules that make the spec's structural guarantees hold.

- [x] 2.1 `src/services/zoteroGateway.ts`: the **only** module referencing global
      `Zotero`. Wrap item/collection/search/DB/PDFWorker/Fulltext access behind an
      interface so tests can substitute a fake.
- [x] 2.2 `src/errors.ts`: typed errors — `NotFoundError`,
      `GroupLibraryUnsupportedError`, `NoTextLayerError`, `InvalidArgumentError`,
      `FileMissingError`, `TimeoutError` — each carrying an actionable message
      naming the offending value. Covers: E-1.
- [x] 2.3 `src/services/itemResolver.ts`: `resolveItem` / `resolveAttachment` /
      `resolveCollection`, each looking up in `Zotero.Libraries.userLibraryID` and
      asserting `libraryID === userLibraryID` so a group key can never fall
      through to a same-keyed My Library object. Covers: LB-1, LB-2.
- [x] 2.4 `src/services/uriService.ts`: `buildItemUris(item)` and
      `buildAnnotationUri(...)`. Emit only the `library` path segment; convert
      Zotero's 0-based `pageIndex` to 1-based here. No group branch exists.
      Covers: U-1, U-2, U-3, U-5.
- [x] 2.5 `test/unit/uriService.test.ts`: select/open/open-pdf forms, `?page=`
      1-based conversion, `?annotation=`, combined params. Covers: U-1..U-3.
- [x] 2.6 `test/unit/itemResolver.test.ts`: group-library key is refused with
      `GroupLibraryUnsupportedError`, not silently resolved. Covers: LB-2.
- [x] 2.7 `src/services/mutationService.ts`: promise-chain write queue
      `enqueue(label, fn)` with a bounded wait, plus a
      `runInTransaction(fn)` helper over `Zotero.DB.executeTransaction`.
      Covers: E-2.
- [x] 2.8 `test/unit/mutationService.test.ts`: two concurrent enqueues never
      interleave; bounded wait produces `TimeoutError`. Covers: E-2.

## Phase 3 — Transport, protocol, registry

- [x] 3.1 `src/protocol/jsonRpc.ts`: request parse, response/error builders,
      standard codes; reject JSON-RPC batch arrays with `-32600`.
      Covers: S-7 (batch clause), E-4.
- [x] 3.2 `src/protocol/capabilities.ts`: protocol version negotiation capped at
      `2025-06-18`; advertise `tools` and `resources` only. Covers: S-4, S-5.
- [x] 3.3 `src/tools/registry.ts`: `ToolSpec` type (`name`, `description`,
      `inputSchema`, `mutability`, `handler`), `register()`, `list()`.
      `tools/list` output is generated, never hand-written. Covers: S-9.
- [x] 3.4 `src/protocol/dispatch.ts`: `initialize`, `notifications/*` (accepted,
      no error), `ping`, `tools/list`, `tools/call`, `resources/list`,
      `resources/read`; unknown method → `-32601`. Pure function of
      `(method, params)` + injected services — no per-client state, so
      `tools/call` works without a prior `initialize`. Covers: S-6, S-8.
- [x] 3.5 `src/protocol/dispatch.ts`: map tool failures to a `tools/call` result
      with `isError: true`, distinct from JSON-RPC protocol errors. Covers: E-4.
- [x] 3.6 `src/transport/endpoint.ts`: endpoint class with
      `supportedMethods = ["POST"]`, `supportedDataTypes = ["application/json"]`,
      `init(options) => [status, contentType, body]`; accept `options.data` as
      object or string. Covers: S-1, S-7 (method/content-type delegation).
- [x] 3.7 `src/transport/httpServerCheck.ts`: probe Zotero's HTTP server; on
      disabled, emit a notification popup, an error log naming the preference, and
      set state for the prefs-pane banner. No fallback socket. Covers: S-3.
- [x] 3.8 `src/hooks.ts` + `src/index.ts`: register the endpoint after
      `Zotero.initializationPromise` and `uiReadyPromise`; warn if the path is
      already occupied; delete the endpoint key on shutdown; restart on
      `mcp.server.enabled` change. Covers: S-1, S-2.
- [x] 3.9 `src/tools/index.ts`: register all eleven tools with real names,
      descriptions and schemas; a handler that is not implemented yet throws an
      error naming its phase. Registering the full surface immediately is what
      lets task 3.11 lock it from the start.
- [x] 3.10 `test/unit/protocol.test.ts`: batch rejection, unknown method,
      malformed JSON, `initialize` shape, `tools/call` with no prior
      `initialize`, two concurrent independent calls. Covers: S-4..S-8.
- [x] 3.11 `test/unit/toolSurface.test.ts`: registry names equal a frozen array of
      the eleven tool names — fails when a tool is added or renamed.
      Covers: S-9.
- [x] 3.12 `test/unit/toolVocabulary.test.ts`: no tool name, description, or
      schema contains semantic / embedding / vector / undo / approval /
      confirmation / group library / OpenAlex. Covers: S-12.
- [ ] 3.13 Manual checkpoint: connect a real MCP client to
      `http://127.0.0.1:23119/zotmcp/mcp`, complete `initialize`, and see
      `tools/list`.

## Phase 4 — Search

- [ ] 4.1 `src/services/searchService.ts`: keyword search via
      `quicksearch-titleCreatorYear`, ranked, `limit`/`offset`, default 25, hard
      cap 100, always scoped to the user library. Covers: SR-1, LB-3, E-3.
- [ ] 4.2 `searchService`: pass-through `conditions[]` with
      `joinMode: all | any`. Covers: SR-2.
- [ ] 4.3 `searchService`: compile a boolean tag expression into tag conditions +
      joinMode. Covers: SR-3.
- [ ] 4.4 `searchService`: citation-key lookup against the `Extra`
      `Citation Key:` line; when BetterBibTeX is absent, return an explanatory
      result rather than an opaque failure. Covers: SR-4.
- [ ] 4.5 `searchService`: full-text search via `fulltextContent` **with
      resolve-to-parents** (matches are attachments and vanish otherwise), plus a
      bounded snippet cut around each hit. Covers: SR-5.
- [ ] 4.6 `searchService`: annotation search by text/color/tag, resolved to parent
      item plus page/location. Covers: SR-6.
- [ ] 4.7 `searchService`: `entity: collections` flat and recursive tree with item
      counts; `entity: tags` with counts; both paginated. Covers: SR-7, E-3.
- [ ] 4.8 `searchService`: `filters.deleted` trash listing. Covers: SR-8.
- [ ] 4.9 `src/tools/librarySearch.ts`: full schema over all modes and entities;
      attach URIs to every returned record; explicit empty-result shape.
      Covers: SR-9, U-1.
- [ ] 4.10 `test/unit/searchService.test.ts`: argument→condition mapping for every
      mode, limit capping, resolve-to-parents present on child-matching
      conditions. Covers: SR-1..SR-8.

## Phase 5 — Reading

- [ ] 5.1 `src/services/pdfService.ts`: `getText()` chain —
      `Zotero.PDFWorker.getFullText(id)` → `{text, pageChars}`, then Zotero's
      full-text cache, then `NoTextLayerError` naming a scanned PDF as the likely
      cause. Covers: R-2, R-6.
- [ ] 5.2 `pdfService`: page-range slicing on cumulative `pageChars`, with
      form-feed splitting as fallback and an explicit "page boundaries
      approximate" flag when used. Covers: R-3.
- [ ] 5.3 `src/services/epubService.ts`: `IOUtils.read` → `fflate` unzip →
      `container.xml` → `.opf` → spine order → XHTML→text. Covers: R-2.
- [ ] 5.4 `epubService`: `sections` grouped by spine document. Covers: R-5.
- [ ] 5.5 `src/services/readService.ts`: sectioned item read — `metadata`,
      `abstract`, `children`, `attachments` (content type, on-disk path, URIs),
      `tags`, `notes`, `annotations`; any subset selectable. Covers: R-1, U-2.
- [ ] 5.6 `src/tools/libraryRead.ts`: section selection schema + URIs.
      Covers: R-1.
- [ ] 5.7 `src/tools/paperRead.ts`: modes `fulltext`, `pages`, `sections`;
      `sections` on a PDF errors and points at `pages`/`fulltext`; output caps
      with in-band truncation reporting. Covers: R-2, R-3, R-5, R-7.
- [ ] 5.8 `test/unit/pdfService.test.ts`: `pageChars` slicing math, form-feed
      fallback, fallback-chain ordering with a fake gateway. Covers: R-2, R-3.
- [ ] 5.9 `test/unit/epubService.test.ts`: spine ordering and text extraction
      against a small fixture EPUB. Covers: R-2, R-5.

## Phase 6 — Annotations and notes

- [ ] 6.1 `src/services/epubCfi.ts`: CFI generator — DOM-position-tracking
      parser, element parity `(i+1)*2` / text-node parity `1+2*i`,
      `epubcfi(/6/<spine*2>!/<steps>,<start>,<end>)` assembly. Covers: A-3, U-4.
- [ ] 6.2 `test/unit/epubCfi.test.ts`: fixture-based parity and offset tests —
      the failure mode here is a silently misplaced highlight. Covers: A-3.
- [ ] 6.3 `src/services/annotationService.ts`: create PDF highlight by locating
      text and deriving rects; **error rather than guess** when exact rects
      cannot be derived. Covers: A-1.
- [ ] 6.4 `annotationService`: create area annotation from caller-supplied
      PDF-user-space rects + page. Covers: A-2.
- [ ] 6.5 `annotationService`: create EPUB highlight storing the CFI in a WADM
      `FragmentSelector`; return the CFI in the result. Covers: A-3, U-4.
- [ ] 6.6 `annotationService`: update (comment, color, tags) and delete (trash) by
      annotation key; reject non-PDF/non-EPUB attachments naming the content
      type. Covers: A-4, A-5.
- [ ] 6.7 `src/tools/annotationWrite.ts`: modal schema over create-text /
      create-rect / create-epub / update / delete; route through the write queue;
      return keys and URIs. Covers: A-1..A-5, U-3, E-2.
- [ ] 6.8 `src/services/noteService.ts`: Markdown→Zotero note HTML via `marked`
      plus sanitization; create / update / append. Covers: A-6.
- [ ] 6.9 `src/tools/noteWrite.ts`: parent item or attachment context, correct
      child parenting. Covers: A-6, A-7.
- [ ] 6.10 `test/unit/noteService.test.ts`: Markdown conversion, append
      idempotence, sanitization. Covers: A-6.

## Phase 7 — Writes

- [ ] 7.1 `src/services/importService.ts`: identifier import (DOI/ISBN/arXiv/
      PMID/URL) through Zotero's own translators; return the created item with
      URIs. Covers: W-1.
- [ ] 7.2 `importService`: local file as imported-file or linked-file attachment
      on a parent. Covers: W-2.
- [ ] 7.3 `importService`: manual creation with field validation against the item
      type, rejecting an invalid field **with the list of valid fields**.
      Covers: W-3.
- [ ] 7.4 `src/tools/libraryImport.ts`: `kind: identifiers | files | manual`,
      optional target collection. Covers: W-1..W-3.
- [ ] 7.5 `src/services/libraryMutation/metadata.ts`: field and creator updates
      reporting each changed field. Covers: W-4, W-14.
- [ ] 7.6 `src/services/libraryMutation/tags.ts`: item tags add / remove / set
      (full replace). Covers: W-6.
- [ ] 7.7 `src/services/libraryMutation/tagObject.ts`: library-wide tag rename /
      merge / delete / set color. Covers: W-7.
- [ ] 7.8 `src/services/libraryMutation/parent.ts`: reparent note or attachment,
      or detach to top level. Covers: W-8.
- [ ] 7.9 `src/services/libraryMutation/related.ts`: both `addRelatedItem` saves
      inside **one** `Zotero.DB.executeTransaction`, so a second-side failure
      rolls back the first and no half-link can exist. Covers: W-9.
- [ ] 7.10 `src/tools/libraryUpdate.ts`: `kind` facade + batch `operations[]`
      executed sequentially through the write queue with per-operation results.
      Covers: W-4..W-9, W-14, E-2.
- [ ] 7.11 `src/services/collectionService.ts`: create (optional parent), rename,
      move, delete with explicit `deleteItems` opt-in defaulting to leaving items
      in place; add/remove membership. Covers: W-10, W-11.
- [ ] 7.12 `src/tools/collectionUpdate.ts`: action facade. Covers: W-10, W-11.
- [ ] 7.13 `src/tools/libraryDelete.ts` + service: `mode: trash | restore |
merge` (merge into a designated master). Covers: W-12.
- [ ] 7.14 `src/tools/attachmentUpdate.ts` + service: rename file on disk, relink
      to a new path, delete (trash); `FileMissingError` when the file is absent.
      Covers: W-13, E-1.
- [ ] 7.15 `test/unit/related.test.ts`: injected second-side failure leaves item A
      unchanged — the regression test for the half-link bug both prior-art
      projects have. Covers: W-9.
- [ ] 7.16 `test/unit/libraryUpdate.test.ts`: batch per-operation results,
      including a mid-batch failure reporting exactly what applied.
      Covers: W-5, W-14.

## Phase 8 — Script tool and resources

- [ ] 8.1 `src/tools/zoteroScript.ts`: `new Function("Zotero", "env", body)` with
      a minimal `env` (log, libraryID, shouldStop, remainingMs); `mode: write`
      routes through the write queue, `mode: read` runs directly; no approval
      gate. Covers: X-1.
- [ ] 8.2 `zoteroScript`: `Promise.race` timeout (default 30 s, max 120 s) →
      `TimeoutError`; exceptions returned as tool errors with message and stack;
      description echoed verbatim; non-serializable return values coerced or
      reported, never silently dropped. Covers: X-2, X-3, X-4.
- [ ] 8.3 `src/resources/index.ts`: `zotero://collections`,
      `zotero://items/{itemKey}`, `zotero://collections/{collectionKey}/items`
      for `resources/list` and `resources/read`. Covers: S-10.
- [ ] 8.4 `test/unit/zoteroScript.test.ts`: timeout, thrown-exception mapping,
      description echo. Covers: X-2..X-4.

## Phase 9 — Preferences UI

- [ ] 9.1 `addon/content/preferences.xhtml` + `src/modules/preferences.ts`: server
      enable toggle, read-only display of the connection URL
      `http://127.0.0.1:<httpServer.port>/zotmcp/mcp`, and the
      HTTP-server-disabled banner from task 3.7. Covers: S-2, S-3.
- [ ] 9.2 Prefs pane security notice: writes and `zotero_script` are ungated, so
      any local process reaching Zotero's port has full library access.
      Covers: proposal risk register.

## Phase 10 — Integration tests

Run in a real Zotero via `zotero-plugin test`.

- [ ] 10.1 Endpoint registration and clean unregistration on shutdown.
      Covers: S-1, S-2.
- [ ] 10.2 HTTP-server-disabled path fails loudly and opens no socket.
      Covers: S-3.
- [ ] 10.3 `initialize` → `tools/list` returns exactly eleven tools; a
      `tools/call` with no prior `initialize` succeeds. Covers: S-4, S-6, S-9.
- [ ] 10.4 A group-library key is refused by every tool family. Covers: LB-2.
- [ ] 10.5 PDF fulltext and page-range read against a fixture PDF; a scanned PDF
      yields `NoTextLayerError`. Covers: R-2, R-3, R-6.
- [ ] 10.6 EPUB fulltext and `sections`; `sections` on a PDF errors.
      Covers: R-2, R-5.
- [ ] 10.7 PDF highlight round trip: created annotation exists, renders at the
      quoted sentence, result carries key + `?annotation=` URI.
      Covers: A-1, U-3.
- [ ] 10.8 EPUB highlight round trip: stored `FragmentSelector` contains
      `epubcfi(...)`, highlight renders, CFI returned. Covers: A-3, U-4.
- [ ] 10.9 Related-link atomicity against real `Zotero.DB` with an injected
      second-side failure. Covers: W-9.
- [ ] 10.10 Import by DOI creates one item, filed in the target collection, with
      URIs. Covers: W-1.
- [ ] 10.11 Trash then restore round trip via `filters.deleted`.
      Covers: SR-8, W-12.
- [ ] 10.12 Mutating tool succeeds on default preferences with no gate or
      confirmation. Covers: S-11.
- [ ] 10.13 CJK + emoji round trip through search, read, note append, and
      annotation create. Covers: S-13.
- [ ] 10.14 Group-library item never appears in any search result. Covers: LB-3.

## Verification Tasks

- [ ] V.1 `npm run build` — scaffold build plus `tsc --noEmit`, clean.
- [ ] V.2 `npm run test:unit` — all unit tests pass.
- [ ] V.3 `npm test` — typecheck plus unit plus integration tests pass.
- [ ] V.4 Lint/format clean.
- [ ] V.5 Manual smoke with a real MCP client: `initialize`, `tools/list`, one
      read tool, one write tool, one `resources/read`.
- [ ] V.6 Install the built XPI into a clean Zotero 8 profile and confirm
      first-run behavior: endpoint live, writes working, no configuration needed.
      Covers: S-11.
- [ ] V.7 Confirm `tools/list` contains exactly the eleven tools and no
      out-of-scope vocabulary. Covers: S-9, S-12.
- [ ] V.8 README: connection URL, Zotero 8 requirement, the ungated-write
      security warning, and the eleven-tool list generated from the registry
      rather than hand-written.
