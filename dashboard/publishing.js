import {
  badge,
  button,
  codeBlock,
  esc,
  external,
  info,
  powershell,
} from "./ui.js";

const bufferStatus = {
  missing: "Not configured",
  unchecked: "Key entered · unverified",
  verified: "Connected",
  failed: "Couldn’t verify",
};
const destinationStatus = {
  missing: "Not selected",
  unchecked: "ID entered · unverified",
  verified: "Verified",
  disconnected: "Disconnected",
  failed: "Couldn’t verify",
};
const r2Status = {
  missing: "Missing",
  present: "Entered · unverified",
  invalid: "Check format",
  "api-endpoint": "Use the public URL",
};
const r2Labels = [
  "Account ID",
  "Bucket name",
  "Access key ID",
  "Secret access key",
  "Public media base URL",
];

function automaticLabel({ state, sessions }) {
  if (state === "enabled")
    return (
      "On for " + sessions + (sessions === 1 ? " CLI session" : " CLI sessions")
    );
  if (state === "other-destination") return "Off for this destination";
  if (state === "unavailable") return "CLI setting unavailable";
  return "Off";
}

function setupNext(p) {
  if (p.buffer === "missing")
    return [
      "buffer",
      "Connect your TikTok account in Buffer and create an API key.",
      "Connect Buffer",
    ];
  if (p.destination === "missing")
    return [
      "buffer",
      "Find and select the intended TikTok channel.",
      "Find your TikTok channel",
    ];
  if (p.destination === "disconnected")
    return [
      "buffer",
      "Reconnect the selected TikTok account in Buffer, then check it again.",
      "Check Buffer",
    ];
  if (p.buffer !== "verified" || p.destination !== "verified")
    return [
      "buffer",
      "Check the Buffer key and confirm which TikTok account is selected.",
      "Check Buffer",
    ];
  if (p.requirement) return ["buffer", p.requirement, "Review the destination"];
  if (p.r2.some((item) => item.status !== "present"))
    return [
      "r2",
      "Configure Cloudflare R2 so Buffer can fetch the MP4.",
      "Configure R2",
    ];
  return [
    "dry-run",
    "Check anonymous access to an R2 object, then run the publishing dry run.",
    "Try a dry run",
  ];
}

function publishingStatus(p) {
  const destination = p.name
    ? esc(p.name) + (p.destination === "disconnected" ? " · Disconnected" : "")
    : destinationStatus[p.destination];
  const missingR2 = p.r2.filter((item) => item.status === "missing").length;
  const r2 =
    missingR2 === p.r2.length
      ? "Not configured"
      : missingR2
        ? missingR2 + " settings missing"
        : p.r2.some((item) => item.status !== "present")
          ? "Check settings"
          : "Entered · unverified";
  return `<dl class="status-list">
    <div><dt>Buffer connection</dt><dd>${bufferStatus[p.buffer]}</dd></div>
    <div><dt>TikTok destination</dt><dd>${destination}</dd></div>
    <div><dt>R2 video delivery</dt><dd>${r2}</dd></div>
    <div><dt>Automatic posting</dt><dd>${badge(automaticLabel(p.automatic), p.automatic.state === "enabled" ? "warm" : "")}</dd></div>
  </dl>`;
}

export function overviewPublishing(p) {
  return `<div class="section-head"><h2>Clips on this PC</h2></div>
    ${p.automatic.state === "enabled" ? '<p class="publish-note">Automatic posting is on.</p>' : ""}
    <div class="actions">${button("Open clips folder", "open-clip-folder")}<a href="#publishing">Publishing options</a></div>`;
}

export function publishingOptions(p) {
  const [step] = setupNext(p);
  return `<section class="surface posting-answer">
    <h2>Upload a clip yourself</h2>
    <p>Open a clip, download its MP4, then upload it in TikTok. HypeClip saves your clips on this PC.</p>
    <div class="actions"><a class="button primary" href="#clips">Open Clips</a><a href="#settings/storage">Change clips folder</a></div>
  </section>
  <section class="surface posting-answer">
    <h2>Schedule with Buffer</h2>
    <p>Buffer fetches the MP4 from a public link. HypeClip uses Cloudflare R2 for that upload.</p>
    <a class="button" href="#publishing/${step}">${p.buffer === "missing" ? "Set up Buffer" : "Manage Buffer"}</a>
  </section>`;
}

export function publishingSummary(p) {
  const [step, next, link] = setupNext(p);
  return `<section class="surface posting-answer">
    <h2>Automatic posting setup</h2>
    <p>Automatic posting applies to enabled command-line sessions.</p>
    <p>${esc(next)}</p>
    <a class="button primary" href="#publishing/${step}">${link} <span aria-hidden="true">↓</span></a>
  </section>
  <section class="surface">
    <div class="section-head"><h2>Publishing status</h2>${info("Publishing")}</div>
    ${publishingStatus(p)}
  </section>`;
}

function requirement(name, key, status) {
  return `<div class="requirement">
    <dt><strong>${name}</strong><code>${key}</code></dt>
    <dd>${status}</dd>
  </div>`;
}

export function publishingSteps(p, selectedStep, channels) {
  const step = (id, number, label, status, content) =>
    `<details class="setup-step surface" data-keep="${id}" id="setup-${id}"${id === selectedStep ? " open" : ""}>
      <summary><span class="step-number" aria-hidden="true">${number}</span><span class="step-title">${label}</span>
        <span class="step-status">${status}</span></summary>
      <div class="step-content">${content}</div>
    </details>`;
  const r2Missing = p.r2.filter((item) => item.status === "missing").length;
  const canCheck = p.buffer !== "missing" && p.destination !== "missing";
  const buffer = step(
    "buffer",
    1,
    "Connect TikTok through Buffer",
    canCheck ? destinationStatus[p.destination] : "Setup required",
    `
    <ol class="instructions">
      <li>Sign in to the TikTok account you want to post to. In Buffer, open <strong>Channels</strong>, choose <strong>Connect New Channel → TikTok</strong>, and authorize that account.</li>
      <li>Create a personal API key in Buffer’s <strong>Settings → API</strong> and <a href="#setup/buffer">save it in Setup</a>.</li>
      <li>Choose <strong>Find TikTok channels</strong>, then select the matching account and organization.</li>
    </ol>
    <dl class="requirements">
      ${requirement("Buffer API key", "BUFFER_ACCESS_TOKEN", bufferStatus[p.buffer])}
      ${requirement("TikTok channel ID", "BUFFER_CHANNEL_ID", destinationStatus[p.destination])}
    </dl>
    ${p.name ? `<p class="account-name">Selected TikTok account <strong>${esc(p.name)}</strong></p>` : ""}
    ${p.requirement ? `<p class="message">${esc(p.requirement)}</p>` : ""}
    <div class="actions">
      ${button("Find TikTok channels", "find-destinations", "", "", p.buffer === "missing")}${info("Find TikTok channels")}
      ${button("Check Buffer connection", "check-output", "", "", !canCheck)}${info("Check Buffer connection")}
    </div>
    ${
      channels
        ? `<div class="found-channels">${
            channels.length
              ? channels
                  .map(
                    (c) =>
                      `<div class="channel-result"><div><strong>${esc(c.name)}</strong><span>${esc(c.organization)}</span></div><div class="actions">${button("Use this channel", "select-channel", c.id)}${button("Copy channel ID", "copy-channel", c.id)}</div></div>`,
                  )
                  .join("")
              : "<p>Buffer returned no TikTok channels. Connect the account and try again.</p>"
          }</div>`
        : ""
    }
    <div class="doc-links">
      ${external("Buffer’s TikTok guide", "https://support.buffer.com/en-us/articles/using-tiktok-with-buffer-oGEroY9Of2")}
      ${external("Buffer Channels", "https://publish.buffer.com/settings/channels")}
      ${external("Buffer API settings", "https://publish.buffer.com/settings/api")}
      ${external("Buffer channel lookup", "https://developers.buffer.com/examples/get-channels.html")}
    </div>`,
  );

  const r2 = step(
    "r2",
    2,
    "Set up R2 video delivery",
    r2Missing ? r2Missing + " missing" : "Check public access",
    `
    <p>Buffer fetches the MP4 from a public HTTPS URL. HypeClip uploads only the finished clip during a live send.</p>
    <ol class="instructions">
      <li>In Cloudflare, open <strong>Storage &amp; databases → R2 → Overview</strong>. Create a dedicated bucket using the default jurisdiction. Copy its exact name and the Cloudflare account ID. You can find the ID using <strong>Copy account ID</strong> in dashboard search.</li>
      <li>In R2 Overview, choose <strong>API Tokens → Manage</strong>. Create an account or user token with <strong>Object Read &amp; Write</strong> for this bucket only. Save the S3 <strong>Access Key ID</strong> and <strong>Secret Access Key</strong> from the confirmation page.</li>
      <li>In the bucket’s <strong>Settings → Custom Domains</strong>, add a public HTTPS domain. Use its base URL, such as <code>https://clips.example.com</code>. Cloudflare’s <code>r2.dev</code> URL is for development.</li>
    </ol>
    <div class="message">Use the <strong>public media URL</strong> for <code>HYPECLIP_R2_PUBLIC_URL</code>. HypeClip builds the S3 upload endpoint <code>https://&lt;ACCOUNT_ID&gt;.r2.cloudflarestorage.com</code> from the account ID. Objects on the public domain can be read without signing in.</div>
    <dl class="requirements">
      ${p.r2.map(({ key, status }, i) => requirement(r2Labels[i], key, r2Status[status])).join("")}
    </dl>
    <p><a href="#setup/r2">Save the R2 settings</a>, then open an existing object’s public URL in a private browser window. During a live send, HypeClip checks that the final MP4 can be fetched anonymously and matches the original bytes.</p>
    <div class="doc-links">
      ${external("Find the account ID", "https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/#copy-your-account-id")}
      ${external("Create an R2 bucket", "https://developers.cloudflare.com/r2/buckets/create-buckets/")}
      ${external("Create bucket-scoped keys", "https://developers.cloudflare.com/r2/get-started/s3/#2-generate-api-credentials")}
      ${external("Set up a public domain", "https://developers.cloudflare.com/r2/buckets/public-buckets/#connect-a-bucket-to-a-custom-domain")}
      ${external("Buffer media requirements", "https://developers.buffer.com/guides/hosting-media.html")}
    </div>`,
  );

  const ps = (args) => powershell(p.cli, args);
  const dryRun = step(
    "dry-run",
    3,
    "Try a publishing dry run",
    "PowerShell",
    `
    <p>Use a finished portrait MP4, a stable name for this highlight and a text file with the post caption. Replace the example paths and highlight name.</p>
    ${codeBlock(ps(String.raw`publish --file 'C:\Clips\vertical.mp4' --highlight 'my-highlight-01' --caption-file 'C:\Clips\caption.txt' --dry-run`), "Copy dry-run command")}
    <p>Read <code>state: dry_run</code> along with the portrait dimensions, duration, file hash, caption and Buffer result. <code>verified: false</code> and <code>reason</code> mean the destination lookup failed. A returned <code>name</code> identifies the TikTok account. <code>requirement: null</code> means HypeClip found no restriction in the channel check. Address any other reported requirement before enabling.</p>
    <p>The dry run checks the MP4 and Buffer destination. It performs zero uploads and creates zero posts. R2 delivery still needs the public access check above.</p>`,
  );
  const enable = step(
    "enable",
    4,
    "Turn automatic posting on or off",
    "CLI sessions only",
    `
    <p>Run these commands in PowerShell for a specific recording and session. Dashboard monitoring and its clip library stay local.</p>
    <dl class="rules">
      <div><dt>Destination</dt><dd>${p.destination === "verified" ? esc(p.name) : "Use Check Buffer connection to confirm the TikTok account."} Copy the matching <code>BUFFER_CHANNEL_ID</code> into the command.</dd></div>
      <div><dt>Eligible clips</dt><dd>The CLI needs a real recording, confirmed capture and posting rights, and a matching session policy. A clip needs a valid render, usable speech, a verified model’s acceptance and caption, and no review flags. The example caps posting at one and uses Buffer’s queue.</dd></div>
      <div><dt>Clips marked Review</dt><dd>These are held for inspection. Marking a dashboard clip reviewed records that you checked it. For channel-specific approval, notification, privacy or commercial disclosure, fill in <strong>Manual posting requirements</strong> in Setup.</dd></div>
      <div><dt>Existing clips</dt><dd>Enabling a session does not send old clips. It can assign the destination to older unassigned Review jobs for that exact CLI session and recording. An explicit <code>evaluate &lt;id&gt;</code> retry can send one if it passes the same checks. A saved destination stays bound to the job.</dd></div>
    </dl>
    <p>Replace the recording path, session name and channel ID before running <code>auto-enable</code>. Use the same session and recording with <code>process</code>, plus your timestamped chat JSONL and the UTC time of the first video frame.</p>
    ${codeBlock(
      [
        ps(
          String.raw`auto-enable --session 'my-session' --source 'C:\Clips\recording.mp4' --channel 'TIKTOK_CHANNEL_ID' --cap 1 --mode addToQueue --rights`,
        ),
        ps(
          String.raw`process --session 'my-session' --source 'C:\Clips\recording.mp4' --chat 'C:\Clips\chat.jsonl' --media-start 'YYYY-MM-DDTHH:MM:SSZ' --rights`,
        ),
      ].join("\n"),
      "Copy enable and process commands",
    )}
    <p>Run <code>auto-off</code> to turn off all CLI sessions, or add <code>--session 'my-session'</code> to stop just that one. Check Buffer for posts already queued or in flight.</p>
    ${codeBlock(ps("auto-off"), "Copy turn-off command")}`,
  );
  return buffer + r2 + dryRun + enable;
}

export function publishingPage(config, step, channels) {
  if (!step)
    return `<div class="page-head"><h1>Publishing</h1></div>
    <div class="overview-grid setup-summary" id="publishing-options">${publishingOptions(config)}</div>`;
  return `<div class="page-head"><h1>Schedule with Buffer</h1><a href="#publishing">All publishing options</a></div>
  <div class="overview-grid setup-summary" id="posting-summary">${publishingSummary(config)}</div>
  <div class="setup-steps" id="setup-steps">${publishingSteps(config, step, channels)}</div>`;
}
