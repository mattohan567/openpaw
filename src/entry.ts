#!/usr/bin/env node

process.title = "openpaw";

import { buildProgram } from "./cli.js";

const program = buildProgram();
program.parse(process.argv);
