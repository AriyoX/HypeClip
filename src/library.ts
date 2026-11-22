import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { sharedHome } from "./capture-slots.ts";
import { jsonFile } from "./local.ts";

export function libraryDb() {
  const dir = join(sharedHome(), "studio");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "library.sqlite"));
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,path TEXT UNIQUE,added INTEGER); CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,config TEXT,enabled INTEGER DEFAULT 0,saved INTEGER DEFAULT 0,state TEXT,reason TEXT,updated INTEGER); CREATE TABLE IF NOT EXISTS studio_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  return db;
}
export function registerExport(folder: string) {
  const path = resolve(folder);
  if (
    !existsSync(join(path, "results.json")) ||
    !existsSync(join(path, "origin.json"))
  )
    throw Error("Incomplete clip export");
  const id = createHash("sha256").update(path).digest("hex").slice(0, 24);
  const db = libraryDb();
  try {
    db.prepare("INSERT OR IGNORE INTO exports VALUES(?,?,?)").run(
      id,
      path,
      Date.now(),
    );
  } finally {
    db.close();
  }
  return id;
}
export function exportDetails(id: string, path: string) {
  const info = jsonFile(join(path, "results.json")),
    origin = jsonFile(join(path, "origin.json"));
  const file = readdirSync(path).find((f) => f.endsWith(".mp4"));
  if (!file) throw Error("Exported MP4 missing");
  const raw =
    info.rawDecision ??
    info.firstPass?.decision?.decision ??
    info.evaluation?.decision;
  return {
    id,
    path,
    file: join(path, file),
    name: info.source.channel,
    origin,
    info,
    classification:
      info.manualEdit ||
      info.override ||
      (info.selection?.trim && info.selection.trim !== "automatic")
        ? "Manually adjusted"
        : "Automatic first pass",
    raw,
    settings: jsonFile(join(path, "edit-settings.json")),
  };
}
