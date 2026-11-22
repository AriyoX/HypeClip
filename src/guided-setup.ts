import { execFile, type ExecFileOptions } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { tryExclusive } from "./capture-slots.ts";
import { safeMessage, stateDir } from "./local.ts";
import { streamlinkVersion } from "./providers.ts";
import { ollamaStatus, setup as setupOllama } from "./setup.ts";
import { workerEnv, workerLocation } from "./worker.ts";

export const setupActions = ["check", "install", "streamlink"] as const;
type Action = (typeof setupActions)[number];
const windows = process.platform === "win32";
const exec = promisify(execFile);
function run(file: string, args: string[], options: ExecFileOptions = {}) {
  const network =
    /^(?:(?:HTTP|HTTPS|ALL|NO)_PROXY|SSL_CERT_(?:FILE|DIR)|REQUESTS_CA_BUNDLE|PIP_CERT|HF_HUB_DISABLE_XET)$/i;
  return exec(file, args, {
    env: {
      ...workerEnv(),
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => network.test(key)),
      ),
    },
    windowsHide: true,
    timeout: 12000,
    ...options,
    encoding: "utf8",
  });
}

async function updateWindowsPath() {
  if (!windows) return;
  const { stdout } = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Write([Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'))",
  ]);
  process.env.PATH = [
    ...new Set(
      [process.env.PATH || "", stdout]
        .join(delimiter)
        .split(delimiter)
        .filter(Boolean),
    ),
  ].join(delimiter);
}

async function installWindows(packageId: string, name: string) {
  if (!windows)
    throw Error(
      "Install " +
        name +
        " using your system package manager, then check again.",
    );
  const alias = join(
    process.env.LOCALAPPDATA || "",
    "Microsoft",
    "WindowsApps",
    "winget.exe",
  );
  const winget = existsSync(alias) ? alias : "winget.exe";
  if (!(await run(winget, ["--version"]).catch(() => null)))
    throw Error(
      "Install or update App Installer from Microsoft Store, then try again.",
    );
  await run(
    winget,
    [
      "install",
      "--id",
      packageId,
      "--exact",
      "--source",
      "winget",
      "--no-upgrade",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ],
    { timeout: 30 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
  ).catch(() => {
    throw Error(
      "WinGet couldn’t install " +
        name +
        ". Check for an installer approval or open App Installer, then try again.",
    );
  });
  await updateWindowsPath();
}

function checkWorker() {
  const { python, cwd } = workerLocation();
  return run(python, ["-m", "media.setup_speech"], { cwd })
    .then(({ stdout }) => ({
      worker: true,
      whisper: stdout.trim() === "ready",
    }))
    .catch(() => ({ worker: false, whisper: false }));
}

async function checkFFmpeg() {
  const ffmpeg = process.env.HYPECLIP_FFMPEG || "ffmpeg";
  const [encoders, filters] = await Promise.all([
    run(ffmpeg, ["-hide_banner", "-encoders"]).catch(() => null),
    run(ffmpeg, ["-hide_banner", "-filters"]).catch(() => null),
  ]);
  return !!(
    encoders &&
    filters &&
    /\blibx264\s/.test(encoders.stdout) &&
    ["ass", "subtitles", "drawtext"].every((filter) =>
      filters.stdout.includes(" " + filter + " "),
    )
  );
}

async function checks() {
  const [speech, ffmpeg, ffprobe, ollama, streamlink] = await Promise.all([
    checkWorker(),
    checkFFmpeg(),
    run(process.env.HYPECLIP_FFPROBE || "ffprobe", ["-version"])
      .then(() => true)
      .catch(() => false),
    ollamaStatus().catch(() => ({ service: false, model: "" })),
    streamlinkVersion(),
  ]);
  return { ...speech, ffmpeg, ffprobe, ollama, streamlink };
}
type Checks = Awaited<ReturnType<typeof checks>>;
const ready = (tools: Checks | null) =>
  !!(
    tools?.worker &&
    tools.whisper &&
    tools.ffmpeg &&
    tools.ffprobe &&
    tools.ollama.model
  );

async function systemPython() {
  const commands = windows
    ? [["py", "-3.13"], ["python"]]
    : [["python3.13"], ["python3"]];
  for (const [file, ...args] of commands) {
    const version = await run(file, [
      ...args,
      "-c",
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
    ])
      .then(({ stdout }) => stdout.trim())
      .catch(() => "");
    if (version === "3.13") return { file, args };
  }
  return null;
}

async function installWorker(report: (message: string) => void) {
  const { cwd, venv, python } = workerLocation();
  if (process.env.HYPECLIP_PYTHON)
    throw Error(
      "Check HYPECLIP_PYTHON and install the worker packages in that environment.",
    );
  let runtime = await systemPython();
  if (!runtime) {
    report("Installing Python 3.13…");
    await installWindows("Python.Python.3.13", "Python 3.13 with venv");
    runtime = await systemPython();
  }
  if (!runtime)
    throw Error(
      "Python 3.13 is unavailable. Restart HypeClip and check again.",
    );
  report("Installing Python worker packages…");
  await run(runtime.file, [...runtime.args, "-m", "venv", venv], {
    cwd,
    timeout: 120000,
  }).catch(() => {
    throw Error(
      "Couldn’t create .venv. Check that you can write to the HypeClip folder.",
    );
  });
  await run(
    python,
    [
      "-m",
      "pip",
      "--disable-pip-version-check",
      "--no-input",
      "install",
      "--progress-bar",
      "off",
      "-r",
      "workers/requirements.txt",
    ],
    { cwd, timeout: 30 * 60 * 1000 },
  ).catch(() => {
    throw Error(
      "Couldn’t install the Python worker packages. Check your connection and disk space, then retry.",
    );
  });
  await run(python, ["-m", "pip", "check"], { cwd }).catch(() => {
    throw Error(
      "Python worker packages are incompatible. Check the .venv installation.",
    );
  });
}

async function installCore(tools: Checks, report: (message: string) => void) {
  if (!tools.ffmpeg || !tools.ffprobe) {
    if (
      (!tools.ffmpeg && process.env.HYPECLIP_FFMPEG) ||
      (!tools.ffprobe && process.env.HYPECLIP_FFPROBE)
    )
      throw Error(
        "Check your configured FFmpeg and FFprobe paths. Use a build with libx264, libass and drawtext.",
      );
    report("Installing FFmpeg and FFprobe…");
    await installWindows("Gyan.FFmpeg", "FFmpeg and FFprobe");
  }
  if (!tools.worker) await installWorker(report);
  if (!tools.whisper) {
    const { python, cwd } = workerLocation();
    report("Preparing the Whisper speech model…");
    await run(python, ["-m", "media.setup_speech", "--download"], {
      cwd,
      timeout: 30 * 60 * 1000,
    }).catch(() => {
      throw Error(
        process.env.HYPECLIP_WHISPER_MODEL_PATH
          ? "Check the local Whisper model in HYPECLIP_WHISPER_MODEL_PATH."
          : "Couldn’t prepare Whisper. Check your connection and disk space, then retry.",
      );
    });
  }
  if (!tools.ollama.model) {
    if (
      !tools.ollama.service &&
      !(await run("ollama", ["--version"]).catch(() => null))
    ) {
      report("Installing Ollama…");
      await installWindows("Ollama.Ollama", "Ollama");
    }
    report("Checking Ollama…");
    await setupOllama(report);
  }
}

export function guidedSetup(onProgress?: (message: string) => void) {
  let tools: Checks | null = null;
  let action: Action | null = null;
  let message = "";
  let error = "";
  const report = (text: string) => {
    message = text;
    onProgress?.(text);
  };
  const status = () => ({
    tools,
    action,
    message,
    error,
    ready: ready(tools),
    windows,
  });

  async function run(actionRequested: Action) {
    if (action) throw Error("Setup is already running.");
    action = actionRequested;
    error = "";
    let release: (() => void) | undefined;
    try {
      report("Checking local tools…");
      await updateWindowsPath().catch(() => {});
      tools = await checks();
      if (action === "check") return;
      const dir = stateDir();
      mkdirSync(dir, { recursive: true });
      release = tryExclusive(join(dir, "setup.lock.sqlite"));
      if (!release) throw Error("Setup is running in another HypeClip window.");
      if (action === "install") await installCore(tools, report);
      if (action === "streamlink" && !tools.streamlink) {
        if (process.env.HYPECLIP_STREAMLINK)
          throw Error("Check the Streamlink path in HYPECLIP_STREAMLINK.");
        report("Installing Streamlink…");
        await installWindows("Streamlink.Streamlink", "Streamlink");
      }
    } catch (cause) {
      error = safeMessage(cause);
    } finally {
      if (release) {
        tools = await checks();
        release();
      }
      if (!error && action === "install" && !ready(tools))
        error =
          "Some tools still need attention. Restart HypeClip and check again.";
      if (!error && action === "streamlink" && !tools?.streamlink)
        error = "Streamlink is unavailable. Restart HypeClip and check again.";
      message =
        !error && action === "install"
          ? "Local tools and models are ready."
          : "";
      action = null;
    }
  }

  return { run, status };
}
