import {
  $,
  badge,
  button,
  codeBlock,
  esc,
  external,
  h,
  info,
  powershell,
} from "./ui.js";
import {
  overviewPublishing,
  publishingOptions,
  publishingPage,
  publishingSteps,
  publishingSummary,
} from "./publishing.js";
import { setupPage, toolList, updateSetup } from "./setup.js";

const main = $("#main");
const nav = {
  overview: "Monitor",
  sources: "Sources",
  clips: "Clips",
  publishing: "Publishing",
  setup: "Setup",
  settings: "Settings",
};
const platforms = {
  twitch: "Twitch",
  youtube: "YouTube Live",
  kick: "Kick",
  tiktok: "TikTok LIVE",
  local: "Local recording",
  multi: "Watchlist",
};
const platformName = (value) => platforms[value] || value || "Watchlist";
const help = {
  "Monitor once":
    "A live link can produce several clips. The run finishes when capture ends normally. If the stream is offline or capture fails, HypeClip can keep retrying until you press Stop. The full watchlist keeps checking for eligible streams until you stop it. A recording or archive interval is scanned once for up to one clip. Finished MP4s appear in Clips.",
  "Choose a stream":
    "Pick a watchlist channel or paste an HTTPS link from Twitch, YouTube Live, Kick or TikTok LIVE. You can also scan a local recording. Check the source and confirm you have permission to capture it before starting.",
  "Check source":
    "Looks up the stream or opens your local file so you can confirm the source, whether media is accessible, and what chat is available. Use Monitor once after you confirm permission.",
  Watchlist:
    "The ranked GTA VI watchlist checks for eligible English-language broadcasts and uses free capture slots. Choose a single channel to follow just that broadcast.",
  "Capture limit":
    "Maximum recordings running on this PC across the dashboard and HypeClip CLI. Other sources wait for a slot.",
  "Media-only detection":
    "When chat is unavailable, HypeClip looks for changes in audio level. The local tools check the moments it finds.",
  "Chat import":
    "Supply original timestamped chat as a JSONL file and the UTC time of the recording’s first frame. Leave both blank to look for highlights using audio.",
  "Archive interval":
    "Enter the start and length in minutes. Kick VOD links and Twitch video links are detected automatically. For other archive links, select Treat this link as an archive.",
  "Qwen review":
    "The local model checks timed speech and chat evidence. Review keeps the rendered MP4 for you to judge when the evidence is uncertain. The model does not see the video.",
  "Auto layout":
    "Checks source frames for a persistent facecam inset. A qualifying camera goes above gameplay. Uncertain and portrait footage uses one panel.",
  "Scene caption":
    "A temporary card supplies factual context before the payoff. Leave the text empty when the clip explains itself.",
  "Dialogue subtitles":
    "Uses saved speech timings for on-screen dialogue. Adjust subtitle height if the words cover the action.",
  Publishing:
    "Buffer connects the destination account. R2 makes the MP4 available to Buffer. Automatic posting is set per CLI session. Dashboard monitoring keeps clips local.",
  "Find TikTok channels":
    "Lists the TikTok channels connected to Buffer so you can select the account to use.",
  "Check Buffer connection":
    "Looks up the selected TikTok account and its scheduling permissions using a read-only Buffer request.",
  "Render preview":
    "Applies the presentation settings using the saved clip’s speech timings. Play the preview, then choose Save version to keep the new MP4.",
  Crop: "Enter x, y, width and height from 0 to 1, measured from the source frame’s upper-left corner.",
  Narration:
    "Off keeps the source audio alone. Auto can use a verified context line in a quiet gap when the viewer needs it.",
};
const field = (label, name, value = "", attrs = "") =>
  `<label>${esc(label)}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
const select = (label, name, options, value, hint = "") =>
  `<div class="field"><label for="field-${name}">${esc(label)}</label> ${hint ? info(hint) : ""}
    <select id="field-${name}" name="${name}">${options
      .map(
        ([id, text]) =>
          `<option value="${esc(id)}"${value === id ? " selected" : ""}>${esc(text)}</option>`,
      )
      .join("")}</select></div>`;
const time = (ms) => {
  const t = Math.floor(Math.max(0, ms || 0) / 1000);
  return (
    [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60]
      .map((n) => String(n).padStart(2, "0"))
      .join(":") +
    "." +
    String(Math.round(ms || 0) % 1000).padStart(3, "0")
  );
};
const forms = {
  layout: [
    ["auto", "Auto"],
    ["gameplay", "Gameplay only"],
    ["split", "Facecam + gameplay"],
  ],
  dialogue: [
    ["auto", "Auto"],
    ["words", "Show dialogue"],
    ["clean", "Off"],
  ],
  narration: [
    ["off", "Off"],
    ["auto", "Auto · am_michael"],
  ],
};

let state,
  page,
  pageDetail,
  selected,
  compareId,
  checked,
  selectedSource,
  preview,
  pending;
let libraryFilter = "all",
  sourceKind = "watchlist",
  editor = false,
  sourceRevision = 0,
  toastTimer,
  channels;
const clipNow = () =>
  state.clips.find((c) => c.id === selected) ?? state.clips[0];
const duration = (c) => (c.duration / 1000).toFixed(1) + " s";
const image = (c, cls = "") =>
  `<img class="${cls}" alt="" loading="lazy" src="/media/${c.id}/poster">`;
const verdict = (c) =>
  c.review
    ? "Reviewed"
    : c.decision === "review"
      ? "Ready for review"
      : c.decision === "reject"
        ? "Rejected"
        : "Ready to play";
const verdictBadge = (c) =>
  badge(verdict(c), c.review ? "ok" : c.decision === "review" ? "warm" : "");
const choose = (cls = "primary") =>
  `<a class="button ${cls}" href="#sources/choose"><span aria-hidden="true">+</span> Choose a stream</a>`;
const post = async (route, data) => {
  const r = await fetch("/api/" + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error || "Request failed");
  return result;
};
function notify(message) {
  clearTimeout(toastTimer);
  $("#notice").textContent = message;
  toastTimer = setTimeout(() => ($("#notice").textContent = ""), 6500);
}
function route(focus = false) {
  const [p, id, second] = location.hash.slice(1).split("/");
  if (p === "publishing" && id === "windows") {
    location.replace("#setup/buffer");
    return;
  }
  const nextPage = Object.hasOwn(nav, p)
    ? p
    : !p && !page && !state.setup.ready
      ? "setup"
      : "overview";
  if (page && (nextPage !== page || id !== pageDetail)) {
    clearTimeout(toastTimer);
    $("#notice").textContent = "";
  }
  page = nextPage;
  pageDetail = id;
  compareId = page === "clips" ? second : undefined;
  if (page === "clips") {
    if (id === "review") {
      libraryFilter = "review";
      selected = state.clips.find(matchesClipFilter)?.id;
    } else {
      if (id) selected = id;
      const target = state.clips.find((c) => c.id === id);
      if (target && !matchesClipFilter(target)) libraryFilter = "all";
    }
  }
  editor = false;
  preview = pending = null;
  draw();
  const section =
    page === "publishing" && id
      ? $("#setup-" + CSS.escape(id))
      : page === "setup" && id
        ? $("#connection-" + CSS.escape(id))
        : page === "settings" && id === "storage"
          ? $("#clip-storage")
          : page === "sources" && id === "chat"
            ? $("#source-credentials")
            : null;
  if (section) {
    const target = section.querySelector("summary") || section;
    target.focus({ preventScroll: true });
    section.scrollIntoView({ block: "start" });
  } else if (focus) {
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}
function openClip(id) {
  location.hash = "clips/" + id;
  if (page === "clips" && selected === id && !compareId) draw();
}
const activeSources = () =>
  state.sources.filter((s) => s.enabled || s.jobs.length);
const slotMeter =
  () => `<span class="slot-pips" aria-hidden="true">${Array.from(
    { length: state.slots.limit },
    (_, i) => `<span class="${i < state.slots.used ? "used" : ""}"></span>`,
  ).join("")}</span>
  <strong>${state.slots.used} / ${state.slots.limit}</strong> capture slots ${info("Capture limit")}`;
const fallbackState = (s) =>
  ({
    Starting: "Checking source",
    Waiting:
      s.form.kind === "watchlist"
        ? "Looking for eligible streams"
        : "Waiting for stream or capture slot",
    Monitoring:
      s.form.kind === "watchlist"
        ? "Looking for eligible streams"
        : "Connecting to stream",
    Capturing: "Watching for highlights",
    "Acquiring recording": "Downloading archive",
    Shortlisted: "Processing a highlight",
    Transcribing: "Creating subtitles",
    Rendering: "Rendering video",
    Evaluating: "Checking the highlight",
    Exporting: "Saving clip",
    "Export error": "Couldn’t save clip",
  })[s.state] || s.state;

function activityDetails(source) {
  if (!source.reason && !source.logs.length && !source.jobs.length) return "";
  return `<details class="activity-details" data-keep="${source.id}">
    <summary>Technical details</summary>
    ${source.reason ? h("p", esc(source.reason)) : ""}
    <ul class="event-log">${source.jobs.map((j) => h("li", esc(j.state + " · " + j.id + (j.reason ? " · " + j.reason : "")))).join("")}
    ${source.logs.map((log) => h("li", h("code", esc(log.event)) + " " + esc(log.detail))).join("")}</ul>
  </details>`;
}
function streamRow(stream, jobs) {
  return `<div class="stream-row">
    <div class="stream-id"><span class="stream-icon" aria-hidden="true"></span><div><strong>${esc(stream.name)}</strong>
      <span>${esc(platformName(stream.platform))}</span></div></div>
    <div class="stream-status">
      <strong><span class="state-dot ${stream.state === "Watching for highlights" ? "on" : ""}" aria-hidden="true"></span>${esc(stream.state)}</strong>
      <span>${esc(stream.chat)}</span>
      ${jobs.map((j) => `<span class="job"><span class="stage-ring" aria-hidden="true"></span>${esc(j.state)}</span>`).join("")}
    </div>
  </div>`;
}
function activity() {
  const rows = activeSources();
  const last = state.sources
    .filter((s) => ["Finished", "Unavailable"].includes(s.state))
    .sort((a, b) => b.updated - a.updated)[0];
  if (!rows.length)
    return `<section class="monitor-hero">
    <div class="hero-content">
      <h2>${state.clips.length || state.sources.length ? "No streams selected" : "Your first stream"}</h2>
      <p>Pick from the watchlist or paste a stream link.</p>
      <div class="actions">${choose()}${info("Choose a stream")}</div>
    </div>
    <div class="signal-art" aria-hidden="true">
      <div class="radar"><i></i><i></i><i></i><i></i><span></span></div>
      <div class="wave">${[8, 16, 25, 12, 43, 69, 30, 50, 86, 63, 24, 40, 12, 24, 7].map((n) => `<i style="--bar:${n}%"></i>`).join("")}</div>
    </div>
  </section>${
    last
      ? `<div class="run-receipt surface">
    <strong>${esc(last.name)}</strong> · ${last.state === "Finished" ? "Finished" : "Source unavailable"}
    ${last.reason === "No highlight found in this scan" ? h("p", esc(last.reason), "meta") : activityDetails(last)}
  </div>`
      : ""
  }`;
  return `<section class="surface active-panel">
    <div class="section-head"><h2>Active sources</h2>${info("Media-only detection")}</div>
    ${rows
      .map((s) => {
        const grouped = s.form.kind === "watchlist";
        const current = s.streams.filter(
          (stream) =>
            !grouped ||
            stream.state !== "Finished" ||
            s.jobs.some((j) => j.stream === stream.id),
        );
        const unmatched = s.jobs.filter(
          (j) => !current.some((stream) => j.stream === stream.id),
        );
        return `<div class="active-source">
        ${grouped && current.length ? `<div class="active-heading"><strong>${esc(s.name)}</strong></div>` : ""}
        ${
          current.length
            ? current
                .map((stream) =>
                  streamRow(
                    stream,
                    s.jobs.filter((j) => j.stream === stream.id),
                  ),
                )
                .join("")
            : streamRow(
                {
                  name: grouped ? "GTA VI watchlist" : s.name,
                  platform: s.platform,
                  state: fallbackState(s),
                  chat: "Chat unverified",
                },
                unmatched,
              )
        }
        ${current.length ? unmatched.map((j) => h("p", esc(j.state), "job")).join("") : ""}
        <div class="active-actions">${activityDetails(s)}${s.enabled && s.form.kind !== "external" ? button("Stop", "stop", s.id, "quiet") : ""}</div>
      </div>`;
      })
      .join("")}
  </section>`;
}
function latestClips() {
  const newest = state.clips.slice(0, 3);
  const review = state.clips.filter(
    (c) => c.decision === "review" && !c.review,
  ).length;
  return `<div class="section-head"><h2>Latest clips</h2>
    ${
      newest.length
        ? `<div class="actions">
      ${review ? `<a href="#clips/review">${review} to review</a>` : ""}
      <a class="text-link" href="#clips">All clips <span aria-hidden="true">↗</span></a></div>`
        : ""
    }
    </div>
    ${
      newest.length
        ? `<div class="latest-grid">${newest
            .map(
              (c) => `
      <a class="clip-card" href="#clips/${c.id}">
        <div class="clip-cover">${image(c)}<span class="play-icon" aria-hidden="true"></span><span class="duration">${duration(c)}</span></div>
        <div class="clip-card-text"><strong>${esc(c.name)}</strong>${verdictBadge(c)}</div>
      </a>`,
            )
            .join("")}</div>`
        : `<div class="surface empty-library">
      <span class="film-icon" aria-hidden="true"></span><p>Finished videos will appear here as they render.</p></div>`
    }
    ${state.errors.length ? `<details class="activity-details" data-keep="library-errors"><summary>Clip library details</summary>${state.errors.map((error) => h("p", esc(error))).join("")}</details>` : ""}`;
}
function overview() {
  return `<div class="page-head"><h1>Monitor</h1>
    <div class="page-actions"><div id="slot-meter" class="slot-meter">${slotMeter()}</div>
      <div id="monitor-actions">${activeSources().length ? choose("secondary") : ""}</div></div>
  </div>
  <div class="overview-grid">
    <div id="active-panel">${activity()}</div>
    <aside class="surface publishing-card" id="overview-publishing">${overviewPublishing(state.publishing)}</aside>
  </div>
  <p class="sr-only" role="status" id="progress-announcement"></p>
  <section class="latest" id="latest-clips" aria-label="Latest clips">${latestClips()}</section>`;
}

function sourceCheck() {
  if (!checked) return "";
  const { form, archive, available, eligible } = checked;
  const monitor =
    form.kind === "watchlist"
      ? "Looks for eligible broadcasts until you stop it."
      : archive
        ? "Scans the recording or interval once for up to one clip."
        : "Can make several clips while the broadcast is live. The run ends when capture finishes normally or you press Stop. HypeClip retries if capture fails.";
  const availability =
    form.kind === "watchlist"
      ? ""
      : available
        ? eligible
          ? "Media available"
          : "Source ineligible"
        : "Media unavailable";
  const chat = !available
    ? "Chat unverified"
    : checked.chat.startsWith("Media-only")
      ? "Chat unavailable · using audio"
      : checked.chat;
  return `<section class="source-result">
    <div class="section-head"><h3>${esc(checked.name)}</h3>${availability ? badge(availability, available && eligible ? "ok" : "warm") : ""}</div>
    <p class="meta">${esc([checked.platform && platformName(checked.platform), checked.title, chat].filter(Boolean).join(" · "))}</p>
    ${!available && !archive ? "<p>HypeClip can wait for this stream to become playable.</p>" : ""}
    ${!eligible ? "<p>Choose an eligible English-language GTA VI broadcast.</p>" : ""}
    ${checked.reason ? `<details class="activity-details"><summary>Source check details</summary><p>${esc(checked.reason)}</p></details>` : ""}
    <label class="consent"><input id="rights" type="checkbox"><span>I have permission to capture and edit this source locally${form.kind === "watchlist" ? "" : " and confirm it is English-language GTA VI content"}.</span></label>
    <p class="monitor-explained">${monitor} Finished videos appear in <a href="#clips">Clips</a>.</p>
    <div class="actions">${button("Monitor once", "enable", checked.id, "primary", !eligible)}${info("Monitor once")}
      ${button("Save source", "save-source", checked.id)}</div>
  </section>`;
}
function sourceFields() {
  const form = checked?.form.kind === sourceKind ? checked.form : {};
  if (sourceKind === "watchlist")
    return `<div class="field">
    <label for="watch-stream">Watchlist stream</label> ${info("Watchlist")}
    <select id="watch-stream" name="watchUrl"><option value="">Entire GTA VI watchlist</option>
      ${state.watchlist
        .map(
          (
            creator,
          ) => `<optgroup label="${esc(creator.name + (creator.pinned ? " · Pinned" : ""))}">
        ${creator.channels.map((c) => `<option value="${esc(c.url)}">${esc(creator.name + " · " + platformName(c.platform))}</option>`).join("")}
      </optgroup>`,
        )
        .join("")}
    </select></div>`;
  if (sourceKind === "recording")
    return `<div class="fieldrow">
    ${field("Recording path", "file", form.file, "required placeholder='C:\\Videos\\recording.mp4'")}
    ${button("Browse recordings", "pick", "file")}
  </div>
  <details${form.chat ? " open" : ""}><summary>Import chat (optional)</summary>
    <div class="form">
      <div class="fieldrow">${field("Chat JSONL path", "chat", form.chat)}${button("Browse chat files", "pick", "chat")}</div>
      ${field("First frame time (UTC)", "mediaStart", form.mediaStart, 'placeholder="YYYY-MM-DDTHH:MM:SSZ"')}
      <div>${info("Chat import")}</div>
    </div>
  </details>`;
  return `<div class="link-field">
    ${field("Stream link or handle", "url", form.url, 'required placeholder="https://kick.com/creator" aria-describedby="platform-hint"')}
    <output id="platform-hint" aria-live="polite">Twitch, YouTube Live, Kick or TikTok LIVE</output>
  </div>
  <div id="handle-platform" hidden>${select("Platform for this handle", "platform", [["", "Choose a platform"], ...Object.entries(platforms).slice(0, 4)], "")}</div>
  <details${form.archive ? " open" : ""}><summary>Archive interval</summary>
    <div class="form">
      <div class="actions"><label class="consent"><input name="archive" type="checkbox"${form.archive ? " checked" : ""}> Treat this link as an archive</label>${info("Archive interval")}</div>
      <div class="fieldrow">${field("Start (minutes)", "startMinute", form.startMinute ?? 0, 'type="number" min="0" max="1440" step="any"')}
      ${field("Length (minutes)", "minutes", form.minutes ?? 10, 'type="number" min="1" max="60" step="any"')}</div>
    </div>
  </details>`;
}
const handleOnly = (value) =>
  /^@?[\w-]+$/.test(value) || /^@[\w.-]+$/.test(value);
function linkHint() {
  const input = $("#source-form [name=url]");
  if (!input) return;
  const value = input.value.trim(),
    needsPlatform = handleOnly(value);
  $("#handle-platform").hidden = !needsPlatform;
  const select = $('[name="platform"]');
  select.disabled = !needsPlatform;
  select.required = needsPlatform;
  const hint = $("#platform-hint");
  let text = "Twitch, YouTube Live, Kick or TikTok LIVE";
  if (value && !needsPlatform) {
    try {
      const url = new URL(value.includes("://") ? value : "https://" + value);
      const host = url.hostname.replace(/^www\./, "");
      const platform = {
        "twitch.tv": "Twitch",
        "youtu.be": "YouTube Live",
        "youtube.com": "YouTube Live",
        "m.youtube.com": "YouTube Live",
        "kick.com": "Kick",
        "tiktok.com": "TikTok LIVE",
      }[host];
      if (platform && url.protocol === "https:") text = platform + " detected";
    } catch {}
  }
  if (hint.textContent !== text) hint.textContent = text;
}
const handleUrl = (platform, value) => {
  const handle = value.replace(/^@/, "");
  return {
    twitch: `https://www.twitch.tv/${handle}`,
    youtube: `https://www.youtube.com/@${handle}/live`,
    kick: `https://kick.com/${handle}`,
    tiktok: `https://www.tiktok.com/@${handle}/live`,
  }[platform];
};

function sourceList() {
  return (
    state.sources
      .map(
        (s) => `<div class="saved-source">
    <div><strong>${esc(s.name)}</strong><p class="meta">${esc(s.enabled ? s.streams[0]?.state || fallbackState(s) : fallbackState(s))}</p></div>
    ${
      s.form.kind === "external"
        ? ""
        : `<div class="actions">
      ${button(s.enabled ? "Stop" : "Select", s.enabled ? "stop" : "select", s.id)}
      ${!s.enabled && s.form.kind !== "watchlist" ? button("Presentation", "profile", s.id, "quiet") : ""}
    </div>`
    }
    ${activityDetails(s)}
  </div>`,
      )
      .join("") ||
    h("p", "Sources you save or monitor will appear here.", "empty")
  );
}

function sourceCredentials() {
  const descriptions = {
    Twitch: [
      "Use a Twitch user access token with <code>user:read:chat</code>. Create a Twitch app, register its redirect URL, and authorize the reader. Renew the token when it expires.",
      '<a href="#setup/twitch">Save Twitch token</a> · ' +
        external(
          "Twitch OAuth setup",
          "https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#implicit-grant-flow",
        ) +
        " · " +
        external(
          "Twitch chat scope",
          "https://dev.twitch.tv/docs/chat/authenticating/",
        ),
    ],
    YouTube: [
      "Enable YouTube Data API v3. Use an API key restricted to the YouTube API or an OAuth token with <code>youtube.readonly</code> scope. The live video needs active chat. Renew OAuth tokens with their issuer.",
      '<a href="#setup/youtube">Save YouTube credentials</a> · ' +
        external(
          "Set up YouTube API credentials",
          "https://developers.google.com/youtube/v3/getting-started",
        ) +
        " · " +
        external(
          "YouTube live chat",
          "https://developers.google.com/youtube/data/live/reference/rest/v3/liveChatMessages/list",
        ),
    ],
    Kick: [
      "Public live chat is sampled and may miss messages. Available VOD replay chat is fetched with the archive. The optional CLI source configuration can listen for signed <code>chat.message.sent</code> webhooks using <code>webhookPort</code>. A Kick developer app and public HTTPS callback are needed to register that subscription. The local monitor needs no Kick token.",
      external(
        "Configure Kick webhooks",
        "https://github.com/KickEngineering/KickDevDocs/blob/main/events/introduction.md",
      ),
    ],
    TikTok: [
      "HypeClip can try to capture a known <code>@handle/live</code> room with playable media. It has no native TikTok LIVE chat reader. To use chat in a local recording, import the creator’s timestamped JSONL and supply the first frame time.",
      "",
    ],
  };
  return `<section id="source-credentials" class="surface source-credentials" tabindex="-1">
    <div class="section-head"><h2>Stream chat</h2>${info("Media-only detection")}</div>
    <p>Chat is optional. When a stream or file has playable media but no chat, HypeClip looks for highlights using audio.</p>
    <div class="reader-grid">${state.providers
      .map((provider) => {
        const title =
          provider.platform === "YouTube"
            ? "YouTube Live"
            : provider.platform === "TikTok"
              ? "TikTok LIVE"
              : provider.platform;
        const [copy, links] = descriptions[provider.platform];
        const status =
          provider.platform === "Kick"
            ? "Public chat reader"
            : provider.platform === "TikTok"
              ? "No live chat adapter"
              : provider.liveChat.startsWith("missing")
                ? "Reader not configured"
                : "Reader entered · unverified";
        return `<details class="reader"><summary><strong>${title}</strong><span>${status}</span></summary>
        <p>${copy}</p>${links ? h("p", links, "doc-links") : ""}</details>`;
      })
      .join("")}</div>
    <details class="reader"><summary><strong>Check readers in PowerShell</strong></summary>
      <p>This command checks installed adapters and validates a configured Twitch token. The live monitor shows when messages arrive.</p>
      ${codeBlock(powershell(state.publishing.cli, "providers --check"), "Copy reader check command")}
    </details>
  </section>`;
}

function sources() {
  const picked = state.sources.find((s) => s.id === selectedSource);
  return `<div class="page-head"><h1>Sources</h1><a href="#sources/chat" class="text-link">Stream chat settings <span aria-hidden="true">↓</span></a></div>
    <div class="source-grid">
      <section class="surface choose-panel" aria-labelledby="choose-title">
        <div class="section-head"><h2 id="choose-title">Choose a stream</h2>${info("Choose a stream")}</div>
        <div class="segment" role="group" aria-label="Source type">${[
          ["watchlist", "Watchlist"],
          ["url", "Paste a link"],
          ["recording", "Local recording"],
        ]
          .map(
            ([id, text]) =>
              `<button type="button" data-act="kind" data-id="${id}" aria-pressed="${id === sourceKind}">${text}</button>`,
          )
          .join("")}</div>
        <form id="source-form" class="form">
          ${sourceFields()}
          <div class="actions"><button class="primary">Check source</button>${info("Check source")}</div>
          <p id="source-error" class="error form-message" role="alert"></p>
        </form>
        <div id="checked">${sourceCheck()}</div>
      </section>
      <div class="stack">
        <section class="surface"><h2>Your sources</h2><div id="source-list">${sourceList()}</div></section>
        ${
          picked
            ? `<section class="surface"><h2>${esc(picked.name)}</h2><form id="profile" class="form">
          ${layoutFields(picked.form.settings || {})}${voiceContext(picked.form.settings?.context)}
          <div class="actions">${button("Preview source", "source-preview", picked.id)}<button>Save source presentation</button></div>
          <div id="source-preview"></div></form></section>`
            : ""
        }
        <details class="surface roster"><summary>Watchlist status</summary><div id="watchlist-status">${rosterRows()}</div></details>
      </div>
    </div>
    ${sourceCredentials()}`;
}
function rosterRows() {
  return state.roster
    .map(
      (r) =>
        `<div class="roster-row"><span>${esc(r.name)}${r.pinned ? " · Pinned" : ""}</span><span>${esc(r.state)}</span></div>`,
    )
    .join("");
}

/* Existing presentation and comparison controls. */
function layoutFields(s) {
  return (
    select(
      "Layout",
      "layoutMode",
      forms.layout,
      s.layoutMode || "auto",
      "Auto layout",
    ) +
    "<details><summary>Source crops " +
    info("Crop") +
    '</summary><div class="form">' +
    field(
      "Facecam rectangle",
      "facecam",
      (s.splitScreen?.facecam || []).join(", "),
      'placeholder="x, y, width, height"',
    ) +
    field(
      "Split gameplay rectangle",
      "game",
      (s.splitScreen?.gameplay || []).join(", "),
    ) +
    field(
      "Single-panel gameplay rectangle",
      "single",
      (s.gameplayCrop || []).join(", "),
    ) +
    "</div></details>" +
    select(
      "Dialogue subtitles",
      "dialogue",
      forms.dialogue,
      s.dialogue || "auto",
      "Dialogue subtitles",
    ) +
    field(
      "Subtitle height (%)",
      "subY",
      Math.round((s.subtitleY ?? 0.77) * 100),
      'type="number" min="60" max="86"',
    ) +
    select(
      "Narration",
      "narration",
      forms.narration,
      s.narration || "off",
      "Narration",
    )
  );
}
function voiceContext(c = {}) {
  return (
    '<details><summary>Essential narration context</summary><div class="form">' +
    field("Verified fact", "fact", c.fact) +
    field("Evidence source", "evidence", c.source) +
    field(
      "What the viewer must read during the scene",
      "readingConflict",
      c.readingConflict,
    ) +
    "</div></details>"
  );
}
function editorForm(c) {
  const s = c.settings,
    sc = s.sceneCaption || {};
  return (
    '<form id="edit" class="form">' +
    layoutFields(s) +
    "<label>Scene caption " +
    info("Scene caption") +
    '<input name="scene" maxlength="62" value="' +
    esc(sc.text) +
    '" placeholder="No scene card"></label><div class="fieldrow">' +
    field(
      "Start (s)",
      "cardStart",
      (sc.startMs || 0) / 1000,
      'type="number" step=".01" min="0"',
    ) +
    field(
      "End (s)",
      "cardEnd",
      (sc.endMs || 2500) / 1000,
      'type="number" step=".01" min=".1"',
    ) +
    "</div>" +
    field(
      "Card height in panel (%)",
      "panelY",
      Math.round((sc.panelY ?? (c.splitScreen?.facecam ? 0.86 : 0.24)) * 100),
      'type="number" min="8" max="92"',
    ) +
    '<label>Post description<textarea name="postCaption" rows="2" required>' +
    esc(s.postCaption) +
    '</textarea></label><div class="actions"><button class="primary">Render preview</button>' +
    button("Save version", "save-version") +
    '</div><output id="draft-state">' +
    (pending ? "Rendering preview…" : preview ? "Preview ready" : "") +
    "</output></form>"
  );
}

function decisions(c) {
  const reason =
    c.reason ||
    (c.decision === "review"
      ? "This clip needs a human review."
      : "No review reason was recorded.");
  return `<div class="reason-panel${c.decision === "review" ? " needs-review" : ""}">
      <h3>${c.decision === "review" ? "Why it needs attention" : "Clip decision"}</h3>
      <p>${esc(reason)}</p>
    </div>
    <div class="actions review-actions">
      ${c.review ? badge(c.review, "ok") : button("Mark reviewed unchanged", "review", c.id)}
    </div>
    <details class="clip-diagnostics" data-clip-details="${c.id}">
      <summary>Technical details</summary>
      <div data-details-content><p>Loading evidence…</p></div>
    </details>`;
}

async function loadClipDetails(panel) {
  const c = state.clips.find((clip) => clip.id === panel.dataset.clipDetails);
  if (!c) return;
  panel.dataset.loaded = "true";
  const content = panel.querySelector("[data-details-content]");
  try {
    const response = await fetch("/api/clip-details/" + c.id);
    if (!response.ok) throw Error("Couldn’t load technical details.");
    const details = await response.json(),
      selection = c.selection || {};
    content.innerHTML = `<dl class="facts">
      <div><dt>Model</dt><dd>${esc(details.model || "Unavailable")}</dd></div>
      <div><dt>Raw model decision</dt><dd>${esc(details.raw?.decision || "Unavailable")}</dd></div>
      <div><dt>Validated decision</dt><dd>${esc(c.decision)}</dd></div>
      <div><dt>Source time</dt><dd>${time(c.sourceStart)} – ${time(c.sourceEnd)}</dd></div>
      <div><dt>Composition</dt><dd>${esc(c.layoutReason || c.layout)}</dd></div>
      <div><dt>Boundaries</dt><dd>${esc(c.boundary?.reason || selection.trim)}</dd></div>
      <div><dt>Manual override</dt><dd>${esc(c.override || "None")}</dd></div>
    </dl>
    ${
      details.evidenceTrace?.resolved?.length
        ? `<h3>Cited speech and chat</h3><ol class="citations">
      ${details.evidenceTrace.resolved
        .map((row) =>
          h(
            "li",
            `<time>${time(c.sourceStart + row.startMs)}</time> ${row.kind === "chat" ? "Chat" : "Speech"}<p>${esc(row.text)}</p>`,
          ),
        )
        .join("")}</ol>`
        : ""
    }
    <h3>Detection and boundary evidence</h3><pre tabindex="0">${esc(
      JSON.stringify(
        {
          trigger: selection,
          chat: details.chat,
          boundary: c.boundary,
          modelCitations: details.evidenceTrace,
        },
        null,
        2,
      ),
    )}</pre>
    <h3>Raw model output</h3><pre tabindex="0">${esc(JSON.stringify(details.modelResponse ?? details.raw ?? {}, null, 2))}</pre>`;
  } catch (error) {
    delete panel.dataset.loaded;
    content.innerHTML = h("p", esc(error.message), "error");
  }
}

function sameMoment(a, b) {
  function identity(c) {
    if (c.broadcast) return c.broadcast;
    if (!c.sourceUrl) return null;
    const url = new URL(c.sourceUrl, location.origin);
    url.searchParams.delete("t");
    return url.href;
  }
  const event = (c) =>
    c.eventTime ??
    (Number.isFinite(c.selection?.eventMs)
      ? c.sourceStart - c.fromMs + c.selection.eventMs
      : null);
  const broadcast = identity(a),
    at = event(a);
  return (
    a.id !== b.id &&
    broadcast &&
    broadcast === identity(b) &&
    at != null &&
    at === event(b) &&
    a.platform === b.platform
  );
}
function compareLink(c) {
  const versions = state.clips.filter((x) => x.id === c.id || sameMoment(c, x));
  if (versions.length < 2) return "";
  const original = versions.at(-1),
    revised = c.id === original.id ? versions[0] : c;
  return (
    '<a class="button compare-link" href="#clips/' +
    original.id +
    "/" +
    revised.id +
    '">Compare cuts</a>'
  );
}
function compareCuts(original, revised) {
  const cue = Math.max(
    original.sourceStart,
    revised.sourceStart,
    Math.min(original.sourceEnd, revised.sourceEnd) - 4000,
  );
  const panels = [original, revised]
    .map((c, i) => {
      const label = i ? "Revised cut" : "Original cut";
      return (
        '<section class="surface cut-panel"><div class="sect"><h2>' +
        label +
        "</h2>" +
        badge(duration(c), i ? "cool" : "") +
        '</div><video class="cut-player" controls playsinline preload="metadata" aria-label="' +
        label +
        '" data-cue="' +
        Math.max(0, (cue - c.sourceStart) / 1000) +
        '" src="/media/' +
        c.id +
        '/video" poster="/media/' +
        c.id +
        '/poster"></video>' +
        '<div class="cut-meta"><a href="#clips/' +
        c.id +
        '">Clip details</a><span class="code">' +
        time(c.sourceStart) +
        " – " +
        time(c.sourceEnd) +
        "</span></div></section>"
      );
    })
    .join("");
  const exchange = revised.boundary?.exchange;
  const quote = (s) =>
    h(
      "li",
      "<time>" +
        time(revised.sourceStart - revised.fromMs + s.startMs) +
        "</time>" +
        esc(s.text),
    );
  return (
    '<div class="page-head"><h1>Compare cuts</h1><a class="button" href="#clips/' +
    revised.id +
    '">Back to clip</a></div>' +
    '<div class="compare-title"><h2>' +
    esc(revised.name) +
    "</h2>" +
    button("Cue both endings", "cue-endings") +
    '</div><div class="cut-pair">' +
    panels +
    "</div>" +
    (exchange
      ? '<section class="surface exchange"><h2>Closing exchange</h2><ol>' +
        quote(exchange.question) +
        (exchange.reply ? quote(exchange.reply) : "") +
        "</ol></section>"
      : "")
  );
}

function matchesClipFilter(c) {
  if (libraryFilter === "review") return c.decision === "review" && !c.review;
  if (libraryFilter === "automatic")
    return c.classification === "Automatic first pass";
  if (libraryFilter === "assisted")
    return c.classification === "Manually adjusted";
  return true;
}
function clipList() {
  return (
    state.clips
      .filter(matchesClipFilter)
      .map(
        (
          c,
        ) => `<a class="library-card" href="#clips/${c.id}"${selected === c.id ? ' aria-current="true"' : ""}>
      ${image(c, "thumb")}<span><strong>${esc(c.name)}</strong><small>${duration(c)} · ${verdict(c)}</small></span>
    </a>`,
      )
      .join("") || h("p", "No clips match this filter.", "empty")
  );
}
function clips() {
  const c = clipNow();
  const other = compareId && state.clips.find((x) => x.id === compareId);
  if (other && c && sameMoment(c, other)) return compareCuts(c, other);
  if (!c)
    return `<div class="page-head"><h1>Clips</h1></div><section class="surface empty-library">
    <span class="film-icon" aria-hidden="true"></span><p>Finished videos will appear here as they render.</p>${choose()}
    </section>`;
  selected = c.id;
  return `<div class="page-head"><h1>Clips</h1><a href="#clip-library" class="text-link">Browse library <span aria-hidden="true">↓</span></a></div>
    <div class="clip-workspace">
      <section class="playerwrap" aria-label="Clip playback">
        <video class="player" controls playsinline preload="metadata" aria-label="Clip from ${esc(c.name)}"
          poster="/media/${c.id}/poster" src="/media/${preview || c.id}/video"></video>
      </section>
      <section class="surface inspector">
        <div class="clip-status">${verdictBadge(c)}<span>${esc(platformName(c.platform))} · ${duration(c)}</span></div>
        <h2>${esc(c.name)}</h2>
        ${c.title && c.title !== c.name ? h("p", esc(c.title), "clip-title") : ""}
        <div class="actions clip-actions"><a class="button primary" download href="/media/${c.id}/download">Download MP4</a>
          ${button("Open folder", "folder", c.id)}${compareLink(c)}</div>
        <div class="segment" role="group" aria-label="Clip view">${[
          ["decision", "Review", !editor],
          ["edit", "Presentation", editor],
        ]
          .map(
            ([action, label, pressed]) =>
              `<button type="button" data-act="${action}" aria-pressed="${pressed}">${label}</button>`,
          )
          .join("")}
          ${editor ? info("Render preview") : info("Qwen review")}</div>
        <div id="review-panel">${editor ? editorForm(c) : decisions(c)}</div>
      </section>
    </div>
    <section class="surface library" id="clip-library" tabindex="-1" aria-label="Clip library">
      <div class="section-head"><h2>Clip library</h2><label class="library-filter">Show
        <select id="library-filter">${[
          ["all", "All clips"],
          ["review", "Needs review"],
          ["automatic", "Automatic first passes"],
          ["assisted", "Manually adjusted"],
        ]
          .map(
            ([id, label]) =>
              `<option value="${id}"${id === libraryFilter ? " selected" : ""}>${label}</option>`,
          )
          .join("")}</select>
      </label></div><div id="clip-list">${clipList()}</div>
    </section>`;
}
function settings() {
  return `<div class="page-head"><h1>Settings</h1></div>
    <div class="source-grid">
      <section class="surface" id="clip-storage" tabindex="-1" aria-labelledby="clip-storage-title">
        <h2 id="clip-storage-title">Clips folder</h2>
        <form class="form" id="clip-folder-form">
          <div class="fieldrow">
            <label class="sr-only" for="clip-folder">Clips folder path</label>
            <input id="clip-folder" name="folder" value="${esc(state.storage.folder)}" required spellcheck="false">
            ${state.setup.windows ? button("Browse…", "browse-clip-folder") : ""}
          </div>
          <p>New runs and saved versions use this folder.</p>
          <div class="actions"><button class="primary">Save folder</button>${button("Open clips folder", "open-clip-folder")}
            <button type="button" data-act="reset-clip-folder"${state.storage.custom ? "" : " hidden"}>Use default</button>
          </div>
          <p class="error form-message" role="alert"></p>
        </form>
      </section>
      <div class="stack"><section class="surface"><h2>Capture</h2>
        <form id="limits" class="form">
          <div class="field"><label for="capture-limit">Concurrent captures</label> ${info("Capture limit")}
            <input type="number" id="capture-limit" name="limit" min="1" max="8" value="${state.slots.limit}" required>
          </div>
          <div><button class="primary">Save limit</button></div>
        </form></section>
      <section class="surface"><div class="section-head"><h2>Local model</h2>${info("Qwen review")}</div>
        <p>${esc(state.model)}</p>
        <a class="text-link" href="#setup">Manage tools and models</a>
      </section></div>
    </div>`;
}

function updateClipFolder(previous) {
  const field = $("#clip-folder");
  if (!field) return;
  if (
    (!previous || field.value === previous.folder) &&
    field.value !== state.storage.folder
  )
    field.value = state.storage.folder;
  $('[data-act="reset-clip-folder"]').hidden = !state.storage.custom;
}

async function saveClipFolder(folder) {
  state.storage = await post("clip-folder", { folder });
  updateClipFolder();
  const error = $("#clip-folder-form [role=alert]");
  if (error) error.textContent = "";
  notify(
    folder === null ? "Default clips folder restored" : "Clips folder saved",
  );
}
function draw() {
  const title = nav[page];
  document.title = title + " · HypeClip Studio";
  $("nav").innerHTML = Object.entries(nav)
    .map(
      ([id, label]) =>
        `<a href="#${id}"${page === id ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");
  main.innerHTML = {
    overview,
    sources,
    clips,
    settings,
    setup: () => setupPage(state.setup, state.connections, pageDetail),
    publishing: () => publishingPage(state.publishing, pageDetail, channels),
  }[page]();
  if (page === "setup") updateSetup(state.setup, state.connections);
  linkHint();
}

const rendered = new WeakMap();
function patchRegion(id, markup) {
  const node = document.getElementById(id);
  if (!node || rendered.get(node) === markup) return;
  rendered.set(node, markup);
  const open = new Map(
    [...node.querySelectorAll("details[data-keep]")].map((d) => [
      d.dataset.keep,
      d.open,
    ]),
  );
  const active = node.contains(document.activeElement)
    ? document.activeElement
    : null;
  node.innerHTML = markup;
  for (const d of node.querySelectorAll("details[data-keep]"))
    if (open.has(d.dataset.keep)) d.open = open.get(d.dataset.keep);
  if (active) {
    const replacement = [...node.querySelectorAll("button, a, summary")].find(
      (item) =>
        item.tagName === active.tagName &&
        item.dataset.act === active.dataset.act &&
        item.dataset.id === active.dataset.id &&
        item.dataset.help === active.dataset.help &&
        item.textContent === active.textContent &&
        item.getAttribute("href") === active.getAttribute("href"),
    );
    replacement?.focus({ preventScroll: true });
  }
}
function updatePublishing() {
  if (!pageDetail) {
    patchRegion("publishing-options", publishingOptions(state.publishing));
    return;
  }
  patchRegion("posting-summary", publishingSummary(state.publishing));
  patchRegion(
    "setup-steps",
    publishingSteps(state.publishing, pageDetail, channels),
  );
}
let requestIndex = 0;
async function refresh() {
  const request = ++requestIndex,
    response = await fetch("/api/state");
  const next = await response.json();
  if (!response.ok) throw Error(next.error || "Couldn’t reach HypeClip.");
  if (request !== requestIndex) return;
  const before = state;
  state = next;
  if (!page) return route();
  if (page === "overview") {
    patchRegion("slot-meter", slotMeter());
    patchRegion(
      "monitor-actions",
      activeSources().length ? choose("secondary") : "",
    );
    patchRegion("active-panel", activity());
    patchRegion("latest-clips", latestClips());
    patchRegion("overview-publishing", overviewPublishing(state.publishing));
    const status = activeSources()
      .flatMap((source) =>
        source.streams.map((stream) => {
          const stages = source.jobs
            .filter((job) => job.stream === stream.id)
            .map((job) => job.state);
          return [stream.name, stream.state, stream.chat, ...stages].join(". ");
        }),
      )
      .join(". ");
    const announcement = $("#progress-announcement");
    if (announcement.textContent !== status) announcement.textContent = status;
  }
  if (page === "sources") {
    patchRegion("source-list", sourceList());
    patchRegion("watchlist-status", rosterRows());
  }
  if (page === "setup") {
    patchRegion("setup-tool-list", toolList(state.setup.tools));
    updateSetup(state.setup, state.connections);
  }
  if (page === "settings") updateClipFolder(before.storage);
  if (
    page === "publishing" &&
    JSON.stringify(before.publishing) !== JSON.stringify(state.publishing)
  )
    updatePublishing();
  if (page !== "clips") return;
  if (!before.clips.length && state.clips.length) draw();
  patchRegion("clip-list", clipList());
  if (pending) {
    const task = state.renders.find((v) => v.id === pending);
    if (task?.state === "Preview ready") {
      preview = pending;
      pending = null;
      const player = $(".player");
      if (player) {
        player.src = "/media/" + preview + "/video";
        player.removeAttribute("poster");
        player.load();
      }
      if ($("#draft-state")) $("#draft-state").textContent = "Preview ready";
    } else if (task?.state === "Render failed") {
      pending = null;
      if ($("#draft-state")) $("#draft-state").textContent = "Render failed";
      notify(task.reason);
    }
  }
}

function layoutValues(f, previous = {}) {
  const rect = (name) => {
    const v = f.get(name)?.trim();
    if (!v) return null;
    const n = v.split(",").map(Number);
    if (
      n.length !== 4 ||
      n.some((x) => !Number.isFinite(x) || x < 0 || x > 1) ||
      !n[2] ||
      !n[3] ||
      n[0] + n[2] > 1.000001 ||
      n[1] + n[3] > 1.000001
    )
      throw Error("Each crop needs x, y, width and height inside the frame");
    return n;
  };
  const cam = rect("facecam"),
    game = rect("game");
  if (
    (cam && !game) ||
    (!cam && game) ||
    (!cam && f.get("layoutMode") === "split")
  )
    throw Error("Supply both panel rectangles for Facecam + gameplay");
  return {
    layoutMode: f.get("layoutMode"),
    dialogue: f.get("dialogue"),
    subtitleY: Number(f.get("subY")) / 100,
    narration: f.get("narration"),
    splitScreen: cam
      ? {
          ...previous.splitScreen,
          facecam: cam,
          gameplay: game,
          captions: f.get("dialogue"),
        }
      : undefined,
    gameplayCrop: rect("single"),
  };
}

function sourceError(message) {
  const box = $("#source-error");
  if (box) box.textContent = message;
  else notify(message);
}
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.closest("dialog")) return;
  event.preventDefault();
  const f = new FormData(form),
    submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    if (form.id === "source-form") {
      sourceError("");
      checked = null;
      $("#checked").innerHTML = "<p role='status'>Checking source…</p>";
      const revision = sourceRevision;
      const url = (f.get("url") || f.get("watchUrl") || "").trim();
      const kind = f.get("watchUrl") ? "url" : sourceKind;
      const result = await post("inspect", {
        kind,
        file: f.get("file") || undefined,
        chat: f.get("chat") || undefined,
        mediaStart: f.get("mediaStart") || undefined,
        url: f.get("platform") ? handleUrl(f.get("platform"), url) : url,
        archive: f.has("archive"),
        startMinute: Number(f.get("startMinute") || 0),
        minutes: Number(f.get("minutes") || 10),
      });
      if (!form.isConnected || revision !== sourceRevision) return;
      checked = result;
      $("#checked").innerHTML = sourceCheck();
      $("#rights")?.focus({ preventScroll: true });
      return;
    }
    if (form.id === "limits") {
      await post("limit", { limit: Number(f.get("limit")) });
      notify("Capture limit saved");
    }
    if (form.id === "clip-folder-form") {
      form.querySelector("[role=alert]").textContent = "";
      await saveClipFolder(f.get("folder"));
      return;
    }
    if (form.matches("[data-connection-form]")) {
      form.querySelector("[role=alert]").textContent = "";
      const entries = [...f]
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value);
      if (!entries.length) throw Error("Enter a value to save.");
      await post("connections", Object.fromEntries(entries));
      for (const [key] of entries) form.elements.namedItem(key).value = "";
      if (entries.some(([key]) => key === "BUFFER_ACCESS_TOKEN"))
        channels = null;
      notify("Connection settings saved");
    }
    if (form.id === "profile") {
      const s = state.sources.find((source) => source.id === selectedSource);
      const vals = layoutValues(f, s.form.settings);
      if (!vals.gameplayCrop) delete vals.gameplayCrop;
      if (f.get("fact"))
        vals.context = {
          fact: f.get("fact"),
          source: f.get("evidence"),
          readingConflict: f.get("readingConflict"),
        };
      await post("source", { id: s.id, save: true, settings: vals });
      notify("Source presentation saved");
    }
    if (form.id === "edit") {
      const c = clipNow(),
        values = layoutValues(f, c.settings),
        text = f.get("scene").trim();
      values.sceneCaption = text
        ? {
            text,
            startMs: Math.round(Number(f.get("cardStart")) * 1000),
            endMs: Math.round(Number(f.get("cardEnd")) * 1000),
            panelY: Number(f.get("panelY")) / 100,
          }
        : null;
      values.postCaption = f.get("postCaption");
      const result = await post("render", { id: c.id, settings: values });
      if (!form.isConnected) return;
      pending = result.id;
      preview = null;
      $("#draft-state").textContent = "Rendering video…";
    }
    await refresh();
  } catch (error) {
    if (form.id === "source-form" && form.isConnected) {
      $("#checked").innerHTML = "";
      sourceError(error.message);
    } else if (
      (form.id === "clip-folder-form" ||
        form.matches("[data-connection-form]")) &&
      form.isConnected
    ) {
      form.querySelector("[role=alert]").textContent = error.message;
    } else notify(error.message);
  } finally {
    if (submit) submit.disabled = false;
  }
});
document.addEventListener("input", (event) => {
  const input = event.target;
  if (input.id === "library-filter") {
    libraryFilter = input.value;
    patchRegion("clip-list", clipList());
  }
  if (input.closest("#source-form")) {
    sourceRevision++;
    linkHint();
    sourceError("");
    if ($("#checked").innerHTML) {
      checked = null;
      $("#checked").innerHTML = "";
    }
  }
  if (input.name === "layoutMode" && input.closest("#edit")) {
    $("#edit [name=panelY]").value =
      input.value === "gameplay" ||
      (input.value === "auto" && !clipNow().splitScreen?.facecam)
        ? 24
        : 86;
  }
  if (input.closest("#edit") && (preview || pending)) {
    preview = pending = null;
    $("#draft-state").textContent = "Render the changed settings to preview.";
  }
});
document.addEventListener("click", async (event) => {
  const link = event.target.closest('a[href="#main"],a[href="#clip-library"]');
  if (link) {
    event.preventDefault();
    $(link.getAttribute("href"))?.focus();
    return;
  }
  const target = event.target.closest("button");
  if (!target) return;
  const { help: topic, act, id } = target.dataset;
  if (topic) {
    $("#help-title").textContent = topic;
    $("#help-copy").textContent = help[topic];
    $("#help").showModal();
    return;
  }
  if (!act) return;
  try {
    switch (act) {
      case "cue-endings":
        for (const video of document.querySelectorAll(".cut-player")) {
          video.pause();
          video.currentTime = Number(video.dataset.cue);
        }
        return;
      case "kind":
        sourceKind = id;
        checked = null;
        draw();
        $(`[data-act=kind][data-id="${id}"]`)?.focus();
        return;
      case "decision":
      case "edit":
        editor = act === "edit";
        preview = pending = null;
        draw();
        $(`[data-act="${act}"]`)?.focus();
        return;
      case "profile":
        selectedSource = id;
        draw();
        $("#profile input, #profile select")?.focus();
        return;
      case "copy":
        await navigator.clipboard.writeText(
          target.parentElement.querySelector("pre").textContent,
        );
        notify("Copied to clipboard");
        return;
      case "copy-channel":
        await navigator.clipboard.writeText(id);
        notify("Channel ID copied");
        return;
    }
    target.disabled = true;
    switch (act) {
      case "setup":
        await post("setup", { action: id });
        await refresh();
        return;
      case "browse-clip-folder": {
        const { path } = await post("pick", { folder: true });
        if (target.isConnected && path) {
          $("#clip-folder").value = path;
          $("#clip-folder-form .primary").focus();
        }
        return;
      }
      case "open-clip-folder":
        await post("open-clip-folder", {});
        return;
      case "reset-clip-folder":
        await saveClipFolder(null);
        $("#clip-folder")?.focus();
        return;
      case "remove-connection": {
        await post("connections", { [id]: null });
        document.getElementById(id)?.focus();
        if (id === "BUFFER_ACCESS_TOKEN") channels = null;
        notify("Connection value removed");
        break;
      }
      case "select-channel":
        await post("connections", { BUFFER_CHANNEL_ID: id });
        notify("TikTok channel saved");
        break;
      case "check-output": {
        const p = await post("check-output", {});
        state.publishing = p;
        updatePublishing();
        notify(
          p.destination === "verified"
            ? "Confirmed " + p.name
            : p.destination === "disconnected"
              ? "Reconnect the TikTok account in Buffer."
              : "Couldn’t verify the TikTok destination. Check the key and channel ID.",
        );
        return;
      }
      case "find-destinations": {
        const result = await post("find-destinations", {});
        channels = result.channels;
        state.publishing = result.publishing;
        updatePublishing();
        notify(
          channels.length
            ? "TikTok channels found"
            : "No TikTok channels found",
        );
        return;
      }
      case "pick": {
        const data = await post("pick", { chat: id === "chat" });
        const input = $(`[name="${id}"]`);
        if (input && data.path) {
          input.value = data.path;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
      }
      case "select": {
        const source = state.sources.find((s) => s.id === id);
        const result = await post("inspect", source.form);
        if (page !== "sources") return;
        sourceKind = source.form.kind;
        checked = result;
        draw();
        $("#rights")?.focus();
        return;
      }
      case "source-preview": {
        const source = state.sources.find((s) => s.id === id);
        const values = layoutValues(
          new FormData($("#profile")),
          source.form.settings,
        );
        if (!values.gameplayCrop) delete values.gameplayCrop;
        const result = await post("source-preview", { id, settings: values });
        if ($("#source-preview"))
          $("#source-preview").innerHTML =
            `<img class="source-frame" alt="Source layout preview"
          src="/source-frame/${result.id}">${h("p", esc(result.reason))}`;
        return;
      }
      case "stop":
        await post("source", { id, stop: true });
        notify("Monitoring stopped");
        break;
      case "enable":
      case "save-source": {
        const enable = act === "enable";
        if (enable && !$("#rights")?.checked) {
          notify("Confirm permission to capture and edit this source.");
          $("#rights")?.focus();
          return;
        }
        await post("source", { id, enable, save: !enable, rights: enable });
        checked = null;
        if ($("#checked")) $("#checked").innerHTML = "";
        await refresh();
        if (enable) location.hash = "overview";
        notify(enable ? "Source selected" : "Source saved");
        return;
      }
      case "folder":
        await post("folder", { id });
        return;
      case "review":
        await post("review", { id });
        await refresh();
        if (page === "clips" && selected === id) {
          patchRegion("review-panel", decisions(clipNow()));
          const c = clipNow();
          $(".clip-status").innerHTML =
            verdictBadge(c) +
            h("span", esc(platformName(c.platform) + " · " + duration(c)));
        }
        notify("Review saved");
        return;
      case "save-version": {
        if (!preview) throw Error("Render the current settings before saving.");
        const version = await post("save", { id: preview });
        preview = pending = null;
        await refresh();
        openClip(version.id);
        notify("New version saved");
        return;
      }
    }
    await refresh();
  } catch (error) {
    notify(error.message);
  } finally {
    target.disabled = act === "setup" && !!state.setup.action;
  }
});

window.addEventListener("hashchange", () => state && route(true));
document.addEventListener(
  "toggle",
  (event) => {
    const panel = event.target;
    if (panel.dataset?.clipDetails && panel.open && !panel.dataset.loaded)
      void loadClipDetails(panel);
  },
  true,
);
document.addEventListener(
  "loadedmetadata",
  (event) => {
    if (event.target.matches?.(".cut-player"))
      event.target.currentTime = Number(event.target.dataset.cue);
  },
  true,
);
document.addEventListener(
  "play",
  (event) => {
    if (event.target.matches?.(".cut-player"))
      document.querySelectorAll(".cut-player").forEach((video) => {
        if (video !== event.target) video.pause();
      });
  },
  true,
);
document.addEventListener(
  "error",
  (event) => {
    if (event.target.matches?.("video"))
      notify("This video couldn’t play. Try downloading the MP4.");
  },
  true,
);

main.innerHTML = "<p class='loading' role='status'>Opening HypeClip…</p>";
refresh().catch((error) => notify(error.message));
setInterval(() => refresh().catch((error) => notify(error.message)), 2000);
