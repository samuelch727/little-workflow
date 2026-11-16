#!/usr/bin/env node
import { main } from "./cli/main.js";
import { safeMessage } from "./cli/auth.js";
main(process.argv.slice(2)).catch((error) => {
  console.error(safeMessage(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
