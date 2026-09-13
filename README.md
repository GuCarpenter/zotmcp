# zotmcp

An MCP server embedded in Zotero 10. Search, read, annotate and manage
My Library from any MCP client.

## Requirements

- Zotero 10 (`strict_min_version` 10.0)
- Zotero's HTTP server enabled — Settings → Advanced → _Allow other applications
  on this computer to communicate with Zotero_. The plugin says so loudly at
  startup if it is off, and does not open a socket of its own.

## Connecting

The endpoint lives on Zotero's own HTTP server:

```
POST http://127.0.0.1:23119/zotmcp/mcp
Content-Type: application/json
```

It speaks MCP over JSON-RPC 2.0 and is **stateless** — no session id, and
`tools/call` works without a prior `initialize`.

If the port differs, Settings → Zotmcp shows the exact URL.

Zotero 10 drops requests that look like they come from a web page: a
`User-Agent` beginning `Mozilla/`, or any `Origin` header. A client in that
position must send `Zotero-Allowed-Request: 1`, or it will see the connection
close with no response. Ordinary non-browser clients need nothing extra.

## Security

Writes are **not gated**. Any local program that can reach Zotero's HTTP server
can read and change this library through this endpoint, including running
arbitrary privileged scripts through `zotero_script`. There is no confirmation
step. The mitigations are that the server is loopback-only and that Zotero 10
blocks browser-originated requests.

Edits, trashing, merges and collection deletion all land on Zotero's own undo
stack, so Ctrl+Z reverses them — Zotero 10 trashes rather than erases, and
trashed objects can also be restored. What is **not** undoable is creating an
object and permanently deleting one from the trash. The tools say which applies
in their results.

A `zotero_script` write is not undoable by default, because a script's own
`saveTx()` calls carry no undo label. Pass `transaction: true` to run the script
inside one transaction, which makes every change it saves a single undo step; the
tradeoff is that the database is held for the script's whole run.

## Tools

Twelve modal tools, kept small so the whole surface is cheap to send on every
request. `tools/list` is generated from the registry, so this list cannot drift
from the code without failing a test.

| Tool                | Purpose                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `library_search`    | keyword, field-condition, tag, citation-key, full-text and annotation search; collections and tags; trash   |
| `library_read`      | metadata, abstract, children, attachments, tags, notes, annotations                                         |
| `paper_read`        | `fulltext`, `pages`, `sections` for PDF and EPUB                                                            |
| `reader_read`       | open reader state: attachment item, page/location, active text or annotation selection, surrounding context |
| `library_import`    | by identifier, from local files, or manual item creation                                                    |
| `library_update`    | metadata, item tags, library-wide tag ops, reparent, related links; batchable                               |
| `collection_update` | create, rename, move, delete, membership                                                                    |
| `library_delete`    | trash, restore, merge duplicates                                                                            |
| `attachment_update` | rename, relink, trash                                                                                       |
| `note_write`        | create, update, append; Markdown in                                                                         |
| `annotation_write`  | highlight by text or rects, area annotation, update, delete                                                 |
| `zotero_script`     | privileged JavaScript, `read` or `write`                                                                    |

Plus three MCP resources: `zotero://collections`,
`zotero://items/{itemKey}`, `zotero://collections/{collectionKey}/items`.

## Scope

My Library only — group libraries are refused rather than silently mixed in.
No semantic search, no external scholarly lookup, no EPUB annotation writing
(Zotero positions those by CFI, which needs a DOM path the structured text
does not expose).

Reading is built on Zotero 10's structured document text, so PDF and EPUB share
one path and sections come from the document's own outline. A text-located
highlight covers the paragraph containing the quote and reports
`granularity: "block"`, because character-precise geometry is not available from
that data.

## Icon

`addon/content/icons/icon.svg` is the source; the PNGs beside it are rendered
from it:

```sh
for s in 32 48 96; do
  inkscape --export-type=png --export-filename=addon/content/icons/icon-$s.png \
    --export-width=$s --export-height=$s addon/content/icons/icon.svg
done
```

## Design

[`docs/design.md`](docs/design.md) covers the architecture, the decisions and
their reasons, the Zotero 10 platform behaviour the implementation depends on,
and the known limitations.

## Releasing

`npm run release` behaves differently by environment. Run locally it bumps the
version, commits, tags and pushes; the tag then triggers the release workflow,
which runs the same command in CI where it instead publishes a release tagged
`v<version>` with the XPI, plus a release tagged `release` carrying
`update.json` — the URL the plugin's auto-update checks.

```sh
npm run release patch    # or minor, major, or an explicit version
```

## Development

```sh
npm install
npm run build        # bundle + typecheck, produces .scaffold/build/zotmcp.xpi
npm test             # typecheck + unit tests
npm run lint:fix
```

Unit tests run in plain Node against a fake gateway, so they need no Zotero.

Integration tests run inside a real Zotero:

```sh
cp .env.example .env   # point ZOTERO_PLUGIN_ZOTERO_BIN_PATH at a Zotero binary
npm run test:integration
```

A Flatpak install exposes no binary, so point that variable at a wrapper script
that execs `flatpak run org.zotero.Zotero "$@"`. Use a scratch profile: the tests
create and erase fixture items, and a second Zotero cannot share the running
instance's profile or its port.
