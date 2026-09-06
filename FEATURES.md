# Zotero MCP — Feature Candidate List

Union of capabilities across three prior-art projects. Delete the rows you don't want; what
remains is the scope of `zotmcp`.

Prior art keys:

- **P** = `zotero-mcp` (Python, external process, FastMCP, ~52 tools)
- **T** = `zotero-mcp-ts` (Zotero 7+ XPI, embedded HTTP server, 28 tools)
- **L** = `llm-for-zotero` (Zotero plugin, embedded MCP + in-plugin agent, 17 tools)

---

## 0. Platform decisions (pick before features)

- [x] **Process model** — Zotero plugin with embedded server (T, L)
- [x] **Transport** — streamable-HTTP, SSE, or plain HTTP JSON-RPC (T, L)
- [x] **Zotero access path** — internal Zotero JS API (T, L)
- [x] **Auth** — none (T)
- [ ] **Works with Zotero closed** — only possible with external process + SQLite/web API (P)
- [ ] **Tool-surface gating** — env var toolsets (P), prefs (T), curated subset + tiers (L)
- [ ] **Multi-library support** — personal + group libraries, switchable at runtime
- [ ] **Concurrency guard** — serialize Zotero API access; local API is single-threaded (P uses a
      reentrant lock with a bounded 45s acquire)

---

## 1. Search & discovery

- [x] Keyword / metadata item search — P `zotero_search_items`, T `search_library`, L `library_search`
- [x] Advanced multi-condition search (AND/OR over structured fields) — P `zotero_advanced_search`,
      L `library_search conditions[]`
- [x] Tag-based item search, boolean syntax — P `zotero_search_by_tag`
- [x] Citation-key (BetterBibTeX) lookup — P `zotero_search_by_citation_key`
- [x] Full-text content search with context snippets — T `search_fulltext`
- [ ] Semantic / vector search — P `zotero_semantic_search`, T `semantic_search`
- [ ] Nearest-neighbour "find similar to this item" — T `find_similar`
- [ ] Hybrid scoring (BM25 + embedding fusion, labeled match provenance) — L `library_retrieve`
- [ ] Evidence retrieval with coverage ledger (`enumerate` / `verify` / `summarize`) — L `library_retrieve`
- [ ] Embedding index build / status / inspect — P `zotero_update_search_database`, T `semantic_status`
- [ ] Recently added items — P `zotero_get_recent`
- [ ] Duplicate detection — P `zotero_find_duplicates`
- [ ] PDF-coverage audit (which items lack a PDF) — P `zotero_library_coverage`
- [x] External scholarly search (OpenAlex / arXiv / Europe PMC) — L `literature_search`
- [ ] Citation-graph traversal: references + citing works, flagged in-library — P `zotero_find_related_papers`
- [ ] Retraction check — P `scite_check_retractions`
- [ ] Citation-metric enrichment — P `scite_enrich_item`, `scite_enrich_search`

## 2. Item & library retrieval

- [x] Item metadata — P `zotero_get_item_metadata`, T `get_item_details`, L `library_read`
- [x] Full text of item (PDF / EPUB / note / webpage snapshot) — P `zotero_get_item_fulltext`,
      T `get_content`, L `paper_read`
- [x] Abstract only (cheap) — T `get_item_abstract`
- [x] Child items / attachment enumeration — P `zotero_get_item_children`, L `library_read`
- [x] Attachment file path on disk — P `zotero_get_attachment_path`
- [x] Tag list for library — P `zotero_get_tags`, L `library_search entity:'tags'`
- [ ] Related-item links (read) — P `zotero_get_item_related`
- [ ] List libraries / switch active library — P `zotero_list_libraries` + `zotero_switch_library`,
      T `get_libraries` + `search_libraries`
- [ ] RSS feeds: list + items — P `zotero_list_feeds`, `zotero_get_feed_items`
- [ ] Item-type / field schema discovery (valid fields per itemType) — L `library_search entity:'itemTypes'`
- [ ] Saved searches list — L `library_search entity:'savedSearches'`
- [x] Trash listing (prerequisite for restore) — L `library_search filters.deleted`
- [x] `zotero://select/...` deep link on every returned item — T `itemFormatter.ts`
      (note: T hardcodes `library`, breaks for group items)
- [x] support other item uri [uri](./Zotero-URI-Select-Open-Open-PDF.md)

## 3. Collections

- [x] List, flat or hierarchical tree with counts — P `zotero_get_collections`, T `get_collections`,
      L `entity:'collections' view:'tree'`
- [x] Search collections by name — P `zotero_search_collections`, T `search_collections`
- [x] Collection details / items in collection — T `get_collection_details`, `get_collection_items`
- [x] Subcollections, recursive — T `get_subcollections`
- [x] Create collection — P, T, L
- [x] Delete collection (with opt-in "also trash items") — P, T, L
- [x] Rename / move collection — T `update_collection`, L `collection_update`
- [x] Add / remove item membership — P `zotero_set_item_collections`, T `add_items_to_collection`,
      L `library_update kind:'collections'`
- [ ] Move semantics distinct from add (remove from source collection) — L `mode:'move'` + `from`

## 4. PDF & document handling

- [x] Page-range text read — P `zotero_read_pdf_pages`, L `paper_read` pages
- [x] PDF outline / table of contents — P `zotero_get_pdf_outline`
- [x] Section-aware reading (read by section name) — L `paper_read sections`
- [ ] Figure / table bbox geometry for annotation grounding — P `zotero_get_page_layout`
      (PyMuPDF `cluster_drawings` + caption matching, no ML)
- [ ] Cropped figure images for a vision model — L `paper_read mode:'figures'`
      (needs MinerU parse + native Python/Poppler runtime)
- [ ] Rendered page images / layout inspection — L `paper_read mode:'visual'`
- [ ] Currently-visible reader page capture — L `paper_read mode:'capture'`
- [ ] EPUB text extraction — P `extract.py`
- [ ] High-fidelity PDF → Markdown conversion — P `pdf-inspector` (Rust), T Zotero's own PDF worker,
      L MinerU (cloud or self-hosted, internal — not an MCP tool)
- [ ] Extracted-text cache exposed as a queryable tool — T `fulltext_database`
- [ ] Bounded overview mode (summary without dumping full text) — L `paper_read mode:'overview'`
- [ ] Exhaustive full-read mode with coverage receipt — L `paper_read mode:'full'`

## 5. Annotations & notes

- [x] Read annotations (highlights, comments, images) — P `zotero_get_annotations`, T `get_annotations`,
      L `library_read sections:['annotations']`
- [ ] Annotation fallback chain: BetterBibTeX → Zotero API → PDF extraction — P
- [x] Search annotations by text / color / tag — T `search_annotations`
- [x] Create text highlight (locate text → coordinates) — P `zotero_create_annotation`, L `annotate_pdf`
- [x] Create area / rect annotation — P `zotero_create_annotation` `rect` mode
- [x] EPUB highlight via generated CFI positions — P `epub_utils.py`
- [x] Update annotation — P `zotero_update_annotation`
- [x] Delete annotation — P `zotero_delete_annotation`
- [x] Read notes — P `zotero_get_notes`, L `library_read sections:['notes']`
- [x] Create / update / append note (Markdown → HTML) — P `zotero_manage_note`, T `write_note`,
      L `note_write`
- [ ] Batch note writing across many items, one approval — L `note_write_batch` (not over MCP)
- [ ] Per-paper annotation digest for downstream synthesis (no LLM call) — P `zotero_synthesize_annotations`
- [ ] Markdown notes written to a folder / Obsidian vault with frontmatter + citekeys — L (internal)

## 6. Writes & library management

- [x] Add by identifier: DOI / ISBN / arXiv / PMID / URL — P `zotero_add_item`, T `add_by_identifier`,
      L `library_import kind:'identifiers'`
- [ ] Import BibTeX / CSL-JSON — P `zotero_add_item`
- [x] Import local file as attachment (imported vs linked) — P `zotero_attach_file`, T `write_item`,
      L `library_import kind:'files'`
- [x] Manual item creation from fields — P, T, L `kind:'manual'`
- [x] Update item fields / creators — P `zotero_update_item`, T `write_metadata`,
      L `library_update kind:'metadata'`
- [ ] Base-field resolution per item type (`title` → `nameOfAct` / `caseName`) — P `schema.py`
- [x] Bulk / batch updates in one call — P `zotero_batch_update`, L `library_update operations[]`
- [x] Trash item — P `zotero_delete_item`, L `library_delete mode:'trash'`
- [x] Restore from trash — L `library_delete mode:'restore'`
- [x] Merge duplicates into a master — P `zotero_merge_duplicates`, L `library_delete mode:'merge'`
- [x] Tags on items: add / remove / **set** (replace whole list) — T `write_tag`,
      L `library_update kind:'tags'`
- [x] Library-wide tag object ops: rename / merge / delete / set color — L `library_update kind:'tag'`
- [x] Reparent note or attachment (or detach to top level) — P `zotero_set_item_parent`,
      L `library_update kind:'parent'`
- [x] Attachment rename / relink / delete — L `attachment_update`
- [x] Related-item links write, bidirectional — P `zotero_add_item_relation` / `..._remove_...`,
      L `library_update kind:'related'` (atomic pair + rollback)
- [ ] Bibliography / citation export via Zotero's CSL engine — P `zotero_export_bibliography`
- [ ] Background job with pollable `jobID` for long batches — T `add_by_identifier`

## 7. Safety, approval & recovery

- [ ] Human approval / confirmation card before any write — L (mandatory for all MCP writes)
- [ ] Metadata diff preview in the approval card — L `reviewCards.ts`
- [ ] Durable change journal — L `initAgentChangeJournal`
- [x] Undo last write — L `undo_last_action`
- [ ] Revert N recorded changes, with `dryRun` conflict analysis — L `revert_changes`
- [ ] Per-conversation write lock / write fence — L
- [ ] Read-result dedupe cache (same query twice → marked duplicate) — L
- [ ] Destructive-operation hints in tool annotations (`destructiveHint`, `readOnlyHint`) — L
- [ ] Write-enable master switch — T `write.enabled` pref
      (careful: T's gate misses the collection-mutation tools, incl. `delete_collection`)

## 8. Escape hatches (decide deliberately)

- [ ] Arbitrary shell command execution — L `run_command`
- [ ] Local file read / write — L `file_io`
- [x] Arbitrary privileged JS in Zotero runtime, with mandatory undo instrumentation — L `zotero_script`

## 9. MCP protocol surface

- [x] `tools/list` + `tools/call` (minimum viable)
- [ ] MCP prompts — P (4: literature review, synthesize notes, find contradictions, expand from paper)
- [x] MCP resources (`zotero://collections`, `zotero://items/{key}`, …) — P (3)
- [ ] ChatGPT connector contract (`search` / `fetch` tool names, HTTP only) — P
- [ ] Session IDs / `Mcp-Session-Id` header with idle expiry — T
- [ ] Out-of-band scope ("which paper is open") via header or tool args — L `X-LLM-For-Zotero-Scope`
- [ ] Third-party tool registration API for other plugins — L `addon.api.agent.registerTool`

## 10. Ancillary surfaces (probably out of scope)

- [ ] Standalone CLI over the same library code — P `zotero-cli` (~1% of MCP context cost)
- [ ] JSON output mode for machine consumption — P `cli_json.py`
- [ ] Client config generator for N MCP clients — T `clientConfigGenerator.ts` (12 clients)
- [ ] Agent skill / instruction-file installer — P `zotero-mcp install-skill`
- [ ] Self-update command — P `zotero-mcp update`
- [ ] Docker images — P
- [ ] MCP Registry metadata (`server.json`) — P
- [ ] Long-running batch workflows (auto-tag, audit, organize unfiled, literature review) — L `src/agent/actions/`
- [ ] Markdown skills matched against the request and injected into the prompt — L `src/agent/skills/`

---

## Cross-cutting design notes

### Semantic search — three viable architectures

|     | Index location                              | Similarity                          | Upfront cost                            | Weak spot                                                      |
| --- | ------------------------------------------- | ----------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| P   | external ChromaDB `~/.config/.../chroma_db` | ANN + optional cross-encoder rerank | embed whole library; batch-API discount | index staleness, extra GB of state                             |
| T   | own SQLite BLOBs in Zotero data dir         | brute-force in-memory cosine        | embed whole library, UI-driven          | linear scan, no ANN                                            |
| L   | none; per-item cache keyed by chunk hash    | cosine fused with BM25              | zero                                    | per-query embedding cost, recall bounded by lexical pre-filter |

If you build one: providers should be pluggable behind a registry (OpenAI / Gemini / Ollama /
local sentence-transformers). Note that ChromaDB persists the provider name in the collection
config, so provider names become a frozen compatibility surface.

### Things prior art got wrong — worth avoiding

- **T** has no authentication at all on `/mcp`, and `allowRemote` binds `0.0.0.0`.
- **T**'s write-enable pref does not cover collection mutations, including `delete_collection`.
- **T**'s `zoteroUrl` hardcodes `library`, so group-library deep links are wrong.
- **T** and **P** both write `dc:relation` in two separate saves — a failure on the second leaves a
  half-link visible on only one item. **L** does the pair atomically with rollback.
- **P**'s `zotero_find_related_papers` returns an `in_library` bool but not the matched item key,
  so linking requires one extra search per reference.
- **L** has real surface drift: `note_write_batch`, `library_cite`, `library_settings`,
  `saved_search_update`, `web_search`, `web_read` are registry-visible but neither exposed over MCP
  nor listed as excluded, and the drift test hardcodes a list that omits all six.
- Tool-count docs go stale fast (T's README says 20, source has 28). Generate the docs from the
  registry.

### Context budget

P's full 52-tool surface costs ~23k tokens per request, which is why it added toolset gating. L's
answer was a small hand-curated surface with modal tools (`paper_read mode:'…'`,
`library_update kind:'…'`) instead of many narrow tools. Decide this early — it shapes the whole
tool taxonomy.
