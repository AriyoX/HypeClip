import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CheckedSource } from "./dashboard-sources.ts";
import { jsonFile, safeMessage } from "./local.ts";

type Stream = {
  id: string;
  name: string;
  platform: string;
  state: string;
  chatMode: string;
  chatPath: string;
  archive: boolean;
  captureBase?: number;
};
type Job = { id: string; stream: string; state: string; reason: string };
export type Activity = {
  streams: Map<string, Stream>;
  jobs: Map<string, Job>;
  logs: { event: string; detail: string }[];
};
export const newActivity = (): Activity => ({
  streams: new Map(),
  jobs: new Map(),
  logs: [],
});

function jobLabel(stage: string, phase?: string) {
  if (stage === "whisper") return "Creating subtitles";
  if (stage === "ollama") return "Checking the highlight";
  if (phase === "Rendering") return "Rendering video";
  if (stage === "ffmpeg") return "Preparing video";
  return "Preparing clip";
}

export function trackActivity(
  a: Activity,
  m: Record<string, any>,
  home: string,
  source: CheckedSource,
) {
  const { event, id } = m;
  if (event === "source") {
    const archive = m.status === "archive";
    a.streams.set(id, {
      id,
      name: String(m.channel ?? source.name),
      platform: String(m.platform ?? source.platform),
      state:
        m.access === "blocked"
          ? "Unavailable"
          : archive
            ? "Scanning for highlights"
            : "Connecting to stream",
      chatMode: String(m.chat ?? ""),
      chatPath:
        source.form.chat ||
        (archive && m.platform === "kick"
          ? join(home, "archive", "chat.jsonl")
          : join(home, "sources", id, "chat.jsonl")),
      archive,
    });
  }
  const stream = a.streams.get(event === "chat-unavailable" ? id : m.source);
  if (stream) {
    if (event === "capture-start") stream.captureBase = Number(m.base ?? 0);
    if (event === "disconnect" || event === "resolve-retry") {
      stream.state = "Reconnecting";
      delete stream.captureBase;
    }
    if (event === "input-ended" || event === "clip-finished")
      stream.state = "Finished";
    if (event === "input-error") stream.state = "Unavailable";
    if (event === "chat-unavailable") stream.chatMode = String(m.chat);
    if (event === "shortlist")
      stream.state = m.selected?.length
        ? "Processing a highlight"
        : "No highlight found";
  }

  if (typeof id === "string" && typeof m.source === "string") {
    if (event === "stage-start" || event === "decision") {
      a.jobs.set(id, {
        id,
        stream: m.source,
        state:
          event === "decision" ? "Saving clip" : jobLabel(m.stage, m.phase),
        reason: m.reason ? safeMessage(Error(String(m.reason))) : "",
      });
    }
  }
  if (event === "exported" || event === "export-error") a.jobs.delete(id);

  if (event !== "watchlist" && event !== "storage") {
    const detail = [
      m.channel,
      m.phase ?? m.stage,
      m.reason ?? m.error ?? m.chat ?? m.media,
      id,
    ]
      .filter(Boolean)
      .join(" · ");
    a.logs.push({ event, detail: safeMessage(Error(detail)) });
    if (a.logs.length > 12) a.logs.shift();
  }
}

function chatLabel(stream: Stream) {
  const { chatPath, chatMode, archive } = stream;
  if (stream.state === "Unavailable" || !chatMode) return "Chat unverified";
  if (!/^(media[- ]only|unavailable)/i.test(chatMode)) {
    try {
      const receipt = statSync(chatPath);
      if (receipt.size) {
        if (archive) return "Replay chat available";
        return Date.now() - receipt.mtimeMs <= 90000
          ? "Chat available"
          : "Chat quiet · using audio";
      }
    } catch {
      // A configured reader may still be waiting for its first message.
    }
    if (!archive) return "Waiting for chat · using audio";
  }
  return "Chat unavailable · using audio";
}

export function dashboardActivity(
  home: string,
  activity?: Activity,
  captureKey?: string,
) {
  const jobs: Job[] = [];
  const heads = new Map<string, number>();
  const external: Stream[] = [];
  let db: DatabaseSync | undefined;
  const path = join(home, "jobs.sqlite");
  if (home && existsSync(path)) {
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("PRAGMA busy_timeout=500");
      for (const row of db
        .prepare("SELECT id,head,config,ended FROM live_sources")
        .all()) {
        const id = String(row.id);
        heads.set(id, Number(row.head));
        if (!captureKey || (row.ended && row.ended !== "Archive scan"))
          continue;
        const config = JSON.parse(String(row.config));
        const provenancePath = join(home, "sources", id, "source.json");
        const source = existsSync(provenancePath)
          ? jsonFile(provenancePath)
          : {};
        if (
          ![
            id,
            config.file ? config.file.toLowerCase() : "",
            "udp:" + config.port,
            source.platform + ":" + source.broadcastId,
          ].includes(captureKey)
        )
          continue;
        external.push({
          id,
          name: source.channel || config.editorial?.channel || id,
          platform: source.platform || "CLI",
          state: config.file
            ? "Scanning for highlights"
            : Number(row.head)
              ? "Watching for highlights"
              : "Connecting to stream",
          chatMode:
            source.chat ||
            config.editorial?.chatMode ||
            (config.chat ? "Timestamped chat" : ""),
          chatPath: config.chat || "",
          archive: !!config.file,
        });
      }
      const rows = db
        .prepare(
          `
        SELECT j.id,j.session AS stream,j.state,j.reason,
          (SELECT stage FROM live_stages WHERE job=j.id AND end IS NULL ORDER BY rowid DESC LIMIT 1) AS stage
        FROM jobs j WHERE j.result IS NULL AND j.state IN ('queued','rendering','evaluating')
        UNION ALL
        SELECT id,source AS stream,'post-roll',reason,NULL FROM live_windows WHERE state='waiting'
      `,
        )
        .all();
      for (const row of rows) {
        jobs.push({
          id: String(row.id),
          stream: String(row.stream),
          state:
            row.state === "post-roll"
              ? "Waiting for footage"
              : row.stage
                ? jobLabel(String(row.stage))
                : "Queued for processing",
          reason: row.reason ? safeMessage(Error(String(row.reason))) : "",
        });
      }
    } catch {
      // A CLI recording can use an older database or still be starting up.
    } finally {
      db?.close();
    }
  }
  const byId = new Map(jobs.map((job) => [job.id, job]));
  for (const [id, job] of activity?.jobs ?? []) byId.set(id, job);
  return {
    jobs: [...byId.values()],
    streams: [...external, ...(activity?.streams.values() ?? [])].map((s) => ({
      id: s.id,
      name: s.name,
      platform: s.platform,
      state:
        s.captureBase !== undefined &&
        ["Connecting to stream", "Reconnecting"].includes(s.state) &&
        (heads.get(s.id) ?? 0) > s.captureBase
          ? "Watching for highlights"
          : s.state,
      chat: chatLabel(s),
    })),
    logs: activity?.logs ?? [],
  };
}
