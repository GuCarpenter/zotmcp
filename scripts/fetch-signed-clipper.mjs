/**
 * Download an already-signed unlisted XPI from AMO and (optionally) attach it to
 * a GitHub release. Use this to recover a signed build when the release
 * workflow's signing step failed after AMO had already accepted the version.
 *
 * Usage:
 *   WEB_EXT_API_KEY=<issuer> WEB_EXT_API_SECRET=<secret> \
 *     node scripts/fetch-signed-clipper.mjs [version] [addonId]
 *
 * Defaults: version from firefox-clipper/manifest.json, addonId from its
 * browser_specific_settings.gecko.id. Writes zotmcp-clipper-v<version>.xpi.
 */

import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(root, "firefox-clipper", "manifest.json"), "utf8"),
);

const version = process.argv[2] || manifest.version;
const addonId =
  process.argv[3] || manifest.browser_specific_settings?.gecko?.id;

const issuer = process.env.WEB_EXT_API_KEY;
const secret = process.env.WEB_EXT_API_SECRET;

if (!issuer || !secret) {
  console.error(
    "Set WEB_EXT_API_KEY (issuer) and WEB_EXT_API_SECRET (secret).",
  );
  process.exit(1);
}
if (!addonId) {
  console.error("No add-on id; pass it as the second argument.");
  process.exit(1);
}

const b64url = (input) => Buffer.from(input).toString("base64url");

function makeJwt() {
  const header = { alg: "HS256", typ: "JWT" };
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    jti: crypto.randomBytes(8).toString("hex"),
    iat,
    exp: iat + 60,
  };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  return `${data}.${signature}`;
}

async function amo(path) {
  const url = path.startsWith("http")
    ? path
    : `https://addons.mozilla.org${path}`;
  const response = await fetch(url, {
    headers: { Authorization: `JWT ${makeJwt()}` },
  });
  if (!response.ok) {
    throw new Error(`AMO ${url} -> ${response.status} ${response.statusText}`);
  }
  return response;
}

const base = `/api/v5/addons/addon/${encodeURIComponent(addonId)}`;
console.error(`Looking up ${addonId} version ${version}…`);

const listing = await (
  await amo(`${base}/versions/?filter=all_with_unlisted`)
).json();
const match = (listing.results || []).find((v) => v.version === version);
if (!match) {
  const seen = (listing.results || []).map((v) => v.version).join(", ");
  throw new Error(`Version ${version} not found. Available: ${seen || "none"}`);
}

const file = match.file || (match.files && match.files[0]);
if (!file?.url) {
  throw new Error(
    `Version ${version} has no downloadable file yet (still signing?).`,
  );
}

console.error(`Downloading signed file: ${file.url}`);
const bytes = Buffer.from(await (await amo(file.url)).arrayBuffer());
const out = join(root, `zotmcp-clipper-v${version}.xpi`);
writeFileSync(out, bytes);
console.error(`Saved ${out} (${bytes.length} bytes).`);
console.log(out);
