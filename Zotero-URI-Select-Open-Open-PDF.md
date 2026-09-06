# Zotero URI Select Open Open PDF

Zotero's `zotero://` protocol provides application actions that can be used in notes, exported HTML, scripts, and extensions. The three most useful actions for navigating a library are `select`, `open`, and `open-pdf`.

## `zotero://select/`

`select` activates Zotero's main library window and selects an item, collection, or saved search. It is a library-navigation action rather than a file URL.

### Select an item

Personal library:

```text
zotero://select/library/items/ITEM_KEY
```

Group library:

```text
zotero://select/groups/GROUP_ID/items/ITEM_KEY
```

An item can also be selected within a collection or saved search:

```text
zotero://select/library/collections/COLLECTION_KEY/items/ITEM_KEY
zotero://select/library/searches/SEARCH_KEY/items/ITEM_KEY
```

Multiple item keys can be passed with the query parameter form:

```text
zotero://select/library/items?itemKey=ITEM_KEY_1,ITEM_KEY_2
```

### Select a collection or saved search

```text
zotero://select/library/collections/COLLECTION_KEY
zotero://select/library/searches/SEARCH_KEY
zotero://select/groups/GROUP_ID/collections/COLLECTION_KEY
zotero://select/groups/GROUP_ID/searches/SEARCH_KEY
```

The older forms below are deprecated:

```text
zotero://select/items/ITEM_ID
zotero://select/items/LIBRARY_ID_ITEM_KEY
```

Use library/group paths and item keys for new links.

## `zotero://open/`

`open` opens a file attachment in its associated handler. For PDFs and EPUBs, Zotero normally opens the built-in Reader unless an external reader is configured. The attachment key must identify the attachment item, not its parent article.

```text
zotero://open/library/items/ATTACHMENT_KEY
zotero://open/groups/GROUP_ID/items/ATTACHMENT_KEY
```

The same generic form can open an EPUB at a document position.

EPUB CFI:

```text
zotero://open/library/items/EPUB_ATTACHMENT_KEY?cfi=ENCODED_EPUB_CFI
```

EPUB CSS selector:

```text
zotero://open/library/items/EPUB_ATTACHMENT_KEY?sel=ENCODED_CSS_SELECTOR
```

An existing EPUB annotation can be selected with its Zotero annotation key:

```text
zotero://open/library/items/EPUB_ATTACHMENT_KEY?annotation=ANNOTATION_KEY
```

An annotation key identifies the Zotero annotation item. A CFI or CSS selector identifies a position in the EPUB. They are different kinds of identifiers.

## `zotero://open-pdf/`

`open-pdf` opens a PDF attachment in Zotero's PDF Reader and supports PDF navigation parameters. It uses the same internal handler as `open`, but the name makes the PDF intent explicit.

```text
zotero://open-pdf/library/items/PDF_ATTACHMENT_KEY
zotero://open-pdf/groups/GROUP_ID/items/PDF_ATTACHMENT_KEY
```

### Open a page

The URI page number is one-based:

```text
zotero://open-pdf/library/items/PDF_ATTACHMENT_KEY?page=12
```

Internally Zotero converts this to the zero-based `pageIndex` used by the Reader.

### Open and select an annotation

```text
zotero://open-pdf/library/items/PDF_ATTACHMENT_KEY?annotation=ANNOTATION_KEY
```

Page and annotation can be combined:

```text
zotero://open-pdf/library/items/PDF_ATTACHMENT_KEY?page=12&annotation=ANNOTATION_KEY
```

The `annotation` value is the key of the Zotero annotation child item. Zotero uses it to select the annotation and navigate to its position. If the page is omitted, Zotero can generally obtain the page from the annotation's stored position.

### Other recognized parameters

The shared `open`/`open-pdf` handler also recognizes:

```text
cfi=...
sel=...
```

These are intended for EPUB positions and are not normally useful for PDFs. Unknown query parameters are ignored. There are no documented URI parameters for PDF zoom, Reading Mode, font size, sidebar state, or opening in a new window.

The older ZotFile-compatible form is also supported:

```text
zotero://open-pdf/LIBRARY_ID_ITEM_KEY/PAGE
```

For example:

```text
zotero://open-pdf/12345_ABCD1234/12
```

## Programmatic API equivalents

Within a Zotero plugin, prefer the JavaScript API when possible because it avoids URI encoding and gives direct control over options.

Select an item through the main pane:

```javascript
await Zotero.getMainWindow().ZoteroPane.selectItems([item.id]);
```

Open a PDF page or annotation:

```javascript
await Zotero.FileHandlers.open(attachment, {
  location: {
    pageIndex: 11,
    annotationID: annotation.key,
  },
});
```

Open an EPUB at a CFI:

```javascript
await Zotero.FileHandlers.open(epubAttachment, {
  location: {
    position: {
      type: "FragmentSelector",
      conformsTo: "http://www.idpf.org/epub/linking/cfi/epub-cfi.html",
      value: cfi,
    },
  },
});
```

## Implementation notes

The built-in protocol handler is implemented in `ZoteroProtocolHandler.mjs`.

```text
zotero://select/       -> selects objects in the main library
zotero://open/         -> opens a generic attachment or EPUB location
zotero://open-pdf/     -> opens a PDF page or annotation
```

These URI actions should not be confused with `zotero://attachment/`, which serves an attachment file or snapshot resource directly and does not itself open or navigate the Reader.

## References

- Zotero source: `chrome/content/zotero/ZoteroProtocolHandler.mjs`
- Zotero source: `chrome/content/zotero/xpcom/fileHandlers.js`
- Zotero source: `chrome/content/zotero/xpcom/uri.js`
- Zotero documentation: [Zotero JavaScript API](https://www.zotero.org/support/dev/client_coding/javascript_api)

## Related

- [[Zotero-Plugin-Development]] - plugin APIs can use the same navigation and Reader-opening operations programmatically
