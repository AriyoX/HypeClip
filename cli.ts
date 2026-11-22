#!/usr/bin/env node
import { dashboard } from "./src/dashboard.ts";
import { monitorCommands } from "./src/monitor.ts";
import { sessionCommands } from "./src/session-cli.ts";
import { Command } from "commander";
import { publisherCommands } from "./src/publish-cli.ts";
import { loadConfiguration } from "./src/connections.ts";
import { guidedSetup } from "./src/guided-setup.ts";
import { safeMessage } from "./src/local.ts";
const cli = new Command().name("hypeclip").version("0.1.0");
const studio = cli
  .command("dashboard")
  .option("--port <port>", "Local HTTP port", Number)
  .option("--open", "Open the dashboard in your browser");
cli
  .command("setup")
  .description("Install local tools and models")
  .option("--check", "Check setup without installing")
  .action(async (o) => {
    const setup = guidedSetup(console.log);
    await setup.run(o.check ? "check" : "install");
    const status = setup.status();
    console.log(JSON.stringify(status, null, 2));
    if (!status.ready || status.error) process.exitCode = 1;
  });
publisherCommands(cli);
sessionCommands(cli);
monitorCommands(cli);
try {
  const connections = loadConfiguration();
  studio.action((o) =>
    dashboard(
      o.port ?? Number(process.env.HYPECLIP_DASHBOARD_PORT || 4177),
      connections,
      o.open,
    ),
  );
  await cli.parseAsync();
} catch (e) {
  console.error(safeMessage(e));
  process.exitCode = 1;
}
