#!/usr/bin/env node

// OpenPaw entry wrapper - checks Node version and imports entry point

const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  console.error(`OpenPaw requires Node.js >= 22. Current: ${process.version}`);
  process.exit(1);
}

// In dev mode, use tsx to run TypeScript directly
// In production, use compiled dist/
try {
  await import("./dist/entry.js");
} catch {
  try {
    const { register } = await import("node:module");
    register("tsx/esm", import.meta.url);
    await import("./src/entry.ts");
  } catch (e) {
    console.error("OpenPaw: Could not load entry point. Run 'pnpm build' or 'pnpm dev'.");
    console.error(e.message);
    process.exit(1);
  }
}
