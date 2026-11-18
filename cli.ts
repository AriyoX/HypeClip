#!/usr/bin/env node
import { sessionCommands } from "./src/session-cli.ts";
import { Command } from "commander";
import { existsSync } from "node:fs";
import { publisherCommands } from "./src/publish-cli.ts";
import { safeMessage } from "./src/local.ts";
const cli = new Command().name("hypeclip").version("0.1.0");
publisherCommands(cli);
sessionCommands(cli);
try {
  if (existsSync(".env")) process.loadEnvFile(".env");
  await cli.parseAsync();
} catch (e) {
  console.error(safeMessage(e));
  process.exitCode = 1;
}
