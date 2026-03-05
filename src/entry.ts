#!/usr/bin/env node

process.title = "openpaw";

// Prevent unhandled promise rejections from crashing the process
process.on("unhandledRejection", (err) => {
  console.error("[Fatal] Unhandled rejection:", err);
});

import { buildProgram } from "./cli.js";

const program = buildProgram();
program.parse(process.argv);
