import { captureLimit, claimCaptureSlot } from "./capture-slots.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Command, Option } from "commander";
import { z } from "zod";
import { openDb } from "./db.ts";
import { calibratedSettings, Overrides, audition } from "./editorial.ts";
import { claimCoordinator, manifest, runLive } from "./live.ts";
import { scanArchive } from "./archive-scan.ts";
import { follow, refresh, gtaBroadcast, LanguageSample } from "./watchlist.ts";
import { MachineStageBudget, StageBudget } from "./stages.ts";
import { providerStatus } from "./providers.ts";
import { stateDir, jsonFile, writeJson, safeMessage } from "./local.ts";
import {
  identify,
  discover,
  resolveFeed,
  liveChat,
  chatRequirements,
} from "./platforms.ts";
import { runWorkerModule } from "./worker.ts";
import { timestamp } from "./detector.ts";
import { exportJob } from "./review-export.ts";
import { acquireInterval } from "./kick-interval.ts";

const Source = z
  .object({
    url: z.url(),
    channel: z.string().min(1).optional(),
    broadcastId: z.string().min(1).optional(),
    status: z.enum(["live", "archive"]).default("live"),
    file: z.string().optional(),
    port: z.number().int().min(1024).max(65535).optional(),
    clipPlaylist: z.url().optional(),
    feedEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    localReviewRights: z.string().trim().min(4).optional(),
    mediaStart: timestamp.optional(),
    archiveOffsetMs: z.number().int().nonnegative().optional(),
    chat: z.string().optional(),
    chatProvenance: z.string().optional(),
    languageEvidence: z.array(LanguageSample).optional(),
    broadcasterId: z.string().optional(),
    webhookPort: z.number().int().min(1024).max(65535).optional(),
    settings: Overrides.optional(),
  })
  .strict();
const Config = z.object({
  sources: z.array(Source),
  channels: z.record(z.string(), Overrides).default({}),
});
export async function monitor(
  urls: string[],
  options: {
    config?: string;
    once?: boolean;
    inspect?: boolean;
    scan?: number;
    rights?: string;
    narration?: "auto" | "off";
  },
  signal: AbortSignal,
  report: (e: Record<string, unknown>) => void,
  managed?: {
    input: z.input<typeof Source>;
    budget: StageBudget;
    draining: () => boolean;
  },
) {
  const file =
    options.config || join(homedir(), ".config", "hypeclip", "sources.json");
  const config =
    options.config || existsSync(file)
      ? Config.parse(jsonFile(file))
      : Config.parse({ sources: [] });
  const inputs = managed
    ? [Source.parse(managed.input)]
    : urls.length
      ? urls.map(
          (url) =>
            config.sources.find(
              (s) => new URL(s.url).href === new URL(url).href,
            ) ?? Source.parse({ url }),
        )
      : config.sources;
  if (!inputs.length) throw Error("Supply stream URLs or a sources config");
  const identityOf = (s: (typeof inputs)[number]) =>
    s.file && s.status === "archive" && s.url.startsWith("file:")
      ? {
          platform: "local" as const,
          handle: s.channel || "Local recording",
          video: undefined,
        }
      : identify(s.url);
  for (const input of inputs) identityOf(input);
  if (!options.inspect && inputs.length > captureLimit())
    throw Error("Selected inputs exceed the shared capture limit");
  if (
    options.scan !== undefined &&
    (!Number.isInteger(options.scan) ||
      options.scan < 1 ||
      options.scan > 20 ||
      inputs.some(
        (s) =>
          s.status !== "archive" ||
          s.settings?.markers?.length ||
          s.settings?.reviews?.length,
      ))
  )
    throw Error(
      "A blind scan needs 1–20 shortlisted windows and unmarked archive sources",
    );
  const keys = new Map<string, string>(),
    startChat = new Map<string, () => void>();
  const hooks = new Map<string, () => Promise<string>>(),
    modes = new Map<string, string>();
  const tasks: Promise<unknown>[] = [],
    ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const emit = (event: Record<string, unknown>) =>
    report({ at: new Date().toISOString(), ...event });
  const sources = [];
  try {
    const probes = await Promise.all(
      inputs.map(async (input) => {
        if (
          input.status === "archive" ||
          input.port ||
          input.feedEnv ||
          input.file
        )
          return undefined;
        try {
          return await discover(input.url);
        } catch (e) {
          return { error: safeMessage(e) };
        }
      }),
    );
    for (const [index, input] of inputs.entries()) {
      const lookup = probes[index],
        found = lookup && !("error" in lookup) ? lookup : undefined;
      const { platform, handle, video } = identityOf(input),
        channel = input.channel ?? found?.channel ?? handle;
      const broadcast = input.broadcastId ?? video ?? found?.broadcastId;
      if (
        managed &&
        found?.broadcastId &&
        found.broadcastId !== input.broadcastId
      )
        throw Error("Broadcast changed during discovery");
      if (
        managed &&
        (platform === "twitch" || platform === "kick") &&
        found?.category &&
        !gtaBroadcast(found.title ?? "", [found.category])
      )
        throw Error("Current provider game category changed");
      const rights = input.localReviewRights ?? options.rights;
      const id =
        platform +
        "-" +
        createHash("sha256")
          .update(JSON.stringify([input.url, broadcast, input.archiveOffsetMs]))
          .digest("hex")
          .slice(0, 18);
      const directory = join(stateDir(), "sources", id);
      const settings = calibratedSettings({
        ...config.channels[platform + ":" + channel.toLowerCase()],
        ...input.settings,
        ...(options.narration ? { narration: options.narration } : {}),
      });
      const collector =
        input.status === "live" && platform !== "local"
          ? liveChat(
              platform,
              handle,
              video ?? found?.broadcastId ?? broadcast,
              input.broadcasterId,
              input.webhookPort,
            )
          : undefined;
      const chat = input.chat
        ? resolve(input.chat)
        : join(directory, "chat.jsonl");
      const hasChat = input.chat
        ? (existsSync(chat) && statSync(chat).size > 0) ||
          input.status === "live"
        : !!collector;
      const mode = hasChat
        ? input.chat
          ? input.chatProvenance || "Operator-supplied timestamped chat"
          : platform === "kick"
            ? input.webhookPort
              ? "Kick signed webhook"
              : "Kick public player live chat (sampled)"
            : platform + " live chat"
        : "media only — " +
          (input.status === "archive"
            ? "original synchronized chat unavailable"
            : platform === "local"
              ? "Local recording"
              : chatRequirements[platform]);
      const reconnect =
        input.file || input.clipPlaylist
          ? "Resume finalized file position"
          : "Reopen feed and record gap (two retries)";
      let media = input.clipPlaylist
        ? "KICK clip download"
        : input.file
          ? "local replay"
          : input.port
            ? "loopback capture"
            : input.feedEnv
              ? "authorized feed"
              : "Streamlink";
      let blocker = "";
      if (lookup && "error" in lookup) blocker = lookup.error;
      else if (!options.inspect && !rights?.trim())
        blocker = "Local capture/edit permission required";
      else if (input.file && !existsSync(input.file))
        blocker = "Recording missing: " + input.file;
      else if (
        input.clipPlaylist &&
        (platform !== "kick" || input.status !== "archive")
      )
        blocker = "KICK clip downloads require an archived KICK clip URL";
      else if (input.status === "archive" && !input.file && !input.clipPlaylist)
        blocker = "Supply a bounded local archive excerpt";
      else if (
        input.status === "archive" &&
        hasChat &&
        input.chat &&
        !input.mediaStart &&
        !input.clipPlaylist
      )
        blocker = "Supply the UTC first-frame time for archived chat";
      else if (input.file && input.status !== "archive")
        blocker = "Use archive status with a finished recording";
      else if (found?.broadcastId && found.broadcastId !== broadcast)
        blocker = "Public broadcast ID changed";
      else if (!broadcast) blocker = "Supply the broadcast ID to bind this run";
      else if (hasChat && input.chat && !input.chatProvenance)
        blocker = "Identify the chat export or live collector";
      else if (
        [input.port, input.feedEnv, input.file, input.clipPlaylist].filter(
          Boolean,
        ).length > 1
      )
        blocker = "Choose one media input";
      let opened = false;
      const feed = async () => {
        if (
          opened &&
          found?.broadcastId &&
          (await discover(input.url)).broadcastId !== broadcast
        )
          throw Error("Broadcast ended or changed during reconnect");
        opened = true;
        return resolveFeed(input.url, input.feedEnv);
      };
      if (
        options.inspect &&
        !blocker &&
        !input.file &&
        !input.clipPlaylist &&
        !input.port
      ) {
        try {
          await feed();
          media += " (resolved)";
        } catch (e) {
          blocker = safeMessage(e);
        }
      }
      let replay = input.file,
        mediaStart = input.mediaStart;
      if (input.clipPlaylist && !options.inspect && !blocker) {
        replay = join(directory, "archive.mp4");
        try {
          await runWorkerModule("media.kick_archive", [
            input.url,
            input.clipPlaylist,
            replay,
          ]);
          const receipt = jsonFile(join(directory, "archive.source.json"));
          if (
            mediaStart &&
            receipt.mediaStart &&
            Math.abs(Date.parse(mediaStart) - Date.parse(receipt.mediaStart)) >
              1000
          )
            throw Error(
              "First-frame anchor differs from KICK program-date-time",
            );
          mediaStart ??= receipt.mediaStart ?? undefined;
          if (hasChat && input.chat && !mediaStart)
            throw Error("Supply the UTC first-frame anchor for archived chat");
        } catch (e) {
          blocker = "KICK clip acquisition failed: " + safeMessage(e);
        }
      }
      const status = {
        id,
        acquisition: input.clipPlaylist ?? null,
        discovery: lookup ?? null,
        access: blocker ? "blocked" : "configured",
        capturePermission: rights ?? "unconfirmed",
        url: input.url,
        platform,
        channel,
        broadcastId: broadcast ?? null,
        status: input.status,
        languageEvidence: input.languageEvidence,
        media: blocker || media,
        chat:
          blocker && !hasChat
            ? mode.replace("media only", "unavailable")
            : mode,
        reconnect: {
          media: reconnect,
          chat:
            hasChat && input.chat
              ? "resume JSONL"
              : collector
                ? platform === "youtube"
                  ? "page token"
                  : platform === "twitch"
                    ? "EventSub handoff"
                    : input.webhookPort
                      ? "provider webhook retries"
                      : "bounded public player polling; gaps possible"
                : "unavailable",
        },
        mediaStart: mediaStart ?? null,
        archiveOffsetMs: input.archiveOffsetMs ?? null,
        localReviewRights: rights ?? null,
      };
      emit({ event: "source", ...status });
      if (blocker || options.inspect) continue;
      mkdirSync(directory, { recursive: true });
      const provenance = join(directory, "source.json");
      if (existsSync(provenance)) {
        const saved = jsonFile(provenance);
        for (const field of [
          "url",
          "channel",
          "broadcastId",
          "status",
          "mediaStart",
          "archiveOffsetMs",
          "localReviewRights",
        ] as const)
          if (saved[field] !== status[field])
            throw Error(
              "Source identity or rights changed. Use a new broadcast or state directory.",
            );
      } else writeJson(provenance, status);
      hooks.set(id, feed);
      modes.set(id, mode);
      keys.set(
        id,
        input.port
          ? "udp:" + input.port
          : input.file
            ? resolve(input.file).toLowerCase()
            : platform + ":" + broadcast,
      );
      if (!input.chat && collector)
        startChat.set(id, () => {
          tasks.push(
            Promise.resolve()
              .then(async () => {
                await collector(chat, ctrl.signal);
              })
              .catch((e) => {
                if (!ctrl.signal.aborted) {
                  const msg = "media only — " + safeMessage(e);
                  modes.set(id, msg);
                  emit({ event: "chat-unavailable", id, chat: msg });
                }
              }),
          );
        });
      sources.push({
        id,
        chat,
        file: replay,
        port: input.port,
        feedEnv:
          replay || input.port
            ? undefined
            : "HYPECLIP_FEED_" + id.split("-")[1].toUpperCase(),
        mediaStart,
        rights: true,
        destination: "local-review",
        reactionMs: settings.reactionMs,
        editorial: {
          source: input.url,
          channel,
          settings,
          chatMode: mode,
          ...(managed ? { watchlist: true } : {}),
        },
      });
    }
    if (options.inspect) return;
    if (!sources.length)
      throw Error("No authorized media inputs are configured");
    const db = openDb()!;
    try {
      if (options.scan) {
        const release = claimCoordinator();
        try {
          for (const s of manifest.parse({ sources }).sources) {
            if (
              s.editorial?.settings.markers.length ||
              s.editorial?.settings.reviews.length
            )
              throw Error("Blind scans require automatic trims");
            const free = claimCaptureSlot(undefined, keys.get(s.id));
            try {
              await scanArchive(db, s, options.scan, ctrl.signal, emit);
            } finally {
              free();
            }
          }
        } finally {
          release();
        }
      } else
        await runLive(
          db,
          manifest.parse({ sources }),
          ctrl.signal,
          (e) => emit(e),
          options.once,
          {
            captureKey: (s) => keys.get(s.id)!,
            startChat: (s) => startChat.get(s.id)?.(),
            feed: (s) => hooks.get(s.id)!(),
            sharedBudget: managed?.budget,
            draining: managed?.draining,
            chatMode: (s) => {
              const mode = modes.get(s.id);
              if (
                !s.file &&
                !mode?.startsWith("media only") &&
                (!existsSync(s.chat) || !statSync(s.chat).size)
              )
                return "media only — awaiting first timestamped chat event";
              if (
                !s.file &&
                !mode?.startsWith("media only") &&
                Date.now() - statSync(s.chat).mtimeMs > 90000
              )
                return "media only — no new chat events observed for 90 seconds";
              return mode;
            },
          },
        );
    } finally {
      db.close();
    }
  } finally {
    ctrl.abort();
    signal.removeEventListener("abort", stop);
    await Promise.allSettled(tasks);
  }
}
export async function monitorWatchlist(
  o: { watchlist: string; rights?: string; once?: boolean },
  signal: AbortSignal,
  report: (e: Record<string, unknown>) => void,
) {
  mkdirSync(stateDir(), { recursive: true });
  const release = claimCoordinator(),
    budget = new MachineStageBudget();
  try {
    await follow(
      resolve(o.watchlist),
      o.rights,
      !!o.once,
      signal,
      async (s, draining) => {
        const ch = s.channel;
        await monitor([], o, signal, report, {
          budget,
          draining,
          input: {
            url: ch.url,
            broadcastId: ch.observation!.broadcastId,
            localReviewRights: ch.localReviewRights ?? o.rights,
            broadcasterId: ch.platform === "twitch" ? ch.id : undefined,
            webhookPort: ch.webhookPort,
            feedEnv: ch.feedEnv,
            settings: ch.settings,
            languageEvidence: s.samples,
          },
        });
      },
      report,
    );
  } finally {
    release();
  }
}
export function monitorCommands(cli: Command) {
  cli
    .command("providers")
    .option("--check", "Validate the configured Twitch reader token")
    .option("--json")
    .action(async (o) => {
      const rows = await providerStatus(o.check);
      if (o.json) console.log(JSON.stringify(rows, null, 2));
      else console.table(rows);
    });
  cli
    .command("watchlist")
    .option("--config <file>", "Creator roster", "docs/watchlist.json")
    .action(async (o) =>
      console.log(JSON.stringify(await refresh(resolve(o.config)), null, 2)),
    );
  cli
    .command("language-samples <recording>")
    .requiredOption("--to <directory>")
    .option("--at-ms <times...>")
    .action(async (file, o) => {
      await runWorkerModule("media.language_review", [
        resolve(file),
        resolve(o.to),
        ...(o.atMs ? ["--at-ms", ...o.atMs] : []),
      ]);
      console.log(join(resolve(o.to), "samples.json"));
    });
  cli
    .command("archive-interval <selection>")
    .requiredOption("--to <directory>")
    .requiredOption("--rights <basis>")
    .option("--media-only", "Acquire media without requesting replay chat")
    .action(async (file, o) =>
      console.log(
        JSON.stringify(
          await acquireInterval(file, resolve(o.to), o.rights, !!o.mediaOnly),
        ),
      ),
    );
  cli
    .command("monitor [urls...]")
    .option("--config <file>")
    .option(
      "--rights <basis>",
      "Local capture and editing permission for these URLs",
    )
    .option("--inspect", "Report source capabilities")
    .option("--watchlist <file>", "Follow ranked eligible creators")
    .option(
      "--duration-seconds <seconds>",
      "Stop the local monitor after this many seconds",
      Number,
    )
    .option("--once")
    .option(
      "--scan <count>",
      "Scan the complete archive and edit the strongest independent windows",
      Number,
    )
    .addOption(new Option("--narration <mode>").choices(["off", "auto"]))
    .action(async (urls, o) => {
      const ctrl = new AbortController();
      const stop = () => ctrl.abort();
      if (
        o.durationSeconds !== undefined &&
        (!Number.isInteger(o.durationSeconds) ||
          o.durationSeconds < 1 ||
          o.durationSeconds > 86400)
      )
        throw Error("Duration must be 1–86400 seconds");
      const timer = o.durationSeconds
        ? setTimeout(stop, o.durationSeconds * 1000)
        : undefined;
      process.once("SIGINT", stop);
      try {
        if (o.watchlist) {
          if (urls.length || o.scan || o.config)
            throw Error("Choose a watchlist or direct sources");
          if (o.inspect) {
            console.log(
              JSON.stringify(await refresh(resolve(o.watchlist)), null, 2),
            );
            return;
          }
          await monitorWatchlist(o, ctrl.signal, (e) =>
            console.log(JSON.stringify(e)),
          );
          return;
        }
        await monitor(urls, o, ctrl.signal, (e) =>
          console.log(JSON.stringify(e)),
        );
      } finally {
        clearTimeout(timer);
        process.off("SIGINT", stop);
      }
    });
  cli
    .command("voice-preview")
    .requiredOption("--output <wav>")
    .requiredOption("--line <text>")
    .option("--voice <name>", "", "am_michael")
    .option("--pace <speed>", "", Number, 1)
    .action(async (o) => {
      if (existsSync(o.output)) throw Error("Choose a new audition path");
      await audition(o.output, o.line, o.voice, o.pace);
      console.log(resolve(o.output));
    });
  cli
    .command("export <id>")
    .requiredOption("--to <directory>")
    .option("--name <folder>")
    .option(
      "--preview-only",
      "Render locally without adding this draft to the library",
    )
    .option(
      "--edit <json>",
      "Re-render from saved speech and editable scene, crop and subtitle settings",
    )
    .option(
      "--preview-ms <ms>",
      "Preview time within the split-screen edit",
      Number,
    )
    .action(async (id, o) =>
      console.log(
        await exportJob(id, o.to, o.name, o.previewMs, o.edit, !o.previewOnly),
      ),
    );
}
