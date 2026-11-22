import { $, badge, button, esc } from "./ui.js";

export function toolList(tools) {
  const rows = [
    ["Python worker", tools?.worker],
    ["FFmpeg and FFprobe", tools && tools.ffmpeg && tools.ffprobe],
    ["Whisper speech model", tools?.whisper],
    ["Ollama review model", tools?.ollama.model],
  ];
  return `<dl class="status-list">${rows
    .map(
      ([label, value]) =>
        `<div><dt>${label}</dt><dd>${typeof value === "string" && value ? esc(value) : ""}${badge(!tools ? "Checking" : value ? "Ready" : "Setup needed", value ? "ok" : "warm")}</dd></div>`,
    )
    .join("")}</dl>`;
}

const guides = {
  twitch: ["Twitch token requirements", "#sources/chat"],
  youtube: ["YouTube credential requirements", "#sources/chat"],
  buffer: ["Find your TikTok channel", "#publishing/buffer"],
  r2: ["R2 bucket and key setup", "#publishing/r2"],
};

function connectionGroup({ id, label, fields }, selected) {
  const [guide, href] = guides[id];
  return `<details class="surface connection" id="connection-${id}"${id === selected ? " open" : ""}>
    <summary>${esc(label)}</summary>
    <form class="form" data-connection-form autocomplete="off">
      ${id === "youtube" ? "<p>Use a Data API key or an OAuth token.</p>" : ""}
      ${fields
        .map(
          ({
            key,
            label: name,
            secret,
          }) => `<div data-connection-field id="connection-${key}">
        <div class="connection-label"><label for="${key}">${esc(name)}</label><span id="state-${key}"></span></div>
        <div class="connection-input">
          <input id="${key}" name="${key}" type="${secret ? "password" : "text"}" maxlength="2048" spellcheck="false" autocapitalize="off" aria-describedby="state-${key}">
          <button type="button" data-act="remove-connection" data-id="${key}" aria-label="Remove ${esc(label + " " + name.toLowerCase())}" hidden>Remove</button>
        </div>
      </div>`,
        )
        .join("")}
      <div class="actions"><button class="primary">Save ${esc(label)}</button><a href="${href}">${guide}</a></div>
      <p class="error form-message" role="alert"></p>
    </form>
  </details>`;
}

export function setupPage(setup, connections, selected) {
  return `<div class="page-head"><h1>Setup</h1><div class="page-actions"><a href="/guide" target="_blank" rel="noreferrer">Quick start</a><a id="setup-continue" href="#overview" class="button primary" hidden>Continue to Monitor</a></div></div>
    <div class="setup-layout">
      <section class="surface setup-tools" aria-labelledby="setup-tools-title">
        <h2 id="setup-tools-title">Local tools and models</h2>
        <div id="setup-tool-list">${toolList(setup.tools)}</div>
        <div class="actions">
          ${button("Install tools and models", "setup", "install", "primary")}
          ${button("Check again", "setup", "check")}
        </div>
        <p id="setup-download">Setup can download several GB. Windows may ask you to approve installers.</p>
        <p id="setup-platform" hidden>Install Python 3.13, FFmpeg and Ollama with your package manager before installing the models.</p>
        <p id="setup-progress" class="form-message" role="status"></p>
        <p id="setup-error" class="error form-message" role="alert"></p>
      </section>
      <section class="surface setup-tools" aria-labelledby="setup-live-title">
        <h2 id="setup-live-title">Live capture</h2>
        <dl class="status-list"><div><dt>Streamlink</dt><dd id="setup-streamlink"></dd></div></dl>
        <p id="setup-streamlink-help" hidden>Install Streamlink with your package manager, then check again.</p>
        <div class="actions">${button("Install Streamlink", "setup", "streamlink")}</div>
      </section>
    </div>
    <section class="setup-connections" aria-labelledby="connections-title">
      <h2 id="connections-title">Optional connections</h2>
      <p>You can make and save clips without an account. Blank fields keep saved values.</p>
      <div class="connection-grid">${connections.map((group) => connectionGroup(group, selected)).join("")}</div>
    </section>`;
}

export function updateSetup(setup, connections) {
  const install = $('[data-act="setup"][data-id="install"]');
  const streamlink = $('[data-act="setup"][data-id="streamlink"]');
  install.hidden = setup.ready;
  install.disabled = !!setup.action;
  $('[data-act="setup"][data-id="check"]').disabled = !!setup.action;
  streamlink.hidden = !!setup.tools?.streamlink || !setup.windows;
  streamlink.disabled = !!setup.action;
  $("#setup-continue").hidden = !setup.ready;
  $("#setup-download").hidden = setup.ready || !setup.windows;
  $("#setup-platform").hidden = setup.ready || setup.windows;
  $("#setup-progress").classList.toggle("sr-only", !setup.action);
  const version = setup.tools?.streamlink;
  $("#setup-streamlink-help").hidden = !!version || setup.windows;
  const status = version || (setup.tools ? "Setup needed" : "Checking");
  if ($("#setup-streamlink").textContent !== status)
    $("#setup-streamlink").textContent = status;
  for (const [node, value] of [
    ["#setup-progress", setup.message],
    ["#setup-error", setup.error],
  ]) {
    if ($(node).textContent !== value) $(node).textContent = value;
  }
  for (const { fields } of connections) {
    for (const { key, locked, configured } of fields) {
      const field = $("#connection-" + key);
      field.querySelector("input").disabled = locked;
      field.querySelector("button").hidden = locked || !configured;
      const label = locked
        ? "Set by launch environment"
        : configured
          ? "Configured"
          : "";
      if (field.querySelector("span").textContent !== label)
        field.querySelector("span").textContent = label;
    }
  }
}
