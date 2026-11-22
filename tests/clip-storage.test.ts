import { it, expect, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clipStorage } from "../src/clip-storage.ts";
import { libraryDb } from "../src/library.ts";

it("stores a new folder across restarts without rewriting an existing export", () => {
  const home = mkdtempSync(join(tmpdir(), "hypeclip-clip-storage-"));
  vi.stubEnv("LOCALAPPDATA", home);
  try {
    const studio = join(home, "HypeClip", "studio");
    const original = join(home, "Old clips", "First video");
    const custom = join(home, "New clips");
    const file = join(home, "recording.mp4");
    mkdirSync(studio, { recursive: true });
    mkdirSync(custom);
    writeFileSync(file, "fixture");
    const old = new DatabaseSync(join(studio, "library.sqlite"));
    old.exec(
      "CREATE TABLE exports(id TEXT PRIMARY KEY,path TEXT UNIQUE,added INTEGER)",
    );
    old
      .prepare("INSERT INTO exports VALUES(?,?,?)")
      .run("old-clip", original, 1);
    old.close();

    const db = libraryDb();
    try {
      const storage = clipStorage(db);
      const defaultFolder = storage.status();
      expect(defaultFolder.custom).toBe(false);
      expect(() => storage.save(file)).toThrow("existing folder");
      expect(() => storage.save("relative")).toThrow("full path");
      expect(storage.save(custom)).toEqual({
        folder: realpathSync(custom),
        custom: true,
      });

      const reopened = libraryDb();
      try {
        expect(clipStorage(reopened).status()).toEqual(storage.status());
        expect(
          reopened.prepare("SELECT path FROM exports WHERE id='old-clip'").get()
            ?.path,
        ).toBe(original);
        expect(clipStorage(reopened).save(null)).toEqual(defaultFolder);
      } finally {
        reopened.close();
      }
    } finally {
      db.close();
    }
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
