# Zotmcp Clipper (Firefox)

A tiny Firefox extension that saves the current tab into Zotero as a clean
webpage snapshot, by calling the zotmcp plugin's import API.

It sends the page URL to zotmcp's MCP endpoint; Zotero then loads the page in a
hidden browser (so client-side content such as MathJax renders), extracts the
readable article with Defuddle, and stores a self-contained HTML snapshot with
images embedded for offline reading.

## Requirements

- Zotero running, with the **zotmcp** plugin installed.
- zotmcp's HTTP endpoint reachable at `http://127.0.0.1:23119/zotmcp/mcp`
  (Zotero's connector server, on by default).

## Install (temporary, for development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…**.
3. Select `firefox-clipper/manifest.json` from this repo.

The extension stays loaded until Firefox restarts.

## Install (signed release)

The release workflow signs the clipper through Mozilla's AMO API (unlisted
channel) and attaches `zotmcp-clipper-<version>.xpi` to the GitHub release. That
signed `.xpi` installs permanently in normal Firefox — download it and open it
with Firefox, or drag it onto `about:addons`.

Signing runs only when these repository secrets are set (from an
[AMO API credential](https://addons.mozilla.org/developers/addon/api/key/)):

- `AMO_API_KEY` — the JWT issuer.
- `AMO_API_SECRET` — the JWT secret.

Without them the workflow attaches an unsigned `.xpi` instead, which is only
loadable temporarily via `about:debugging`.

## Use

1. Open the page you want to save.
2. Click the **Zotmcp Clipper** toolbar button.
3. (Optional) In **Options**, set a target collection key, toggle image
   embedding, or change the endpoint URL.
4. Click **Save page**. The status line and a notification report the result.

## How it talks to Zotero

It POSTs a single JSON-RPC call to the endpoint:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "library_import",
    "arguments": { "kind": "url", "url": "https://example.com/article" }
  }
}
```

Zotero performs the fetch, render, extraction and storage; the extension only
supplies the URL and shows the outcome. Because Zotero re-loads the URL itself,
pages that require your browser's login session may not capture as expected.

## Talking past Zotero's cross-site guard

Zotero's HTTP server refuses requests that carry an `Origin` header unless they
identify as a trusted client. The extension therefore sends the
`X-Zotero-Connector-API-Version` header on its call — the same header the
official Zotero Connector uses — which is what makes the request accepted.
