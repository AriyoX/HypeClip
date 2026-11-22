import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stateDir } from "./local.ts";

export const sharedHome = () =>
  join(
    process.env.LOCALAPPDATA ||
      process.env.XDG_STATE_HOME ||
      join(homedir(), ".local", "state"),
    "HypeClip",
  );
const slotDirectory = () => join(sharedHome(), "capture-slots");
function validLimit(n: number) {
  if (!Number.isInteger(n) || n < 1 || n > 8)
    throw Error("Choose a capture limit from 1 to 8");
  return n;
}
function registry<T>(
  directory: string,
  action: (db: DatabaseSync, limit: number) => T,
) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "registry.sqlite"));
  try {
    db.exec(
      "PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS settings(cap INTEGER); CREATE TABLE IF NOT EXISTS holders(slot INTEGER PRIMARY KEY, source TEXT, started INTEGER)",
    );
    if (
      !db
        .prepare("PRAGMA table_info(holders)")
        .all()
        .some((r) => r.name === "home")
    )
      db.exec("ALTER TABLE holders ADD COLUMN home TEXT");
    let row = db.prepare("SELECT cap FROM settings").get();
    if (!row) {
      const cap = validLimit(Number(process.env.HYPECLIP_CAPTURE_LIMIT || 2));
      db.prepare("INSERT INTO settings VALUES(?)").run(cap);
      row = { cap };
    }
    const result = action(db, Number(row.cap));
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}
export function tryExclusive(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec("BEGIN EXCLUSIVE");
    return () => db.close();
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode !== 5) throw error;
  }
}
function active(db: DatabaseSync, dir: string) {
  const held = [];
  for (let slot = 1; slot <= 8; slot++) {
    const path = join(dir, slot + ".sqlite");
    if (!existsSync(path)) continue;
    const release = tryExclusive(path);
    if (release) {
      release();
      continue;
    }
    const row = db
      .prepare("SELECT source,started,home FROM holders WHERE slot=?")
      .get(slot);
    held.push({
      slot,
      source: String(row?.source ?? ""),
      started: Number(row?.started ?? 0),
      home: String(row?.home ?? ""),
    });
  }
  return held;
}
export function captureStatus(dir = slotDirectory()) {
  return registry(dir, (db, limit) => ({ limit, active: active(db, dir) }));
}
export function captureLimit(dir = slotDirectory()) {
  return registry(dir, (_db, limit) => limit);
}
export function setCaptureLimit(n: number, dir = slotDirectory()) {
  validLimit(n);
  registry(dir, (db) => {
    if (active(db, dir).length > n)
      throw Error("Finish active captures before lowering the limit");
    db.prepare("UPDATE settings SET cap=?").run(n);
  });
}
export function claimCaptureSlot(directory = slotDirectory(), source = "") {
  return registry(directory, (db, limit) => {
    const held = active(db, directory);
    if (source && held.some((s) => s.source === source))
      throw Error("This broadcast is already being captured");
    if (held.length >= limit)
      throw Error("All local capture slots are occupied");
    const slot = Array.from({ length: 8 }, (_, i) => i + 1).find(
      (n) => !held.some((s) => s.slot === n),
    )!;
    const release = tryExclusive(join(directory, slot + ".sqlite"));
    if (!release) throw Error("Capture slot occupied");
    try {
      db.prepare(
        "INSERT OR REPLACE INTO holders(slot,source,started,home) VALUES(?,?,?,?)",
      ).run(slot, source, Date.now(), stateDir());
    } catch (error) {
      release();
      throw error;
    }
    return release;
  });
}
