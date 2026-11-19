// Preloaded only in verification subprocesses. Any attempted publisher operation is counted and fails locally.
import { appendFileSync } from "node:fs";
import { liveAdapter } from "../../src/publisher.ts";
function forbidden(operation) {
  return async () => {
    appendFileSync(process.env.HYPECLIP_CALL_LOG, operation + "\n");
    throw Error("Unexpected publisher call: " + operation);
  };
}
liveAdapter.host = forbidden("upload");
for (const method of ["channel", "create", "read", "matches"])
  liveAdapter.provider[method] = forbidden(method);
