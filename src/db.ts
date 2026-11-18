import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./local.ts";
export function openDb(readOnly = false) {
  const path = join(stateDir(), "jobs.sqlite");
  if (!readOnly) mkdirSync(stateDir(), { recursive: true });
  if (readOnly && !existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly });
  db.exec("PRAGMA busy_timeout=10000");
  if (!readOnly) {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON",
    );
    atomic(db, () => {
      const v = db.prepare("PRAGMA user_version").get()!.user_version;
      if (Number(v) > 4) throw Error("Unknown database version");
      for (const n of [1, 2, 3, 4])
        if (Number(v) < n)
          db.exec(
            readFileSync(
              new URL("../migrations/00" + n + ".sql", import.meta.url),
              "utf8",
            ),
          );
    });
  }
  return db;
}
export function atomic<T>(db: DatabaseSync, f: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = f();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function status() {
  const db = openDb(true);
  if (!db) return { jobs: [], intents: [], policy: [] };
  try {
    return {
      jobs: db
        .prepare(
          `SELECT j.id,j.session,json_extract(j.details,'$.spike.score') score,json_extract(j.details,'$.spike.contributions') contributions,json_extract(j.details,'$.spike.startMs') startMs,json_extract(j.details,'$.spike.endMs') endMs,coalesce(i.state,j.state) state,coalesce(i.reason,j.reason) reason,j.result,j.evaluation,j.intent FROM jobs j LEFT JOIN intents i ON i.id=j.intent ORDER BY score DESC,j.rowid DESC`,
        )
        .all(),
      intents: db.prepare("SELECT * FROM intents ORDER BY id DESC").all(),
      policy: db.prepare("SELECT * FROM policy").all(),
      cooldowns: db.prepare("SELECT * FROM cooldown").all(),
    };
  } finally {
    db.close();
  }
}
