import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfiguration } from "../src/connections.ts";

const cwd = process.cwd();
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hypeclip-connections-"));
  vi.stubEnv("HYPECLIP_HOME", home);
  vi.stubEnv("HYPECLIP_ISOLATED", undefined);
  vi.stubEnv("TWITCH_USER_TOKEN", undefined);
  vi.stubEnv("YOUTUBE_API_KEY", undefined);
  vi.stubEnv("BUFFER_ACCESS_TOKEN", undefined);
  process.chdir(home);
});
afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it("saves provider values locally and preserves launch and checkout configuration", () => {
  const legacy =
    "TWITCH_USER_TOKEN=legacy-token\nYOUTUBE_API_KEY=legacy-youtube";
  writeFileSync(".env", legacy);
  vi.stubEnv("TWITCH_USER_TOKEN", "launch-token");
  const connections = loadConfiguration();
  expect(() =>
    connections.save({ TWITCH_USER_TOKEN: "override-token" }),
  ).toThrow("launch environment");
  connections.save({ YOUTUBE_API_KEY: "setup-key" });
  expect(process.env.YOUTUBE_API_KEY).toBe("setup-key");
  expect(JSON.stringify(connections.status())).not.toContain("setup-key");
  expect(readFileSync(".env", "utf8")).toBe(legacy);

  vi.stubEnv("YOUTUBE_API_KEY", undefined);
  const restarted = loadConfiguration();
  expect(process.env.YOUTUBE_API_KEY).toBe("setup-key");
  restarted.save({ YOUTUBE_API_KEY: null });
  vi.stubEnv("YOUTUBE_API_KEY", undefined);
  loadConfiguration();
  expect(process.env.YOUTUBE_API_KEY).toBeFalsy();
  expect(process.env.TWITCH_USER_TOKEN).toBe("launch-token");
});

it("rejects unknown settings and honors isolated launches", () => {
  const connections = loadConfiguration();
  expect(() =>
    connections.save({
      PATH: "arbitrary-path",
      BUFFER_ACCESS_TOKEN: "test-buffer-key",
    }),
  ).toThrow();
  expect(process.env.BUFFER_ACCESS_TOKEN).toBeUndefined();
  expect(() => connections.save({ BUFFER_ACCESS_TOKEN: "x" })).toThrow(
    "full token or key",
  );
  connections.save({ BUFFER_ACCESS_TOKEN: "test-buffer-key" });

  vi.stubEnv("BUFFER_ACCESS_TOKEN", undefined);
  vi.stubEnv("HYPECLIP_ISOLATED", "1");
  const isolated = loadConfiguration();
  expect(process.env.BUFFER_ACCESS_TOKEN).toBeUndefined();
  expect(() =>
    isolated.save({ BUFFER_ACCESS_TOKEN: "new-buffer-key" }),
  ).toThrow("HYPECLIP_ISOLATED");
});
