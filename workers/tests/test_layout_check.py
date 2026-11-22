import unittest
from unittest.mock import patch

import numpy as np

from media import layout_check as layout


class CameraInsetTests(unittest.TestCase):
    def setUp(self):
        self.times = [100, 400, 700, 1000, 1300]
        self.frames = [np.full((160, 320, 3), n, dtype=np.uint8) for n in (20, 110, 35, 150, 85)]
        self.face = (.96, .18, .25, .055, .11)

    def compose(self, with_motion=True):
        for i, frame in enumerate(self.frames):
            frame[16:66, 24:91] = (43, 67, 129)
            # A moving face surrounded by a stable inset on a changing background.
            frame[32:55, 47:70] = 205-i*8 if with_motion else 205

    def test_separately_moving_inset_required(self):
        boxes = [[self.face] for _ in self.frames]
        self.compose()
        result = layout.locate_inset(self.frames, boxes)
        np.testing.assert_allclose(result, [.075, .1, 67/320, 50/160], atol=.012)
        self.compose(with_motion=False)
        self.assertIsNone(layout.locate_inset(self.frames, boxes))

    def test_in_game_face_across_camera_cuts_is_insufficient(self):
        # The same bounding box on five unframed character closeups must not
        # produce an inset, even under a channel with reviewed camera crops.
        with patch.object(layout, "faces", return_value=[self.face]), patch.object(layout, "face_detector"):
            result = layout.analyze(self.frames, self.times, "xQc", {})
        self.assertNotIn("facecam", result)
        self.assertEqual(result["framesWithFaces"], 5)

    def test_source_reference_requires_current_frame_evidence(self):
        self.compose()
        rect = [.075, .1, 67/320, 50/160]
        profile = {"facecam": rect, "gameplay": [.3, 0, .7, 1],
                   "signatureBgr": layout.room_signature(self.frames[0], rect).tolist()}
        seen = [[self.face] for _ in self.frames]
        self.assertEqual(layout.matching_room(self.frames, seen, profile), 5)
        self.assertEqual(layout.matching_room(self.frames, [[]]*5, profile), 0)
        replaced = [np.full_like(frame, 220) for frame in self.frames]
        self.assertEqual(layout.matching_room(replaced, seen, profile), 0)

    def test_portrait_keeps_source_without_face_analysis(self):
        result = layout.analyze([frame.transpose(1, 0, 2) for frame in self.frames], self.times, "xQc", {})
        self.assertNotIn("facecam", result)
        self.assertIn("Portrait", result["reason"])

    def test_bundled_detector_runs_offline(self):
        model = layout.face_detector()
        self.assertEqual(layout.faces(model, self.frames[0]), [])


if __name__ == "__main__":
    unittest.main()
