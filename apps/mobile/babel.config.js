module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    plugins: [
      // Lets the generated drizzle/migrations.js inline each migration's
      // .sql file as a string literal at build time (Metro/Jest never need
      // to resolve `.sql` as a module) -- see
      // docs/decisions/0012-mobile-local-storage-uses-drizzle-going-forward.md.
      ["inline-import", { extensions: [".sql"] }],
    ],
  };
};
