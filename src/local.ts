import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";

export const stateDir = () =>
  resolve(
    process.env.HYPECLIP_HOME ||
      join(
        process.env.LOCALAPPDATA ||
          process.env.XDG_STATE_HOME ||
          join(homedir(), ".local", "state"),
        "HypeClip",
      ),
  );
export function fixturePath(p: string) {
  return /(?:^|[\\/])(?:fixtures?|tests?|demo)(?:[\\/]|$)/i.test(p);
}
export const modelFile = () =>
  join(homedir(), ".config", "hypeclip", "ollama.json");
export function jsonFile(path: string) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}
export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
export function env(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw Error("Configure " + name);
  return value;
}
export async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export function safeMessage(error: unknown) {
  let message = error instanceof Error ? error.message : "Operation failed";
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /TOKEN|SECRET|PASSWORD|ACCESS_KEY|API_KEY/i.test(key))
      message = message.split(value).join("[redacted]");
  }
  return message.replace(/https?:\/\/[^\s]+\?[^\s]+/gi, "[provider URL]").slice(0, 1500);
}
export function localModel() {
  const c = existsSync(modelFile()) ? jsonFile(modelFile()) : {};
  const baseUrl = new URL(
    process.env.OLLAMA_BASE_URL || c.baseUrl || "http://localhost:11434",
  );
  const host = baseUrl.hostname;
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    !(
      host === "localhost" ||
      host === "[::1]" ||
      (/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) &&
        /^\d+\.\d+\.\d+\.\d+$/.test(host))
    )
  )
    throw Error("OLLAMA_BASE_URL must address the local service");
  return {
    baseUrl: baseUrl.origin,
    model: process.env.OLLAMA_MODEL || c.model || "",
    verified:
      !!c.model &&
      baseUrl.origin === c.baseUrl &&
      (process.env.OLLAMA_MODEL || c.model) === c.model,
  };
}
