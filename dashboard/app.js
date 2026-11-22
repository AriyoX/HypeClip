const $ = (s) => document.querySelector(s),
  main = $("#main");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
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
const h = (tag, content, cls = "") =>
  "<" +
  tag +
  (cls ? ' class="' + cls + '"' : "") +
  ">" +
  content +
  "</" +
  tag +
  ">";
const button = (label, act, id = "", cls = "") =>
  '<button type="button" data-act="' +
  act +
  '" data-id="' +
  esc(id) +
  '" class="' +
  cls +
  '">' +
  esc(label) +
  "</button>";
const badge = (s, cls = "") => h("span", esc(s), "badge " + cls);
const help = {
  Watchlist:
    "Checks the ranked 20 creators, including pinned Kai Cenat and IShowSpeed. Only a currently eligible GTA VI broadcast with English-commentary evidence can occupy a slot.",
  "Capture limit":
    "Maximum recordings running on this PC across all dashboard tabs and HypeClip CLI clients. Other selected sources wait for a slot.",
  "Media-only detection":
    "Without synchronized chat, HypeClip looks for changes in the original audio level. Whisper and Qwen examine only the shortlisted moments.",
  "Post-roll":
    "The recorder keeps the footage after a trigger so a reaction or spoken payoff can finish. The job waits until those frames are available.",
  "Qwen review":
    "Local Qwen reads timed speech and audience evidence. Review keeps the MP4 for you to judge when the evidence is uncertain. Qwen does not see the video.",
  "Auto layout":
    "Checks several source frames for a persistent camera inset. A qualifying facecam goes above gameplay. Uncertain and portrait footage keeps one panel.",
  "Scene caption":
    "A temporary white card supplies factual context before the payoff. Leave the text empty when the clip explains itself.",
  "Dialogue subtitles":
    "Small, phrase-timed words from saved speech appear below the divider. Adjust height if they cover gameplay or the HUD.",
  "Publishing connection":
    "TikTok LIVE is an input. Buffer is a separate optional output. Connection credentials stay on the server. Local studio exports never post.",
  Crop: "Enter x, y, width and height from 0 to 1, measured from the source frame’s upper-left corner. The phone preview uses the same FFmpeg render as the saved MP4.",
  Narration:
    "Off keeps the source audio alone. Auto can reuse an approved essential context line with Kokoro am_michael only in a documented quiet gap.",
};
const info = (s) =>
  '<button type="button" class="info" data-help="' +
  esc(s) +
  '" aria-label="About ' +
  esc(s) +
  '">i</button>';
const field = (label, name, value = "", attrs = "") =>
  "<label>" +
  esc(label) +
  '<input name="' +
  name +
  '" value="' +
  esc(value) +
  '" ' +
  attrs +
  "></label>";
const select = (label, name, options, value, i = "") =>
  "<label>" +
  esc(label) +
  " " +
  (i ? info(i) : "") +
  '<select name="' +
  name +
  '">' +
  options
    .map(
      ([v, t]) =>
        '<option value="' +
        v +
        '"' +
        (value === v ? " selected" : "") +
        ">" +
        esc(t) +
        "</option>",
    )
    .join("") +
  "</select></label>";
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
  selected,
  compareId,
  libraryFilter = "all",
  sourceKind = "url",
  checked,
  editor = false,
  preview,
  pending,
  signature = "",
  toastTimer,
  selectedSource = null;
const post = async (route, data) => {
  const r = await fetch("/api/" + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "Request failed");
  return d;
};
const notify = (s) => {
  clearTimeout(toastTimer);
  $("#notice").textContent = s;
  toastTimer = setTimeout(() => ($("#notice").textContent = ""), 6500);
};
const clipNow = () =>
  state.clips.find((c) => c.id === selected) ?? state.clips[0];
const image = (c, cls) =>
  '<img class="' + cls + '" alt="" src="/media/' + c.id + '/poster">';
const duration = (c) => (c.duration / 1000).toFixed(1) + " s";
function route() {
  const [p, id, second] = location.hash.slice(1).split("/");
  page = ["sources", "clips", "settings"].includes(p) ? p : "overview";
  compareId = second;
  if (id === "review") {
    libraryFilter = "review";
    selected = state.clips.find(
      (c) => c.decision === "review" && !c.review,
    )?.id;
  } else {
    selected = id || selected;
    const target = state.clips.find((c) => c.id === id);
    if (target && !matchesClipFilter(target)) libraryFilter = "all";
  }
  editor = false;
  preview = pending = null;
  draw();
}
function openClip(id) {
  location.hash = "clips/" + id;
  if (page === "clips" && selected === id) draw();
}
function metrics() {
  const tiles = [
    ["Monitoring", state.sources.some((s) => s.enabled) ? "Running" : "Idle"],
    [
      "Capture slots",
      state.slots.active.length + " <em>/ " + state.slots.limit + "</em>",
    ],
    [
      "Queued jobs",
      state.sources.reduce(
        (n, s) =>
          n +
          s.jobs.filter((j) =>
            ["queued", "waiting", "Waiting for post-roll"].includes(j.state),
          ).length,
        0,
      ),
    ],
    [
      "Needs review",
      state.clips.filter((c) => c.decision === "review" && !c.review).length,
    ],
  ];
  return (
    '<div class="cards">' +
    tiles
      .map(
        ([k, v]) =>
          '<div class="metric"><div class="meta">' +
          k +
          " " +
          (k === "Capture slots"
            ? info("Capture limit")
            : k === "Needs review"
              ? info("Qwen review")
              : "") +
          '</div><div class="value">' +
          (k === "Needs review" && v > 0
            ? '<a href="#clips/review" aria-label="Open clips needing review">' +
              v +
              ' <span aria-hidden="true">↗</span></a>'
            : v) +
          "</div></div>",
      )
      .join("") +
    "</div>"
  );
}
function activity() {
  const rows = state.sources.filter(
    (s) => s.enabled || s.reason || s.state === "Finished",
  );
  const errors =
    state.errors.map((e) => h("p", esc(e), "error")).join("") +
    state.roster
      .filter((r) => r.state === "Capturing")
      .map((r) => h("p", esc(r.name) + " · Capturing", "meta"))
      .join("");
  return (
    errors +
    (rows.length
      ? rows
          .map(
            (s) =>
              '<div class="row"><div><strong>' +
              esc(s.name) +
              '</strong><div class="meta">' +
              esc(s.reason) +
              '</div></div><div class="end">' +
              badge(s.state) +
              ' <small data-elapsed="' +
              s.updated +
              '"></small></div></div>' +
              s.jobs
                .map(
                  (j) =>
                    '<div class="meta">' +
                    esc(j.state) +
                    " · " +
                    esc(j.id) +
                    "</div>",
                )
                .join(""),
          )
          .join("")
      : '<p class="empty">No sources enabled.</p>')
  );
}
function overview() {
  const c =
    state.clips.find((c) => c.classification === "Automatic first pass") ??
    state.clips[0];
  const latest = c
    ? '<div class="overview-feature"><button class="hero-frame" data-act="clip" data-id="' +
      c.id +
      '" aria-label="Open latest clip">' +
      image(c, "") +
      '<span class="playbadge" aria-hidden="true">▶</span></button><div>' +
      badge(c.classification, "cool") +
      h("h3", esc(c.name), "clipname") +
      h("p", esc(c.layout) + " · " + duration(c), "meta") +
      h("p", esc(c.title), "reason") +
      '<div class="spacer">' +
      button("Play clip", "clip", c.id, "primary") +
      compareLink(c) +
      "</div></div></div>"
    : h("p", "Your first export will appear here.", "empty");
  return (
    '<div class="page-head"><h1>Overview</h1>' +
    button("Add source", "sources", "", "primary") +
    "</div>" +
    metrics() +
    '<div class="grid"><section class="surface featured"><div class="sect"><h2>' +
    (c?.classification === "Automatic first pass"
      ? "Latest first pass"
      : "Latest clip") +
    "</h2>" +
    (c ? badge(c.decision, c.decision === "review" ? "warm" : "cool") : "") +
    "</div>" +
    latest +
    '</section><div class="stack"><section class="surface"><div class="sect"><h2>Monitor activity</h2>' +
    info("Post-roll") +
    "</div>" +
    activity() +
    '</section><section class="surface"><div class="sect"><h2>Recent exports</h2>' +
    button("View clips", "clips", "", "ghost") +
    "</div>" +
    state.clips
      .slice(0, 3)
      .map(
        (x) =>
          '<div class="row">' +
          image(x, "thumb") +
          "<div><strong>" +
          esc(x.name) +
          '</strong><div class="meta">' +
          esc(x.classification) +
          " · " +
          duration(x) +
          '</div></div><div class="end">' +
          button("Open", "clip", x.id) +
          "</div></div>",
      )
      .join("") +
    "</section></div></div>"
  );
}
const sourceCheck = () =>
  checked
    ? '<div class="surface"><strong>' +
      esc(checked.name) +
      "</strong> " +
      badge(checked.platform || "Watchlist") +
      '<p class="meta">' +
      esc(
        [checked.title, checked.media, checked.chat]
          .filter(Boolean)
          .join(" · "),
      ) +
      "</p>" +
      (checked.reason ? h("p", esc(checked.reason), "error") : "") +
      '<label class="check"><input id="rights" type="checkbox">I can capture and edit this source locally' +
      (checked.form.kind === "watchlist"
        ? ""
        : ", and confirm English GTA VI content") +
      '.</label><div class="actions spacer">' +
      button("Monitor once", "enable", checked.id, "primary") +
      button("Save source", "save-source", checked.id) +
      "</div></div>"
    : "";
function sourceFields() {
  if (sourceKind === "watchlist")
    return (
      "<p>20 creators · Kai Cenat and IShowSpeed pinned " +
      info("Watchlist") +
      "</p>"
    );
  if (sourceKind === "recording")
    return (
      '<div class="fieldrow">' +
      field(
        "Recording path",
        "file",
        "",
        "required placeholder='C:\\Videos\\recording.mp4'",
      ) +
      button("Choose recording", "pick", "file") +
      '</div><div class="fieldrow">' +
      field("Chat JSONL (optional)", "chat") +
      button("Choose chat", "pick", "chat") +
      "</div>" +
      field(
        "First frame UTC (with chat)",
        "mediaStart",
        "",
        "placeholder='2026-11-18T14:02:51.783Z'",
      ) +
      '<div class="meta">Without chat, use media-only detection ' +
      info("Media-only detection") +
      "</div>"
    );
  return (
    field(
      "Channel, live stream or archive URL",
      "url",
      "",
      "required placeholder='https://kick.com/creator'",
    ) +
    '<details><summary>Archive interval</summary><div class="form"><label><input name="archive" type="checkbox"> Treat this link as an archive</label><div class="fieldrow">' +
    field(
      "Start (minutes)",
      "startMinute",
      0,
      'type="number" min="0" step="any"',
    ) +
    field(
      "Duration (minutes)",
      "minutes",
      10,
      'type="number" min="1" max="60" step="any"',
    ) +
    "</div></div></details>"
  );
}
function sources() {
  const picked = state.sources.find((s) => s.id === selectedSource);
  return (
    '<div class="page-head"><h1>Sources</h1></div><div class="grid"><section class="surface"><div class="sect"><h2>Add source</h2></div><div class="segment">' +
    [
      ["url", "Stream URL"],
      ["recording", "Local recording"],
      ["watchlist", "Watchlist"],
    ]
      .map(
        ([v, t]) =>
          '<button data-act="kind" data-id="' +
          v +
          '" aria-pressed="' +
          (v === sourceKind) +
          '">' +
          t +
          "</button>",
      )
      .join("") +
    '</div><form id="source-form" class="form spacer">' +
    sourceFields() +
    '<div><button class="primary">Check source</button></div></form><div class="spacer" id="checked">' +
    sourceCheck() +
    '</div></section><div class="stack"><section class="surface"><div class="sect"><h2>Your sources</h2>' +
    info("Media-only detection") +
    '</div><div id="source-list">' +
    sourceList() +
    "</div></section>" +
    (picked
      ? '<section class="surface"><h2>' +
        esc(picked.name) +
        '</h2><form id="profile" class="form spacer">' +
        layoutFields(picked.form.settings || {}) +
        voiceContext(picked.form.settings?.context) +
        '<div class="actions">' +
        button("Preview source", "source-preview", picked.id) +
        '<button>Save source presentation</button></div><div id="source-preview"></div></form></section>'
      : "") +
    '<section class="surface"><details><summary>Watchlist · ' +
    state.roster.length +
    " creators</summary>" +
    state.roster
      .map(
        (r) =>
          '<div class="row"><div>' +
          esc(r.name) +
          " " +
          (r.pinned ? badge("Pinned", "cool") : "") +
          '</div><small class="end">' +
          esc(r.state) +
          "</small></div>",
      )
      .join("") +
    "</details></section></div></div>"
  );
}
function sourceList() {
  return (
    state.sources
      .map(
        (s) =>
          '<div class="row"><div><strong>' +
          esc(s.name) +
          '</strong><div class="meta">' +
          esc(s.state) +
          (s.reason ? " · " + esc(s.reason) : "") +
          '</div><div class="actions">' +
          (s.form.kind === "external"
            ? ""
            : button(
                s.enabled ? "Stop" : "Select",
                s.enabled ? "stop" : "select",
                s.id,
              )) +
          (!s.enabled && s.form.kind !== "watchlist"
            ? button("Presentation", "profile", s.id)
            : "") +
          "</div></div></div>",
      )
      .join("") || h("p", "No saved or active sources.", "empty")
  );
}
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
  const s = c.selection || {},
    b = c.boundary || {},
    score =
      c.mode === "audio"
        ? s.audioRise
          ? (s.audioRise.levelDb - s.audioRise.baselineDb).toFixed(2) +
            " dB above baseline"
          : "Audio rise"
        : c.mode === "operator"
          ? "Operator marker"
          : s.score + "/100 · " + s.distinctUsers + " distinct chatters";
  return (
    '<div class="line"><h3>Clip decision</h3>' +
    info("Qwen review") +
    "</div><p>" +
    badge(c.decision, c.decision === "review" ? "warm" : "cool") +
    " " +
    esc(c.model || "Model unavailable") +
    '</p><p class="reason">' +
    esc(c.reason) +
    "</p><dl><dt>Qwen decision</dt><dd>" +
    esc(c.raw?.decision || "Unavailable") +
    "</dd><dt>App decision</dt><dd>" +
    esc(c.decision) +
    "</dd><dt>Trigger</dt><dd>" +
    esc(score) +
    '</dd><dt>Source time</dt><dd class="code">' +
    time(c.sourceStart) +
    " – " +
    time(c.sourceEnd) +
    "</dd><dt>Composition</dt><dd>" +
    esc(c.layoutReason || c.layout) +
    "</dd><dt>Boundaries</dt><dd>" +
    esc(b.reason || s.trim) +
    "</dd><dt>Override</dt><dd>" +
    esc(c.override || "None") +
    "</dd></dl>" +
    (c.evidenceTrace?.resolved?.length
      ? '<details><summary>Cited speech and chat</summary><ol class="citations">' +
        c.evidenceTrace.resolved
          .map((r) =>
            h(
              "li",
              "<time>" +
                time(c.sourceStart + r.startMs) +
                "</time> " +
                esc(r.kind === "chat" ? "Chat" : "Speech") +
                h("p", esc(r.text)),
            ),
          )
          .join("") +
        "</ol></details>"
      : "") +
    "<details><summary>Detection and boundary evidence</summary><pre>" +
    esc(
      JSON.stringify(
        {
          trigger: s,
          chat: c.chat,
          boundary: b,
          modelCitations: c.evidenceTrace,
        },
        null,
        2,
      ),
    ) +
    "</pre></details><details><summary>Raw Qwen response</summary><pre>" +
    esc(JSON.stringify(c.raw ?? {}, null, 2)) +
    '</pre></details><div class="actions">' +
    (c.review
      ? badge(c.review, "ok")
      : button("Mark reviewed unchanged", "review", c.id)) +
    "</div>"
  );
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
function clips() {
  const c = clipNow();
  const other = compareId && state.clips.find((x) => x.id === compareId);
  if (other && c && sameMoment(c, other)) return compareCuts(c, other);
  if (!c)
    return (
      '<div class="page-head"><h1>Clips</h1></div><section class="surface"><p>No clips exported yet.</p>' +
      button("Add source", "sources") +
      "</section>"
    );
  selected = c.id;
  return (
    '<div class="page-head"><h1>Clips</h1>' +
    badge(state.clips.length + " exports") +
    '</div><div class="clipgrid"><aside class="surface library" aria-label="Exports"><label class="library-filter">Show<select id="library-filter">' +
    [
      ["all", "All clips"],
      ["review", "Needs review"],
      ["automatic", "Automatic first passes"],
      ["assisted", "Manually adjusted"],
    ]
      .map(
        ([v, label]) =>
          '<option value="' +
          v +
          '"' +
          (v === libraryFilter ? " selected" : "") +
          ">" +
          label +
          "</option>",
      )
      .join("") +
    '</select></label><div class="cliplist">' +
    clipList(c) +
    '</div></aside><div class="playerwrap"><video class="player" controls playsinline preload="metadata" poster="/media/' +
    c.id +
    '/poster" src="/media/' +
    (preview || c.id) +
    '/video"></video><div class="actions"><a class="button" download href="/media/' +
    c.id +
    '/download">Download MP4</a>' +
    button("Open folder", "folder", c.id) +
    compareLink(c) +
    '</div><p class="path">' +
    esc(c.path) +
    '</p></div><section class="surface inspector"><div class="pills">' +
    badge(c.classification, "cool") +
    badge(c.platform) +
    '</div><h2 class="clipname">' +
    esc(c.name) +
    '</h2><p class="meta">' +
    esc(c.title) +
    '</p><div class="segment"><button data-act="decision" aria-pressed="' +
    !editor +
    '">Decision</button><button data-act="edit" aria-pressed="' +
    editor +
    '">Presentation</button></div><div class="segbody">' +
    (editor ? editorForm(c) : decisions(c)) +
    "</div></section></div>"
  );
}
function clipList(c) {
  return (
    state.clips
      .filter(matchesClipFilter)
      .map(
        (x) =>
          '<button class="' +
          (c.id === x.id ? "selected" : "") +
          '" data-act="clip" data-id="' +
          x.id +
          '">' +
          image(x, "thumb") +
          "<span><strong>" +
          esc(x.name) +
          "</strong><small>" +
          time(x.sourceStart) +
          "</small><small>" +
          duration(x) +
          " · " +
          esc(x.decision) +
          "</small></span></button>",
      )
      .join("") || h("p", "No clips match this filter.", "empty")
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
function settings() {
  return (
    '<div class="page-head"><h1>Settings</h1></div><div class="grid"><section class="surface"><h2>Capture</h2><form id="limits" class="form spacer"><label>Concurrent captures ' +
    info("Capture limit") +
    '<input type="number" name="limit" min="1" max="8" value="' +
    state.slots.limit +
    '"></label><div><button>Save limit</button></div></form><dl><dt>Evaluation</dt><dd>' +
    esc(state.model) +
    " " +
    info("Qwen review") +
    "</dd><dt>Post-roll</dt><dd>Reserved per candidate " +
    info("Post-roll") +
    '</dd></dl></section><section class="surface"><div class="sect"><h2>Publishing</h2>' +
    badge("Off") +
    "</div><p>TikTok through Buffer " +
    info("Publishing connection") +
    "</p><dl><dt>Buffer</dt><dd>" +
    (state.buffer ? "Configured" : "Not connected") +
    "</dd><dt>R2 storage</dt><dd>" +
    (state.r2 ? "Configured" : "Not connected") +
    "</dd></dl><details><summary>Connection setup</summary><p>Set BUFFER_ACCESS_TOKEN and BUFFER_CHANNEL_ID in the checkout’s .env for an optional Buffer destination. Restart the server to read changed settings. Publishing requires a separate explicit CLI action.</p>" +
    button("Check configured connection", "check-output") +
    '</details></section></div><section class="surface spacer"><div class="sect"><h2>Input connections</h2></div><div class="tablewrap"><table><thead><tr>' +
    [
      "Input",
      "Discovery",
      "Live media",
      "Live chat",
      "Archive media",
      "Replay chat",
    ]
      .map((s) => h("th", s))
      .join("") +
    "</tr></thead><tbody>" +
    state.providers
      .map(
        (p) =>
          "<tr>" +
          [
            p.platform,
            p.discovery,
            p.liveMedia,
            p.liveChat,
            p.archiveMedia,
            p.replayChat,
          ]
            .map((v) => h("td", esc(v)))
            .join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table></div></section>"
  );
}
function draw() {
  if (!state) return;
  $("nav").innerHTML = ["overview", "sources", "clips", "settings"]
    .map(
      (k) =>
        '<a href="#' +
        k +
        '" ' +
        (page === k ? 'aria-current="page"' : "") +
        ">" +
        k[0].toUpperCase() +
        k.slice(1) +
        "</a>",
    )
    .join("");
  main.innerHTML = ({ overview, sources, clips, settings }[page] || overview)();
  ages();
}
function ages() {
  document
    .querySelectorAll("[data-elapsed]")
    .forEach(
      (e) =>
        (e.textContent =
          Math.max(
            0,
            Math.floor((Date.now() - Number(e.dataset.elapsed)) / 1000),
          ) + " s"),
    );
}
async function refresh(force = false) {
  const r = await fetch("/api/state"),
    next = await r.json();
  if (!r.ok) throw Error(next.error);
  const sig = JSON.stringify(next);
  state = next;
  if (pending) {
    const t = state.renders.find((v) => v.id === pending);
    if (t?.state === "Preview ready") {
      preview = pending;
      pending = null;
      const v = $("video");
      if (v) {
        v.src = "/media/" + preview + "/video";
        v.removeAttribute("poster");
        v.load();
      }
      if ($("#draft-state")) $("#draft-state").textContent = "Preview ready";
    } else if (t?.state === "Render failed") {
      pending = null;
      notify(t.reason);
      if ($("#draft-state")) $("#draft-state").textContent = "Render failed";
    }
  }
  if (force || !page) {
    route();
  } else if (signature !== sig) {
    if (page === "overview") draw();
    if (page === "sources" && $("#source-list"))
      $("#source-list").innerHTML = sourceList();
  }
  signature = sig;
  ages();
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
function rights() {
  if (!$("#rights")?.checked)
    throw Error(
      "Confirm local capture permission and source eligibility first",
    );
  return true;
}
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.target.closest("dialog")) {
    $("#help").close();
    return;
  }
  const f = new FormData(e.target),
    submit = e.submitter;
  if (submit) submit.disabled = true;
  try {
    switch (e.target.id) {
      case "source-form":
        checked = null;
        if (
          sourceKind === "url" &&
          /^@?[\w.-]+$/.test(f.get("url") || "") &&
          !(f.get("url") || "").includes(".")
        ) {
          if (!f.get("platform")) {
            if (f.has("platform"))
              throw Error("Choose a platform for this handle");
            const box = document.createElement("div");
            box.innerHTML = select(
              "Platform for this handle",
              "platform",
              [
                ["", "Choose platform"],
                ["twitch", "Twitch"],
                ["youtube", "YouTube Live"],
                ["kick", "Kick"],
                ["tiktok", "TikTok LIVE"],
              ],
              "",
            );
            submit.parentElement.before(box);
            throw Error(
              "This handle can belong to several platforms. Choose its platform.",
            );
          }
          const handle = f.get("url").replace(/^@/, "");
          f.set(
            "url",
            {
              youtube: "https://www.youtube.com/@" + handle + "/live",
              kick: "https://kick.com/" + handle,
              twitch: "https://www.twitch.tv/" + handle,
              tiktok: "https://www.tiktok.com/@" + handle + "/live",
            }[f.get("platform")],
          );
        }
        checked = await post("inspect", {
          kind: sourceKind,
          ...Object.fromEntries(f),
          archive: f.has("archive"),
          startMinute: Number(f.get("startMinute") || 0),
          minutes: Number(f.get("minutes") || 10),
        });
        $("#checked").innerHTML = sourceCheck();
        break;
      case "limits":
        await post("limit", { limit: Number(f.get("limit")) });
        notify("Capture limit saved");
        break;
      case "profile": {
        const s = state.sources.find((s) => s.id === selectedSource);
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
        break;
      }
      case "edit": {
        const c = clipNow(),
          s = layoutValues(f, c.settings),
          text = f.get("scene").trim();
        s.sceneCaption = text
          ? {
              text,
              startMs: Math.round(Number(f.get("cardStart")) * 1000),
              endMs: Math.round(Number(f.get("cardEnd")) * 1000),
              panelY: Number(f.get("panelY")) / 100,
            }
          : null;
        s.postCaption = f.get("postCaption");
        pending = (await post("render", { id: c.id, settings: s })).id;
        preview = null;
        $("#draft-state").textContent = "Rendering preview…";
        break;
      }
    }
    await refresh();
  } catch (err) {
    notify(err.message);
  } finally {
    if (submit) submit.disabled = false;
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "library-filter") {
    libraryFilter = e.target.value;
    $(".cliplist").innerHTML = clipList(clipNow());
    return;
  }
  if (e.target.name === "layoutMode" && e.target.closest("#edit")) {
    const v = e.target.value;
    $("#edit [name=panelY]").value =
      v === "gameplay" || (v === "auto" && !clipNow().splitScreen?.facecam)
        ? 24
        : 86;
  }
  if (e.target.closest("#source-form") && checked) {
    checked = null;
    $("#checked").innerHTML = "";
  }
  if (e.target.closest("#edit") && (preview || pending)) {
    preview = pending = null;
    $("#draft-state").textContent = "Render the changed settings to preview.";
  }
});
document.addEventListener("click", async (e) => {
  if (e.target.closest(".skip")) {
    e.preventDefault();
    main.focus();
    return;
  }
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.help) {
    e.preventDefault();
    $("#help-title").textContent = t.dataset.help;
    $("#help-copy").textContent = help[t.dataset.help];
    $("#help").showModal();
    return;
  }
  const a = t.dataset.act,
    id = t.dataset.id;
  if (!a) return;
  try {
    if (a === "cue-endings") {
      for (const video of document.querySelectorAll(".cut-player")) {
        video.pause();
        video.currentTime = Number(video.dataset.cue);
      }
      return;
    }
    if (a === "clip") return openClip(id);
    if (["sources", "clips"].includes(a)) {
      location.hash = a;
      return;
    }
    if (a === "kind") {
      sourceKind = id;
      checked = null;
      draw();
      return;
    }
    if (a === "edit" || a === "decision") {
      editor = a === "edit";
      pending = preview = null;
      draw();
      return;
    }
    if (a === "profile") {
      selectedSource = id;
      draw();
      return;
    }
    if (a === "check-output") {
      const c = await post("check-output", {});
      notify(
        c.name +
          " · " +
          (c.connected ? "Connected" : "Disconnected") +
          " · Publishing off",
      );
      return;
    }
    if (a === "pick") {
      const r = await post("pick", { chat: id === "chat" });
      if (r.path) {
        const v = $('[name="' + id + '"]');
        v.value = r.path;
        v.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    if (a === "select") {
      const s = state.sources.find((s) => s.id === id);
      checked = await post("inspect", s.form);
      sourceKind = s.form.kind;
      draw();
      return;
    }
    if (a === "source-preview") {
      const s = state.sources.find((s) => s.id === id),
        vals = layoutValues(new FormData($("#profile")), s.form.settings);
      if (!vals.gameplayCrop) delete vals.gameplayCrop;
      t.disabled = true;
      try {
        const r = await post("source-preview", { id, settings: vals });
        $("#source-preview").innerHTML =
          '<img class="player" style="max-height:380px;object-fit:contain" alt="Source layout preview" src="/source-frame/' +
          r.id +
          '"><p class="meta">' +
          esc(r.reason) +
          "</p>";
      } finally {
        t.disabled = false;
      }
      return;
    }
    if (a === "stop") await post("source", { id, stop: true });
    if (a === "enable" || a === "save-source") {
      await post("source", {
        id,
        enable: a === "enable",
        save: a === "save-source",
        rights: a === "enable" ? rights() : false,
      });
      checked = null;
      draw();
      notify(a === "enable" ? "Source selected" : "Source saved");
    }
    if (a === "folder") await post("folder", { id });
    if (a === "review") {
      await post("review", { id });
      await refresh();
      draw();
      return;
    }
    if (a === "save-version") {
      if (!preview) throw Error("Render the current settings before saving");
      const v = await post("save", { id: preview });
      preview = pending = null;
      await refresh();
      openClip(v.id);
      notify("New version saved");
      return;
    }
    await refresh();
  } catch (err) {
    notify(err.message);
  }
});
window.addEventListener("hashchange", route);
document.addEventListener(
  "loadedmetadata",
  (e) => {
    if (e.target.matches?.(".cut-player"))
      e.target.currentTime = Number(e.target.dataset.cue);
  },
  true,
);
document.addEventListener(
  "play",
  (e) => {
    if (e.target.matches?.(".cut-player"))
      document.querySelectorAll(".cut-player").forEach((v) => {
        if (v !== e.target) v.pause();
      });
  },
  true,
);
refresh(true).catch((e) => notify(e.message));
setInterval(() => refresh().catch((e) => notify(e.message)), 2000);
