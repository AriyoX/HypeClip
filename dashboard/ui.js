export const $ = (selector) => document.querySelector(selector);
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );

export const h = (tag, content, cls = "") =>
  `<${tag}${cls ? ` class="${cls}"` : ""}>${content}</${tag}>`;
export const button = (label, act, id = "", cls = "", disabled = false) =>
  `<button type="button" data-act="${act}" data-id="${esc(id)}" class="${cls}"${disabled ? " disabled" : ""}>${esc(label)}</button>`;
export const badge = (label, cls = "") => h("span", esc(label), "badge " + cls);
export const info = (label) =>
  `<button type="button" class="info" data-help="${esc(label)}" aria-label="About ${esc(label)}">i</button>`;
export const external = (label, url) =>
  `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(label)}<span aria-hidden="true"> ↗</span></a>`;
export const codeBlock = (value, label) =>
  `<div class="copy-block">
    <pre tabindex="0" aria-label="${esc(label)}"><code>${esc(value)}</code></pre>
    ${button(label, "copy", "", "copy-button")}
  </div>`;
export const powershell = (envPath, args) =>
  "pnpm --dir '" +
  envPath.replace(/[\\/]\.env$/, "").replaceAll("'", "''") +
  "' hypeclip " +
  args;
