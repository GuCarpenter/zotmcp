"use strict";

// Firefox exposes the extension API as `browser`; fall back to `chrome`.
const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULT_ENDPOINT = "http://127.0.0.1:23119/zotmcp/mcp";

const els = {
  url: document.getElementById("pageUrl"),
  collection: document.getElementById("collection"),
  embed: document.getElementById("embed"),
  endpoint: document.getElementById("endpoint"),
  save: document.getElementById("save"),
  status: document.getElementById("status"),
};

let currentTab = null;

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = kind || "muted";
}

async function getActiveTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

/** Call an MCP tool over the zotmcp JSON-RPC endpoint and return its result. */
async function callTool(endpoint, name, args) {
  const request = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name, arguments: args },
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Marks this as a trusted client request. Without it Zotero's HTTP
        // server refuses requests that carry an Origin header (its cross-site
        // guard); this is the same header the official connector sends.
        "X-Zotero-Connector-API-Version": "3",
      },
      body: JSON.stringify(request),
    });
  } catch {
    throw new Error(
      "Could not reach Zotero. Is it running, and is the zotmcp plugin installed?",
    );
  }

  if (!response.ok) {
    throw new Error(`Endpoint returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message || "JSON-RPC error.");
  }

  const result = payload.result;
  if (result && result.isError) {
    const text = (result.content || [])
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n");
    throw new Error(text || "The import tool reported an error.");
  }
  return result;
}

function notify(title, message) {
  try {
    api.notifications.create({
      type: "basic",
      iconUrl: api.runtime.getURL("icons/icon-96.png"),
      title,
      message: message.slice(0, 300),
    });
  } catch {
    // Notifications are a nicety; ignore if the permission is unavailable.
  }
}

async function save() {
  if (!currentTab || !/^https?:/i.test(currentTab.url || "")) {
    setStatus("Only http(s) pages can be saved.", "err");
    return;
  }

  const endpoint = (els.endpoint.value || DEFAULT_ENDPOINT).trim();
  const collection = els.collection.value.trim();
  await api.storage.local.set({ endpoint, collection });

  els.save.disabled = true;
  setStatus("Saving… Zotero is rendering the page.", "muted");

  const args = {
    kind: "url",
    url: currentTab.url,
    embedImages: els.embed.checked,
  };
  if (collection) args.collectionKey = collection;

  try {
    const result = await callTool(endpoint, "library_import", args);
    const created =
      (result &&
        result.structuredContent &&
        result.structuredContent.created &&
        result.structuredContent.created[0]) ||
      null;
    const title =
      (created && created.title) || currentTab.title || currentTab.url;
    setStatus(`Saved: ${title}`, "ok");
    notify("Saved to Zotero", title);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    setStatus(message, "err");
    notify("Zotmcp Clipper failed", message);
  } finally {
    els.save.disabled = false;
  }
}

async function init() {
  const stored = await api.storage.local.get(["endpoint", "collection"]);
  els.endpoint.value = stored.endpoint || DEFAULT_ENDPOINT;

  currentTab = await getActiveTab();
  els.url.textContent = currentTab ? currentTab.url : "No active tab.";

  els.save.addEventListener("click", save);

  loadCollections(stored.collection);
}

/** Fill the collection dropdown from the library, nested by hierarchy. */
async function loadCollections(fallbackKey) {
  let collections;
  let selectedKey = null;
  try {
    const result = await callTool(
      (els.endpoint.value || DEFAULT_ENDPOINT).trim(),
      "library_search",
      { entity: "collections" },
    );
    collections =
      (result &&
        result.structuredContent &&
        result.structuredContent.collections) ||
      [];
    selectedKey =
      (result &&
        result.structuredContent &&
        result.structuredContent.selectedKey) ||
      null;
  } catch {
    // Leave just the "None" option if the library can't be reached yet.
    return;
  }

  // Default to the collection currently open in Zotero; fall back to the last
  // one the user picked here.
  const preselect = selectedKey || fallbackKey;

  const childrenOf = new Map();
  for (const c of collections) {
    const parent = c.parentKey || "";
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(c);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  const addLevel = (parentKey, depth) => {
    for (const c of childrenOf.get(parentKey) || []) {
      const option = document.createElement("option");
      option.value = c.key;
      option.textContent = `${"\u00A0\u00A0".repeat(depth)}${c.name}`;
      if (c.key === preselect) option.selected = true;
      els.collection.appendChild(option);
      addLevel(c.key, depth + 1);
    }
  };
  addLevel("", 0);
}

init();
