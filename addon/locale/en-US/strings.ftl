pref-title = Zotmcp
pref-server-enabled =
    .label = Enable the MCP endpoint

# Labels for Zotero's Undo/Redo menu. Shown as "Undo <label>", so each reads as
# the action that was performed. Registered with Zotero.ftl at startup.
zotmcp-undo-edit-metadata =
    { $count ->
        [one] MCP metadata change
       *[other] MCP metadata changes ({ $count })
    }
zotmcp-undo-edit-tags =
    { $count ->
        [one] MCP tag change
       *[other] MCP tag changes ({ $count })
    }
zotmcp-undo-edit-tag-library = MCP library tag change
zotmcp-undo-move-collection = MCP collection change
zotmcp-undo-edit-collection-items =
    { $count ->
        [one] MCP collection membership change
       *[other] MCP collection membership changes ({ $count })
    }
zotmcp-undo-set-parent = MCP reparent
zotmcp-undo-edit-related = MCP related-item change
zotmcp-undo-trash =
    { $count ->
        [one] MCP trash
       *[other] MCP trash ({ $count })
    }
zotmcp-undo-restore =
    { $count ->
        [one] MCP restore
       *[other] MCP restore ({ $count })
    }
zotmcp-undo-edit-note = MCP note change
zotmcp-undo-edit-annotation = MCP annotation change
zotmcp-undo-rename-attachment = MCP attachment rename
zotmcp-undo-relink-attachment = MCP attachment relink
zotmcp-undo-script = MCP script
