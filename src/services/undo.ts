/**
 * Zotero 10's native undo stack.
 *
 * Writes made through MCP are ungated, so putting them on the same undo stack as
 * the user's own edits is the cheapest real safety net available: one extra
 * argument per save, and Ctrl+Z works in Zotero's UI.
 *
 * Two limits come from Zotero, not from here: creating an object and permanently
 * deleting one are not undoable (trashing is, since it only flips the `deleted`
 * flag). Tools whose effect is not undoable say so in their result.
 */

import type { ZoteroGateway } from "./zoteroGateway";

/** Fluent IDs from the plugin's own FTL, registered with `Zotero.ftl`. */
export const UNDO_ACTIONS = {
  editMetadata: "zotmcp-undo-edit-metadata",
  editTags: "zotmcp-undo-edit-tags",
  editLibraryTag: "zotmcp-undo-edit-tag-library",
  moveCollection: "zotmcp-undo-move-collection",
  editCollectionItems: "zotmcp-undo-edit-collection-items",
  setParent: "zotmcp-undo-set-parent",
  editRelated: "zotmcp-undo-edit-related",
  trash: "zotmcp-undo-trash",
  restore: "zotmcp-undo-restore",
  editNote: "zotmcp-undo-edit-note",
  editAnnotation: "zotmcp-undo-edit-annotation",
  renameAttachment: "zotmcp-undo-rename-attachment",
  relinkAttachment: "zotmcp-undo-relink-attachment",
  script: "zotmcp-undo-script",
} as const;

export type UndoAction = (typeof UNDO_ACTIONS)[keyof typeof UNDO_ACTIONS];

export interface UndoLabel extends Record<string, unknown> {
  undoAction: UndoAction;
  undoActionArgs?: { count?: number };
}

/** Save options for a single-object edit, so it lands on the undo stack. */
export function undoLabel(action: UndoAction, count = 1): UndoLabel {
  return { undoAction: action, undoActionArgs: { count } };
}

/**
 * Marks a multi-object transaction as one undo step. Each save inside the
 * transaction records its own changes; this supplies the label that makes them
 * collapse into a single entry at commit.
 */
export function stageUndo(
  gateway: ZoteroGateway,
  action: UndoAction,
  count = 1,
): void {
  gateway.stageUndoAction(action, { count });
}

/** Operations Zotero cannot undo, so tools can say so rather than imply it. */
export const NOT_UNDOABLE_NOTE =
  "Creating an item is not undoable in Zotero; delete it instead if unwanted.";
