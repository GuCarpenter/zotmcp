import zotero from "@zotero-plugin/eslint-config";
import globals from "globals";

export default zotero({
  overrides: [
    {
      ignores: [
        ".scaffold/**",
        "node_modules/**",
        "firefox-clipper/**",
        "typings/i10n.d.ts",
        "typings/prefs.d.ts",
      ],
    },
    {
      files: ["scripts/**/*.mjs"],
      languageOptions: {
        globals: globals.node,
      },
    },
  ],
});
