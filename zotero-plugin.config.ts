import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        bundle: true,
        // Zotero 8 is built on Firefox 140 ESR (Zotero 7.0 = 115,
        // "7.1" beta = 128). manifest.json requires 8.0+, so 140-era syntax
        // is safe to emit untranspiled.
        target: "firefox140",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    entries: ["test/integration"],
    abortOnFail: false,
    exitOnFinish: true,
  },
});
