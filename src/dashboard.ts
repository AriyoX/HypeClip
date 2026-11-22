import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { execFile, fork, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createReadStream,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { captureStatus, setCaptureLimit, sharedHome } from "./capture-slots.ts";
import { exportDetails, libraryDb, registerExport } from "./library.ts";
import {
  inspectSource,
  watchRows,
  type CheckedSource,
} from "./dashboard-sources.ts";
import { previewSource } from "./source-preview.ts";
import { ChannelEdit } from "./editorial.ts";
import { EditSettings } from "./review-export.ts";
import { providerRows } from "./providers.ts";
import { localModel, safeMessage, writeJson } from "./local.ts";
import type { Connections } from "./connections.ts";
import { guidedSetup, setupActions } from "./guided-setup.ts";
import { clipStorage } from "./clip-storage.ts";
import { dashboardPublishing } from "./dashboard-publishing.ts";
import {
  dashboardActivity,
  newActivity,
  trackActivity,
} from "./dashboard-activity.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = () => join(sharedHome(), "studio");

function openStudio(url: string) {
  const command =
    process.platform === "win32"
      ? "rundll32.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  execFile(command, args, { windowsHide: true }, (error) => {
    if (error) console.log("Open " + url + " in your browser.");
  });
}

async function isStudioRunning(url: string) {
  try {
    const response = await fetch(url + "/api/state", {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) return false;
    const state = await response.json();
    return (
      Array.isArray(state.clips) &&
      Array.isArray(state.sources) &&
      typeof state.slots?.limit === "number"
    );
  } catch {
    return false;
  }
}
type Task = {
  state: string;
  reason: string;
  updated: number;
  child?: ChildProcess;
  activity?: ReturnType<typeof newActivity>;
};
type Export = ReturnType<typeof exportDetails>;
function publicClip(c: Export) {
  const i = c.info;
  return {
    id: c.id,
    name: c.name,
    title: i.caption,
    classification: c.classification,
    path: c.file,
    platform: i.source.platform,
    sourceUrl: i.source.broadcastUrl ?? i.source.url,
    broadcast: i.source.broadcastId ?? i.source.file ?? i.source.url,
    eventTime:
      i.selection?.eventMs == null
        ? null
        : (i.source.archiveOffsetMs ?? 0) + i.selection.eventMs,
    sourceStart: i.archiveFromMs ?? i.fromMs,
    sourceEnd: i.archiveToMs ?? i.toMs,
    fromMs: i.fromMs,
    toMs: i.toMs,
    payoff: i.payoffMs - i.fromMs,
    duration: i.render.durationMs,
    layout:
      i.layout?.chosen ??
      (i.splitScreen ? "Facecam + gameplay" : "Gameplay only"),
    layoutReason: i.layout?.reason ?? i.compositionReview,
    decision:
      i.validatedDecision ?? i.evaluation?.decision?.decision ?? "review",
    model:
      i.actualModel ?? (i.evaluation?.decision ? i.evaluation?.model : null),
    reason: i.validationReason ?? i.rationale,
    settings: c.settings,
    splitScreen: i.splitScreen,
    selection: i.selection,
    mode: i.mode,
    boundary: i.boundary,
    override: i.manualEdit ?? i.override,
    availableProfile: i.splitScreen ?? undefined,
    sha256: i.sha256,
    scene: i.sceneCaption,
    audio: i.audio,
  };
}
async function body(req: IncomingMessage) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 32000) throw Error("Request too large");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString() || "{}");
}
async function mediaFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  type: string,
  download = false,
) {
  const size = statSync(path).size;
  let a = 0,
    b = size - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (match) {
      if (match[1]) {
        a = Number(match[1]);
        b = match[2] ? Math.min(b, Number(match[2])) : b;
      } else if (match[2]) a = Math.max(0, size - Number(match[2]));
    }
    if (!match || (!match[1] && !match[2]) || a > b || a >= size) {
      res.writeHead(416, { "Content-Range": "bytes */" + size }).end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${a}-${b}/${size}`);
  }
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Length", b - a + 1);
  res.setHeader("Content-Type", type);
  if (download)
    res.setHeader(
      "Content-Disposition",
      "attachment; filename*=UTF-8''" + encodeURIComponent(basename(path)),
    );
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeline(createReadStream(path, { start: a, end: b }), res).catch(
    () => {},
  );
}
export async function dashboard(
  port: number,
  connections: Connections,
  open: boolean,
) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("Use a dashboard port from 1024 to 65535");
  const url = "http://127.0.0.1:" + port;
  const db = libraryDb(),
    lock = new DatabaseSync(join(root(), "dashboard.lock.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    db.close();
    if (open && (await isStudioRunning(url))) {
      openStudio(url);
      return;
    }
    throw Error(
      "HypeClip dashboard is already running. Open its existing localhost tab.",
    );
  }
  const hosts = new Set(["127.0.0.1:" + port, "localhost:" + port]);
  const setup = guidedSetup(),
    storage = clipStorage(db),
    active = new Map<string, Task>(),
    inspected = new Map<string, CheckedSource>();
  let publishing = dashboardPublishing();
  const secrets = new Set<string>();
  function rememberSecrets() {
    for (const [key, value] of Object.entries(process.env))
      if (
        value?.trim() &&
        /TOKEN|SECRET|PASSWORD|ACCESS_KEY|API_KEY/i.test(key)
      )
        secrets.add(value.trim());
  }
  rememberSecrets();
  const watchlist = watchRows();
  const previews = new Map<string, Export>(),
    rendering = new Map<string, Task>(),
    cache = new Map<string, Export>();
  let roster = watchlist.map((r) => ({
    name: r.name,
    pinned: r.pinned,
    english: r.english,
    broadcasts: [] as string[],
    state: "Monitoring off",
  }));
  const listSources = () =>
    db.prepare("SELECT * FROM sources ORDER BY rowid").all();
  const setState = (id: string, state: string, reason = "") =>
    db
      .prepare("UPDATE sources SET state=?,reason=?,updated=? WHERE id=?")
      .run(state, reason, Date.now(), id);
  function clip(id: string) {
    if (previews.has(id)) return previews.get(id)!;
    if (cache.has(id)) return cache.get(id)!;
    const r = db.prepare("SELECT path FROM exports WHERE id=?").get(id);
    if (!r) throw Error("Clip no longer in library");
    const c = exportDetails(id, String(r.path));
    cache.set(id, c);
    return c;
  }
  function sourceAction(
    s: CheckedSource,
    save: boolean,
    enable: boolean,
    rights: boolean,
  ) {
    if (enable && (!rights || !s.eligible))
      throw Error(
        s.reason || "Confirm permission and source eligibility first",
      );
    const old = db.prepare("SELECT * FROM sources WHERE id=?").get(s.id);
    if (old?.enabled || active.has(s.id)) return;
    if (!save && !enable) throw Error("Choose Save source or Monitor once");
    const config = {
      source: s,
      rights: rights ? "Confirmed private local capture and editing" : "",
      home: "",
      exports: "",
    };
    db.prepare(
      "INSERT INTO sources(id,config,enabled,saved,state,reason,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,enabled=excluded.enabled,saved=max(saved,excluded.saved),state=excluded.state,reason=excluded.reason,updated=excluded.updated",
    ).run(
      s.id,
      JSON.stringify(config),
      Number(enable),
      Number(save),
      enable ? "Waiting" : "Saved",
      s.reason,
      Date.now(),
    );
  }
  function launch(row: ReturnType<typeof listSources>[number]) {
    const id = String(row.id),
      cfg = JSON.parse(String(row.config));
    if (!cfg.home) {
      cfg.home = join(root(), "runs", id, randomUUID());
      cfg.exports = join(storage.status().folder, basename(cfg.home));
      db.prepare("UPDATE sources SET config=? WHERE id=?").run(
        JSON.stringify(cfg),
        id,
      );
    }
    const file = join(cfg.home, "task.json");
    writeJson(file, cfg);
    const child = fork(join(repo, "src", "dashboard-task.ts"), [file], {
      cwd: repo,
      execArgv: [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
      ],
      env: { ...process.env, HYPECLIP_HOME: cfg.home },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const task = {
      state: "Starting",
      reason: "",
      updated: Date.now(),
      child,
      activity: newActivity(),
    };
    active.set(id, task);
    setState(id, task.state);
    let finished = false;
    const stages: Record<string, string> = {
      ffmpeg: "Processing media",
      whisper: "Transcribing",
      ollama: "Evaluating",
    };
    child.on("message", (msg: any) => {
      if (!msg || !msg.event) return;
      trackActivity(task.activity, msg, cfg.home, cfg.source);
      const label =
        msg.event === "stage-start"
          ? (msg.phase ?? stages[msg.stage])
          : (
              {
                acquiring: "Acquiring recording",
                shortlist: "Shortlisted",
                source: msg.access === "blocked" ? "Unavailable" : "Monitoring",
                trigger: "Waiting for post-roll",
                "post-roll-ready": "Preparing clip",
                decision: "Exporting",
                exported: "Monitoring",
                watchlist: "Monitoring",
                "input-error": "Unavailable",
                "capture-error": "Waiting",
                "chat-unavailable": "Media-only detection",
                "export-error": "Export error",
                complete: "Finished",
                stopped: "Stopped",
                failed: "Unavailable",
              } as Record<string, string>
            )[msg.event];
      if (msg.roster) roster = msg.roster;
      if (label) {
        task.state = label;
        task.updated = Date.now();
        task.reason =
          msg.event === "complete" &&
          [...task.activity.streams.values()].some(
            (s) => s.state === "No highlight found",
          )
            ? "No highlight found in this scan"
            : String(
                msg.reason ??
                  msg.error ??
                  (msg.event === "source" ? msg.media : ""),
              );
        setState(id, label, task.reason);
      }
      if (["complete", "stopped", "failed"].includes(msg.event)) {
        finished = true;
        const retry =
          msg.event === "failed" &&
          (/occupied|already being captured/i.test(task.reason) ||
            (cfg.source.form.kind === "url" && !cfg.source.archive));
        if (retry) setState(id, "Waiting", task.reason);
        else db.prepare("UPDATE sources SET enabled=0 WHERE id=?").run(id);
      }
    });
    child.once("error", (e) => {
      setState(id, "Unavailable", safeMessage(e));
    });
    child.once("exit", () => {
      active.delete(id);
      if (!finished)
        setState(id, "Waiting", "Worker interrupted; resuming saved work");
    });
  }
  let closing = false;
  const tick = () => {
    if (closing) return;
    const cap = captureStatus();
    for (const row of listSources()) {
      if (!row.enabled || active.has(String(row.id))) continue;
      if (
        row.state === "Waiting" &&
        row.reason &&
        Date.now() - Number(row.updated) < 15000
      )
        continue;
      const cfg = JSON.parse(String(row.config));
      if (
        cfg.source.form.kind !== "watchlist" &&
        (cap.active.length >= cap.limit ||
          [...active.keys()].filter((k) => k !== "watchlist").length >=
            cap.limit)
      )
        continue;
      launch(row);
    }
  };
  const timer = setInterval(() => {
    try {
      tick();
    } catch (e) {
      console.error(safeMessage(e));
    }
  }, 1500);
  async function snapshot() {
    const errors: string[] = [],
      clips = [];
    for (const row of db
      .prepare("SELECT id,added FROM exports ORDER BY added DESC,rowid DESC")
      .all()) {
      try {
        const c = publicClip(clip(String(row.id)));
        if (!existsSync(c.path) || !statSync(c.path).size)
          throw Error("Missing video for " + c.name);
        const review = db
          .prepare("SELECT decision FROM reviews WHERE id=?")
          .get(c.id);
        clips.push({
          ...c,
          review: review?.decision,
          added: Number(row.added),
        });
      } catch (e) {
        errors.push(safeMessage(e));
      }
    }
    const savedSources = listSources();
    const sources = savedSources.map((row) => {
      const cfg = JSON.parse(String(row.config));
      return {
        id: row.id,
        name: cfg.source.name,
        platform: cfg.source.platform,
        enabled: !!row.enabled,
        saved: !!row.saved,
        state: row.state,
        reason: row.reason,
        updated: row.updated,
        form: cfg.source.form,
        ...dashboardActivity(
          active.has(String(row.id)) ? cfg.home : "",
          active.get(String(row.id))?.activity,
        ),
      };
    });
    const slots = captureStatus();
    const managedHomes = new Set(
      savedSources.map((r) => JSON.parse(String(r.config)).home),
    );
    for (const slot of slots.active) {
      if (!managedHomes.has(slot.home))
        sources.push({
          id: "cli-" + slot.slot,
          name: slot.source || "CLI recording",
          platform: "CLI",
          enabled: true,
          saved: false,
          state: "Capturing",
          reason: "Command-line monitor",
          updated: slot.started,
          form: { kind: "external" },
          ...dashboardActivity(slot.home, undefined, slot.source),
        });
    }
    const setupStatus = setup.status();
    let model = "Unconfigured";
    try {
      model = localModel().model || model;
    } catch {
      model = "Check Ollama configuration";
    }
    return {
      sources,
      clips,
      slots: { limit: slots.limit, used: slots.active.length },
      watchlist: watchlist.map(({ name, pinned, channels }) => ({
        name,
        pinned,
        channels: channels.map(({ url, platform }) => ({ url, platform })),
      })),
      roster: roster.map((r) => ({
        ...r,
        state: !sources.some((s) => s.id === "watchlist" && s.enabled)
          ? "Monitoring off"
          : slots.active.some((s) => r.broadcasts?.includes(s.source))
            ? "Capturing"
            : r.state === "Eligible"
              ? "Waiting for a capture slot or ranking priority"
              : r.state,
      })),
      providers: providerRows(setupStatus.tools?.streamlink || null),
      errors,
      renders: [...rendering].map(([id, v]) => ({
        id,
        state: v.state,
        reason: v.reason,
        updated: v.updated,
      })),
      model,
      publishing: publishing.status(),
      setup: setupStatus,
      connections: connections.status(),
      storage: storage.status(),
    };
  }
  const server = createServer(async (req, res) => {
    const respond = (data: unknown, code = 200) => {
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify(data, (_key, value) => {
          if (typeof value !== "string") return value;
          for (const secret of secrets)
            value = value.split(secret).join("[redacted]");
          return value;
        }),
      );
    };
    try {
      if (!hosts.has(req.headers.host ?? "")) {
        respond({ error: "Use the local dashboard address" }, 403);
        return;
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      const u = new URL(req.url ?? "/", url),
        path = u.pathname;
      if (req.method === "GET" || req.method === "HEAD") {
        if (path === "/api/state") {
          respond(await snapshot());
          return;
        }
        if (path === "/guide") {
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
          });
          res.end(readFileSync(join(repo, "Start Here.html")));
          return;
        }
        const details = /^\/api\/clip-details\/([\w-]+)$/.exec(path);
        if (details) {
          const c = clip(details[1]);
          respond({
            model: c.info.actualModel ?? c.info.evaluation?.model,
            raw: c.raw,
            modelResponse: c.info.modelResponse,
            evidenceTrace: c.info.evidenceTrace,
            chat: c.info.chat,
          });
          return;
        }
        const frame = /^\/source-frame\/([a-f0-9-]{36})$/.exec(path);
        if (frame) {
          await mediaFile(
            req,
            res,
            join(root(), "source-previews", frame[1] + ".jpg"),
            "image/jpeg",
          );
          return;
        }
        const m =
          /^\/media\/([\w-]+)\/(video|download|poster|scene|cleared)$/.exec(
            path,
          );
        if (m) {
          const c = clip(m[1]),
            video = ["video", "download"].includes(m[2]);
          await mediaFile(
            req,
            res,
            video
              ? c.file
              : join(
                  c.path,
                  (
                    {
                      poster: "payoff.jpg",
                      scene: "scene-visible.jpg",
                      cleared: "scene-cleared.jpg",
                    } as Record<string, string>
                  )[m[2]],
                ),
            video ? "video/mp4" : "image/jpeg",
            m[2] === "download",
          );
          return;
        }
        const assets: Record<string, [string, string]> = {
          "/": ["index.html", "text/html; charset=utf-8"],
          "/app.js": ["app.js", "text/javascript; charset=utf-8"],
          "/ui.js": ["ui.js", "text/javascript; charset=utf-8"],
          "/publishing.js": ["publishing.js", "text/javascript; charset=utf-8"],
          "/setup.js": ["setup.js", "text/javascript; charset=utf-8"],
          "/style.css": ["style.css", "text/css; charset=utf-8"],
          "/fonts/barlow-condensed-700.woff2": [
            "fonts/barlow-condensed-700.woff2",
            "font/woff2",
          ],
          "/fonts/dm-sans.woff2": ["fonts/dm-sans.woff2", "font/woff2"],
        };
        if (Object.hasOwn(assets, path)) {
          const [file, type] = assets[path];
          res.writeHead(200, {
            "Content-Type": type,
            "Cache-Control": "no-cache",
          });
          res.end(readFileSync(join(repo, "dashboard", file)));
          return;
        }
        respond({ error: "Unknown page" }, 404);
        return;
      }
      if (
        req.method !== "POST" ||
        req.headers.origin !== "http://" + req.headers.host ||
        req.headers["content-type"] !== "application/json"
      ) {
        respond({ error: "Use the dashboard controls on localhost" }, 403);
        return;
      }
      const b = await body(req);
      if (path === "/api/setup") {
        const action = z.enum(setupActions).parse(b.action);
        if (setup.status().action) throw Error("Setup is already running.");
        void setup.run(action);
        respond(setup.status(), 202);
        return;
      }
      if (path === "/api/connections") {
        const changed = connections.save(b);
        rememberSecrets();
        if (
          changed.includes("BUFFER_ACCESS_TOKEN") ||
          changed.includes("BUFFER_CHANNEL_ID")
        )
          publishing = dashboardPublishing();
        respond({ ok: true });
        return;
      }
      if (path === "/api/inspect") {
        const s = await inspectSource(b);
        inspected.set(s.id, s);
        respond(s);
        return;
      }
      if (path === "/api/pick") {
        const filter = b.chat
          ? "Timestamped chat (*.jsonl)|*.jsonl"
          : "Recordings (*.mp4;*.mkv;*.mov;*.ts;*.webm)|*.mp4;*.mkv;*.mov;*.ts;*.webm";
        const folder = b.folder === true;
        const cmd =
          "Add-Type -AssemblyName System.Windows.Forms; " +
          (folder
            ? "$d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Choose a folder for finished clips'; "
            : "$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter='" +
              filter +
              "'; ") +
          "if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Write($d." +
          (folder ? "SelectedPath" : "FileName") +
          ") }";
        const { stdout } = await promisify(execFile)(
          "powershell.exe",
          ["-NoProfile", "-STA", "-Command", cmd],
          { windowsHide: true, timeout: 300000 },
        );
        respond({ path: stdout.trim() });
        return;
      }
      if (path === "/api/source-preview") {
        const row = db
          .prepare("SELECT config FROM sources WHERE id=?")
          .get(String(b.id));
        if (!row) throw Error("Save the source first");
        const s = JSON.parse(String(row.config)).source as CheckedSource;
        const prefs = ChannelEdit.pick({
          layoutMode: true,
          splitScreen: true,
          gameplayCrop: true,
          subtitleY: true,
          dialogue: true,
        }).parse(b.settings);
        respond(await previewSource(s, join(root(), "source-previews"), prefs));
        return;
      }
      if (path === "/api/source") {
        if (b.stop) {
          db.prepare(
            "UPDATE sources SET enabled=0,state='Stopped',reason='',updated=? WHERE id=?",
          ).run(Date.now(), String(b.id));
          active.get(b.id)?.child?.send("stop");
          respond({ ok: true });
          return;
        }
        const row = db
          .prepare("SELECT config FROM sources WHERE id=?")
          .get(String(b.id));
        const s =
          inspected.get(b.id) ??
          (row ? JSON.parse(String(row.config)).source : undefined);
        if (!s) throw Error("Check the source before starting");
        if (b.settings && s.form.kind === "watchlist")
          throw Error("Set per-creator crop profiles in docs/watchlist.json");
        if (b.settings) {
          s.form.settings = ChannelEdit.pick({
            layoutMode: true,
            splitScreen: true,
            dialogue: true,
            subtitleY: true,
            gameplayCrop: true,
            narration: true,
            context: true,
          }).parse(b.settings);
        }
        sourceAction(s, !!b.save, !!b.enable, b.rights === true);
        tick();
        respond({ ok: true });
        return;
      }
      if (path === "/api/check-output") {
        await publishing.check();
        respond(publishing.status());
        return;
      }
      if (path === "/api/find-destinations") {
        const current = publishing;
        const channels = await current.find();
        if (current !== publishing)
          throw Error("Buffer settings changed. Find channels again.");
        respond({ channels, publishing: publishing.status() });
        return;
      }
      if (path === "/api/limit") {
        setCaptureLimit(z.number().int().parse(b.limit));
        respond({ ok: true });
        return;
      }
      if (path === "/api/clip-folder") {
        const folder = z
          .string()
          .trim()
          .min(1)
          .max(4096)
          .nullable()
          .parse(b.folder);
        respond(storage.save(folder));
        return;
      }
      if (path === "/api/open-clip-folder") {
        const { folder, custom } = storage.status();
        if (custom) {
          if (!existsSync(folder) || !statSync(folder).isDirectory())
            throw Error(
              "Connect the drive or choose another clips folder in Settings.",
            );
        } else mkdirSync(folder, { recursive: true });
        const command =
          process.platform === "win32"
            ? "explorer.exe"
            : process.platform === "darwin"
              ? "open"
              : "xdg-open";
        const child = spawn(command, [folder], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        await new Promise<void>((ready, fail) => {
          child.once("error", fail);
          child.once("spawn", ready);
        });
        child.unref();
        respond({ ok: true });
        return;
      }
      if (path === "/api/folder") {
        const c = clip(b.id);
        spawn("explorer.exe", [c.path], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        }).unref();
        respond({ ok: true });
        return;
      }
      if (path === "/api/review") {
        const c = clip(b.id);
        db.prepare("INSERT OR REPLACE INTO reviews VALUES(?,?,?)").run(
          c.id,
          "Reviewed unchanged",
          Date.now(),
        );
        respond({ ok: true });
        return;
      }
      if (path === "/api/render") {
        const c = clip(String(b.id)),
          settings = EditSettings.parse({
            ...c.settings,
            ...b.settings,
            note: "Dashboard presentation edit",
          });
        const key = randomUUID(),
          dir = join(root(), "previews", key),
          file = join(dir, "settings.json");
        writeJson(file, settings);
        const status = {
          state: "Rendering preview",
          reason: "",
          updated: Date.now(),
        };
        rendering.set(key, status);
        void promisify(execFile)(
          process.execPath,
          [
            "--disable-warning=ExperimentalWarning",
            "--experimental-strip-types",
            "cli.ts",
            "export",
            c.origin.id,
            "--to",
            dir,
            "--name",
            "preview",
            "--edit",
            file,
            "--preview-only",
          ],
          {
            cwd: repo,
            env: { ...process.env, HYPECLIP_HOME: c.origin.state },
            windowsHide: true,
            timeout: 600000,
          },
        )
          .then(() => {
            previews.set(key, exportDetails(key, join(dir, "preview")));
            status.state = "Preview ready";
          })
          .catch((e) => {
            status.state = "Render failed";
            status.reason = safeMessage(
              new Error(String(e.stderr || e.message)),
            );
          });
        respond({ id: key }, 202);
        return;
      }
      if (path === "/api/save") {
        const preview = previews.get(b.id);
        if (!preview) throw Error("Render a preview first");
        const rootDir = join(storage.status().folder, "Versions");
        mkdirSync(rootDir, { recursive: true });
        const dest = join(rootDir, b.id);
        if (!existsSync(dest)) {
          const staging = join(rootDir, ".save-" + randomUUID());
          cpSync(preview.path, staging, {
            recursive: true,
            errorOnExist: true,
          });
          renameSync(staging, dest);
        }
        respond({ id: registerExport(dest) });
        return;
      }
      respond({ error: "Unknown action" }, 404);
    } catch (e) {
      if (!res.headersSent) respond({ error: safeMessage(e) }, 400);
      else res.end();
    }
  });
  db.exec(
    "CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,decision TEXT,at INTEGER)",
  );
  const close = () => {
    closing = true;
    clearInterval(timer);
    for (const t of active.values()) t.child?.send("stop");
    server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await setup.run("check");
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(port, "127.0.0.1", () => {
        console.log(url);
        if (open) openStudio(url);
        ok();
      });
    });
    await new Promise<void>((ok) => server.once("close", ok));
    await Promise.all(
      [...active.values()].map(
        (t) => new Promise<void>((ok) => t.child?.once("exit", () => ok())),
      ),
    );
  } finally {
    clearInterval(timer);
    db.close();
    lock.close();
  }
}
