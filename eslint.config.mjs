import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      ignores: [
        ".scaffold/**",
        "node_modules/**",
        "typings/i10n.d.ts",
        "typings/prefs.d.ts",
      ],
    },
  ],
});
