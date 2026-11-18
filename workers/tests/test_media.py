import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from jsonschema import Draft202012Validator

from media.job import atomic_json, sha256
from media.speech import Cue, srt
from media.video import binary, probe, run_tool
from workers.media import CONTRACT, main
from workers.tests.fixtures.__main__ import generate, write_request


class MediaWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="hypeclip media ")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.missing_model = {"HYPECLIP_WHISPER_MODEL_PATH": str(cls.root / "absent model")}
        generate(cls.root)
        cls.validators = {
            name: Draft202012Validator(cls.read_json(CONTRACT / f"{name}.schema.json"))
            for name in ("result", "transcript")
        }

    @staticmethod
    def read_json(path):
        return json.loads(Path(path).read_text(encoding="utf-8"))

    def invoke(self, request, name, *, expected=0, env=None):
        result_path = self.root / f"{name} result.json"
        completed = subprocess.run(
            [sys.executable, "-m", "workers.media", "--request", str(request), "--result", str(result_path)],
            env={**os.environ, "HF_HUB_OFFLINE": "1", **(env or {})},
            capture_output=True, text=True, check=False,
        )
        result = self.read_json(result_path)
        self.assertEqual(completed.returncode, expected, f"{result}\n{completed.stderr}")
        self.validators["result"].validate(result)
        return result

    def frame(self, path, time, *, filter_=None):
        args = [binary("ffmpeg"), "-v", "error", "-ss", time, "-i", str(path),
                "-frames:v", "1"]
        if filter_:
            args += ["-vf", filter_]
        args += ["-c:v", "rawvideo", "-threads", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
        frame = subprocess.check_output(args)
        self.assertTrue(frame)
        return frame

    def test_real_speech_window_and_captioned_fit_pad(self):
        request = self.root / "speech request.json"
        result = self.invoke(request, "speech")
        source = self.root / "speech source.mp4"
        original, vertical = Path(result["originalPath"]), Path(result["verticalPath"])
        self.assertEqual(result["qualityFlags"], [])
        self.assertEqual(result["durationMs"], 55000)
        self.assertEqual(result["sha256"], sha256(vertical))
        orig_info, final_info = probe(original, "TEST"), probe(vertical, "TEST")
        self.assertEqual((orig_info.video["width"], orig_info.video["height"]), (320, 180))
        self.assertEqual((final_info.video["width"], final_info.video["height"]), (540, 960))
        self.assertEqual((final_info.video["codec_name"], final_info.video["pix_fmt"],
                          final_info.video["avg_frame_rate"], final_info.audio["codec_name"]),
                         ("h264", "yuv420p", "30/1", "aac"))
        atoms = vertical.read_bytes()
        self.assertGreater(atoms.find(b"moov"), 0)
        self.assertLess(atoms.find(b"moov"), atoms.find(b"mdat"))

        # Audio begins 64 ms ahead of the first video PTS. Compare decoded clock regions.
        source_info = probe(source, "TEST")
        self.assertEqual(source_info.video_offset_ms, 64)
        clock = "crop=200:32:60:74"
        for clip_time, first_frame_offset in [("0", 26), ("54.8", 80.8)]:
            source_time = first_frame_offset + source_info.video_offset_ms / 1000
            extracted = self.frame(original, clip_time, filter_=clock)
            wanted = self.frame(source, str(source_time), filter_=clock)
            other = self.frame(source, str(source_time + 2), filter_=clock)
            wanted_error = sum(abs(a - b) for a, b in zip(extracted, wanted, strict=True))
            other_error = sum(abs(a - b) for a, b in zip(extracted, other, strict=True))
            self.assertLess(wanted_error, other_error / 2)

        transcript = self.read_json(result["transcriptPath"])
        self.validators["transcript"].validate(transcript)
        segments = transcript["segments"]
        self.assertRegex(" ".join(s["text"] for s in segments).lower(), r"last train.*one second left")
        self.assertRegex(" ".join(s["text"] for s in segments).lower(), r"blue lantern.*bridge")
        self.assertTrue(10_000 <= segments[0]["startMs"] <= 13_000)
        self.assertTrue(41_000 <= segments[-1]["endMs"] <= 44_000)
        self.assertTrue(all(0 <= s["startMs"] < s["endMs"] <= result["durationMs"] for s in segments))
        subtitles = Path(result["subtitlePath"]).read_text(encoding="utf-8")
        self.assertRegex(subtitles, r"(?m)^00:00:1[0-3],\d{3} --> 00:00:1[0-6],\d{3}$")
        self.assertRegex(subtitles, r"(?m)^00:00:(39|4[0-3]),\d{3} --> 00:00:4[0-5],\d{3}$")
        self.assertIn("last train", " ".join(subtitles.lower().split()))
        cue_time = re.search(r"(?m)^00:00:(\d{2}),(\d{3}) -->", subtitles)
        mid_cue = int(cue_time[1]) + int(cue_time[2]) / 1000 + 0.25
        in_caption_zone = "crop=480:110:30:765"
        with_captions = self.frame(vertical, str(mid_cue), filter_=in_caption_zone)
        before_speech = self.frame(vertical, "5", filter_=in_caption_zone)
        self.assertGreater(sum(v > 230 for v in with_captions), sum(v > 230 for v in before_speech) + 300)

        # The source's left landmark stays visible in the fitted landscape picture.
        fit = self.frame(vertical, "3")
        sample = (402 * 540 + 41) * 3
        red, green, blue = fit[sample:sample + 3]
        self.assertGreater(red, max(green, blue) + 120)

    def test_silence_center_crop_and_interrupted_cache(self):
        source = self.root / "silent source.mp4"
        request = write_request(self.root, "center", source, start=26300, end=29100, layout="center-crop")
        output = Path(self.read_json(request)["candidate"]["outputDir"])
        interruption = output / ".media-work" / ".staging-interrupted" / "artifacts"
        interruption.mkdir(parents=True)
        (interruption / "vertical.mp4").write_bytes(b"partial")
        first = self.invoke(request, "center", env=self.missing_model)
        self.assertEqual(first["qualityFlags"], ["silence"])
        self.assertEqual(first["durationMs"], 2800)
        self.assertEqual(self.read_json(first["transcriptPath"]), {"segments": []})
        self.assertEqual(Path(first["subtitlePath"]).read_bytes(), b"")
        self.assertIsNotNone(probe(Path(first["verticalPath"]), "TEST").audio)
        center = self.frame(first["verticalPath"], "1")
        sample = (402 * 540 + 41) * 3
        red, green, blue = center[sample:sample + 3]
        self.assertLess(red, max(green, blue) + 80)
        repeated = self.invoke(request, "center again", env=self.missing_model)
        self.assertEqual(repeated, first)
        Path(first["verticalPath"]).write_bytes(b"interrupted output")
        repaired = self.invoke(request, "center repaired", env=self.missing_model)
        self.assertNotEqual(repaired["verticalPath"], first["verticalPath"])
        self.assertEqual(repaired["sha256"], sha256(Path(repaired["verticalPath"])))
        self.assertEqual(repaired["qualityFlags"], ["silence"])

    def test_missing_audio_is_flagged(self):
        video = self.root / "video only.mp4"
        run_tool("ffmpeg", ["-v", "error", "-i", str(self.root / "silent source.mp4"),
                             "-an", "-c:v", "copy", str(video)], "TEST")
        request = write_request(self.root, "video only", video, start=0, end=1500)
        result = self.invoke(request, "video only", env=self.missing_model)
        self.assertEqual(result["qualityFlags"], ["missing_audio"])
        self.assertIsNone(probe(Path(result["verticalPath"]), "TEST").audio)

    def test_structured_failures(self):
        source = self.root / "speech source.mp4"
        request = write_request(self.root, "missing model", source, start=36000, end=42000)
        self.assertEqual(self.invoke(request, "missing model", expected=1, env=self.missing_model)
                         ["error"]["code"], "MISSING_SPEECH_MODEL")
        request = write_request(self.root, "past end", source, start=90000, end=96000)
        self.assertEqual(self.invoke(request, "past end", expected=1)["error"]["code"], "WINDOW_OUT_OF_RANGE")
        request = write_request(self.root, "invalid", source, start=81000, end=26000)
        self.assertEqual(self.invoke(request, "invalid", expected=1)["error"]["code"], "INVALID_REQUEST")
        request = self.root / "silent request.json"
        env = {"HYPECLIP_FFPROBE": str(self.root / "missing ffprobe")}
        self.assertEqual(self.invoke(request, "missing ffprobe", expected=1, env=env)
                         ["error"]["code"], "MISSING_BINARY")

    def test_interruption_reports_retryable_failure(self):
        source = self.root / "silent source.mp4"
        request = write_request(self.root, "interrupted", source, start=26000, end=29000)
        result = self.root / "interrupted result.json"

        def interrupt(_source, target, *_):
            target.write_bytes(b"partial")
            raise KeyboardInterrupt

        with patch("media.job.render", side_effect=interrupt), patch.object(
            sys, "argv", ["workers.media", "--request", str(request), "--result", str(result)]
        ):
            self.assertEqual(main(), 1)
        failure = self.read_json(result)
        self.validators["result"].validate(failure)
        self.assertEqual(failure["error"]["code"], "INTERRUPTED")
        self.assertTrue(failure["error"]["retryable"])
        completed = self.invoke(request, "interrupted retry")
        self.assertEqual(completed["qualityFlags"], ["silence"])

    def test_caption_controls_are_literal(self):
        original = r"{\an8}<i>text</i> &amp; \N"
        subtitles = srt([Cue(1234, 2345, original)], 45)
        self.assertIn("00:00:01,234 --> 00:00:02,345", subtitles)
        self.assertIn("｛＼an8｝＜i＞text＜/i＞ ＆amp; ＼N", subtitles)

    def test_contract_rejects_unknown_request_fields(self):
        path = self.root / "extra field request.json"
        request = self.read_json(self.root / "silent request.json")
        request["credentials"] = "fixture"
        atomic_json(path, request)
        self.assertEqual(self.invoke(path, "extra field", expected=1)["error"]["code"], "INVALID_REQUEST")


if __name__ == "__main__":
    unittest.main()
