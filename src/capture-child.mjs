// The IPC channel closes even if the coordinator is killed. Reap its capture
// before a restarted coordinator opens another UDP receiver or replay epoch.
import { spawn } from "node:child_process";
const ff = spawn(process.argv[2], process.argv.slice(3), {
  stdio: ["ignore", "ignore", "inherit"],
  windowsHide: true,
});
process.once("disconnect", () => ff.kill());
ff.once("spawn", () => {
  if (process.connected) process.send(ff.pid, () => {});
});
ff.once("error", (error) => console.error(error.message));
ff.once("close", (code) => process.exit(code ?? 1));
