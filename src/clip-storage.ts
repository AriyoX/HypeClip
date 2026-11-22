import { mkdtempSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export function clipStorage(db: DatabaseSync) {
  const defaultFolder = join(homedir(), "Videos", "HypeClip", "Studio");
  const key = "clips-folder";
  const read = db.prepare("SELECT value FROM studio_settings WHERE name=?");
  const status = () => {
    const saved = read.get(key);
    return {
      folder: saved ? String(saved.value) : defaultFolder,
      custom: !!saved,
    };
  };

  return {
    status,
    save(folder: string | null) {
      if (folder === null || folder === defaultFolder) {
        db.prepare("DELETE FROM studio_settings WHERE name=?").run(key);
        return status();
      }
      if (!isAbsolute(folder))
        throw Error("Enter the full path to a clips folder.");
      let selected: string;
      try {
        selected = realpathSync(folder);
        if (!statSync(selected).isDirectory()) throw Error();
        rmdirSync(mkdtempSync(join(selected, ".hypeclip-folder-")));
      } catch {
        throw Error("Choose an existing folder you can write to.");
      }
      db.prepare(
        "INSERT INTO studio_settings(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
      ).run(key, selected);
      return status();
    },
  };
}
