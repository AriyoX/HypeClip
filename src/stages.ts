import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { sharedHome, tryExclusive } from "./capture-slots.ts";
import { spawn } from "node:child_process";

export type Stage = "ffmpeg" | "whisper" | "ollama";
export type Acquire = (stage: Stage) => Promise<() => void>;

// FIFO within each stage. A busy stage must not block unrelated work.
export class StageBudget {
  private active = new Set<Stage>();
  private waiting: { stage: Stage; enter: () => void }[] = [];
  acquire(stage: Stage): Promise<() => void> {
    return new Promise((resolve) => {
      this.waiting.push({
        stage,
        enter: () => {
          this.active.add(stage);
          resolve(() => {
            this.active.delete(stage);
            this.drain();
          });
        },
      });
      this.drain();
    });
  }
  private drain() {
    while (this.active.size < 2) {
      const index = this.waiting.findIndex((w) => !this.active.has(w.stage));
      if (index < 0) break;
      this.waiting.splice(index, 1)[0].enter();
    }
  }
}

// Independent CLI and studio processes use the same two OS-owned heavy slots.
export class MachineStageBudget extends StageBudget {
  override async acquire(stage: Stage) {
    const local = await super.acquire(stage);
    const dir = join(sharedHome(), "stages");
    try {
      mkdirSync(dir, { recursive: true });
      for (;;) {
        const kind = tryExclusive(join(dir, stage + ".sqlite"));
        if (kind) {
          try {
            for (const n of [1, 2]) {
              const slot = tryExclusive(join(dir, n + ".sqlite"));
              if (slot)
                return () => {
                  slot();
                  kind();
                  local();
                };
            }
          } catch (e) {
            kind();
            throw e;
          }
          kind();
        }
        await wait(150);
      }
    } catch (e) {
      local();
      throw e;
    }
  }
}

export async function controlledWorker(
  python: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  acquire: Acquire,
  cancel?: AbortSignal,
) {
  const marker = args.at(-1) + "." + randomUUID() + ".stop";
  const child = spawn(python, args, {
    cwd,
    env: {
      ...env,
      HYPECLIP_STAGE_CONTROL: "1",
      HYPECLIP_STAGE_PARENT: String(process.pid),
      HYPECLIP_STAGE_CANCEL: marker,
    },
    windowsHide: true,
    stdio: "pipe",
  });
  let release: (() => void) | undefined;
  let diagnostic = "";
  child.stderr.on(
    "data",
    (data) => (diagnostic = (diagnostic + data).slice(-2000)),
  );
  child.stdin.on("error", () => {});
  const close = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // Install rejection handler before waiting for stdout to close.
  void close.catch(() => {});
  const stop = () => {
    writeFileSync(marker, "");
    child.stdin.end();
  };
  cancel?.addEventListener("abort", stop, { once: true });
  if (cancel?.aborted) stop();
  const timer = setTimeout(stop, 3600000);
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (line === "acquire ffmpeg" || line === "acquire whisper") {
        if (release) throw Error("Nested worker stage");
        release = await acquire(line.endsWith("ffmpeg") ? "ffmpeg" : "whisper");
        child.stdin.write("go\n");
      } else if (line.startsWith("release ") && release) {
        release();
        release = undefined;
      }
    }
    if ((await close) !== 0) throw Error(diagnostic || "Media worker failed");
  } finally {
    cancel?.removeEventListener("abort", stop);
    clearTimeout(timer);
    rmSync(marker, { force: true });
    release?.();
    child.kill();
  }
}
