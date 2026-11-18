import { expect, it } from "vitest";
import { closedSegments } from "../src/capture.ts";
it("uses completed local FFmpeg segments and their media timestamps", () => {
  expect(
    closedSegments(
      "segment-00000000.mkv,0.000000,5.125000\r\nsegment-00000001.mkv,5.125000,10.000000\r\n",
    ),
  ).toEqual([
    { name: "segment-00000000.mkv", startMs: 0, endMs: 5125 },
    { name: "segment-00000001.mkv", startMs: 5125, endMs: 10000 },
  ]);
  expect(() => closedSegments("../other.mp4,0,5")).toThrow();
});
