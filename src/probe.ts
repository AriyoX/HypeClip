import ffprobe from "@ffprobe-installer/ffprobe";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname } from "node:path";
const exec = promisify(execFile);
export async function probe(path: string, vertical = false) {
  const { stdout } = await exec(
    process.env.HYPECLIP_FFPROBE || process.env.FFPROBE || ffprobe.path,
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      "-i",
      path,
    ],
    { windowsHide: true, timeout: 30000 },
  );
  const { streams, format } = JSON.parse(stdout);
  const video = streams.find(
    (s: { codec_type: string; disposition?: { attached_pic: number } }) =>
      s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  const durationMs = Math.round(Number(format.duration) * 1000);
  if (!video || !Number.isSafeInteger(durationMs) || durationMs <= 0)
    throw Error("Missing video stream or duration");
  const rotation = Number(
    video.side_data_list?.find(
      (s: { rotation?: number }) => s.rotation !== undefined,
    )?.rotation ??
      video.tags?.rotate ??
      0,
  );
  const sideways = Math.abs(rotation % 180) === 90;
  const width = Number(sideways ? video.height : video.width),
    height = Number(sideways ? video.width : video.height);
  if (
    vertical &&
    (extname(path).toLowerCase() !== ".mp4" ||
      !format.format_name.split(",").includes("mp4") ||
      /^(qt|3g[p2]|mjp2)/i.test(format.tags?.major_brand ?? "") ||
      rotation % 90 !== 0 ||
      height <= width)
  )
    throw Error("Expected a portrait MP4");
  return {
    width,
    height,
    durationMs,
  };
}
