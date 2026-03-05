import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/entry.ts",
  env: { NODE_ENV: "production" },
  fixedExtension: false,
  platform: "node",
});
