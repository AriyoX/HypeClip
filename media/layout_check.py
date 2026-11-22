"""Choose one composition for a local clip from five decoded source frames."""
import json
from pathlib import Path
import re
import sys

import av
import numpy as np
import onnxruntime as ort

ASSETS = Path(__file__).with_name("layout_profiles")
SAMPLE_FRACTIONS = (.08, .28, .50, .72, .92)


def frames_at(path, start_ms, end_ms):
    if not 0 <= start_ms < end_ms:
        raise ValueError("Invalid layout sample range")
    frames, times = [], []
    with av.open(str(path), options={"protocol_whitelist": "file"}) as container:
        stream = container.streams.video[0]
        origin = stream.start_time or 0
        sar = float(stream.sample_aspect_ratio or 1)
        for fraction in SAMPLE_FRACTIONS:
            target = start_ms + round((end_ms - start_ms) * fraction)
            pts = origin + int(target / (1000 * stream.time_base))
            container.seek(pts, stream=stream)
            for frame in container.decode(stream):
                if frame.pts is None or frame.pts < pts:
                    continue
                actual = round(float((frame.pts - origin) * stream.time_base * 1000))
                if actual < end_ms and actual not in times:
                    rotation = round(frame.rotation / 90) % 4
                    ratio = frame.width * sar / frame.height
                    w, h = round(min(640, 640 * ratio)), round(min(640, 640 / ratio))
                    pixels = frame.reformat(width=w, height=h, format="bgr24").to_ndarray()
                    frames.append(np.ascontiguousarray(np.rot90(pixels, rotation)))
                    times.append(actual)
                break
    return frames, times


def face_detector():
    options = ort.SessionOptions()
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = 1
    model = ort.InferenceSession(str(ASSETS / "yunet.onnx"), options, providers=["CPUExecutionProvider"])
    return model


def faces(model, frame):
    """YuNet bounding boxes. No identity or facial embeddings are computed."""
    h, w = frame.shape[:2]
    padded = np.pad(frame, ((0, -h % 32), (0, -w % 32), (0, 0)))
    tensor = padded.transpose(2, 0, 1)[None].astype(np.float32)
    outputs = dict(zip((o.name for o in model.get_outputs()), model.run(None, {"input": tensor})))
    boxes = []
    for stride in (8, 16, 32):
        cls = outputs[f"cls_{stride}"].ravel()
        obj = outputs[f"obj_{stride}"].ravel()
        scores = np.sqrt(np.clip(cls, 0, 1) * np.clip(obj, 0, 1))
        for idx in np.flatnonzero(scores >= .79):
            row, col = divmod(idx, padded.shape[1] // stride)
            dx, dy, log_w, log_h = outputs[f"bbox_{stride}"][0, idx]
            cx, cy = (col + dx) * stride / w, (row + dy) * stride / h
            bw, bh = np.exp(log_w) * stride / w, np.exp(log_h) * stride / h
            boxes.append((float(scores[idx]), float(cx), float(cy), float(bw), float(bh)))
    # Keep one box per face across adjacent cells and feature-map scales.
    kept = []
    for box in sorted(boxes, reverse=True):
        _, cx, cy, bw, bh = box
        if not any(abs(cx - x) < bw / 3 and abs(cy - y) < bh / 3 for _, x, y, _, _ in kept):
            kept.append(box)
    return kept


def crop(image, rect):
    x, y, width, height = rect
    h, w = image.shape[:2]
    return image[max(0, round(h*y)):min(h, round(h*(y+height))),
                 max(0, round(w*x)):min(w, round(w*(x+width)))]


def room_signature(frame, rect):
    """Coarse colour samples from the two sides of a reviewed inset."""
    patch = crop(frame, rect).astype(np.float32)
    rows = np.array_split(patch, 6)
    return np.asarray([tile.mean(axis=(0, 1)) for row in rows
                       for i, tile in enumerate(np.array_split(row, 8, axis=1))
                       if i in (0, 1, 6, 7)])


def camera_faces(detected, rect):
    x, y, w, h = rect
    visible = []
    for boxes in detected:
        candidates = [(score, cx, cy, bw, bh) for score, cx, cy, bw, bh in boxes
                      if x <= cx <= x+w and y <= cy <= y+h and .12*h < bh < .91*h
                      and bw <= .91*w]
        visible.append(max(candidates, default=None))
    return visible


def references(channel):
    key = re.sub(r"[^a-z0-9]", "", channel.lower())
    gallery = json.loads((ASSETS / "rooms.json").read_text(encoding="utf-8"))
    return [item for item in gallery if key in item["channels"]]


def matching_room(frames, detected, profile):
    rect = profile["facecam"]
    visible = camera_faces(detected, rect)
    refs = np.array(profile["signatureBgr"])
    matches = 0
    for frame, face in zip(frames, visible):
        if face is None:
            continue
        signature = room_signature(frame, rect)
        # The streamer's posture can change a few side tiles. Require the
        # majority of distinct room colours to agree in their original places.
        delta = signature - refs
        # Allow a uniform change of exposure only while the spatial room
        # pattern stays highly correlated with the reviewed reference.
        if (min(signature.std(axis=0).mean(), refs.std(axis=0).mean()) > 15
                and np.corrcoef(signature.ravel(), refs.ravel())[0, 1] >= .88):
            delta -= np.clip(np.median(delta), -50, 50)
        error = np.abs(delta).mean(axis=1)
        if np.median(error) <= 20 and np.percentile(error, 75) <= 38:
            matches += 1
    return matches


def inset_edges(frames):
    # Seek persistent display-aligned cuts on both axes across the whole shot.
    stack = np.array(frames, dtype=np.float32)
    dx = np.abs(stack[:, :, 2:] - stack[:, :, :-2]).mean(axis=-1)
    dy = np.abs(stack[:, 2:] - stack[:, :-2]).mean(axis=-1)
    vertical = np.pad(np.quantile(dx, .25, axis=0), ((0, 0), (1, 1)))
    horizontal = np.pad(np.quantile(dy, .25, axis=0), ((1, 1), (0, 0)))
    return vertical, horizontal


def strongest_side(gradient, start, stop, span_start, span_stop):
    # The gradient's first dimension is the coordinate perpendicular to the edge.
    length = gradient.shape[0]
    start, stop = max(0, start), min(length-1, stop)
    if start > stop or span_stop - span_start < 6:
        return None
    lines = gradient[start:stop+1, span_start:span_stop]
    strength = np.mean(np.minimum(lines, 100), axis=1)
    persistent = (strength >= 18) & (np.mean(lines > 12, axis=1) >= .60)
    if not persistent.any():
        return None
    return start + int(np.argmax(np.where(persistent, strength, 0)))


def locate_inset(frames, detected):
    height, width = frames[0].shape[:2]
    vertical, horizontal = inset_edges(frames)
    for _, cx, cy, fw, fh in detected[len(detected)//2]:
        if not .025 <= fh <= .22 or .35 <= cx <= .65:
            continue
        x, y, w, h = int(cx*width), int(cy*height), max(5, int(fw*width)), max(8, int(fh*height))
        # Search beyond the face itself so hair, eyes and chin do not
        # supply the borders of an inferred camera panel.
        span_start, span_end = max(0, x-3*w//2), min(width, x+3*w//2)
        top = strongest_side(horizontal, y-3*h, y-2*h//3, span_start, span_end)
        bottom = strongest_side(horizontal, y+2*h//3, y+4*h, span_start, span_end)
        if top is None and y < 2.5*h:
            top = 0
        if bottom is None and height-y < 2.5*h:
            bottom = height
        if top is None or bottom is None or not .12*height <= bottom-top <= .46*height:
            continue
        a, b = top+3, bottom-3
        left = strongest_side(vertical.T, x-6*w, x-2*w//3, a, b)
        right = strongest_side(vertical.T, x+2*w//3, x+6*w, a, b)
        if left is None and x < 2.5*w:
            left = 0
        if right is None and width-x < 2.5*w:
            right = width
        if left is None or right is None or not .09*width <= right-left <= .36*width:
            continue
        if not .75 <= (right-left)/(bottom-top) <= 2.2:
            continue
        rect = [left/width, top/height, (right-left)/width, (bottom-top)/height]
        seen = [face for face in camera_faces(detected, rect) if face is not None]
        if len(seen) < len(frames)-1:
            continue
        # Static portraits and window frames in a single camera shot can have
        # equally strong edges. Require independent motion on both sides.
        stack = np.stack(frames).astype(np.float32)
        motion = np.abs(np.diff(stack, axis=0)).mean(axis=(0, 3))
        inside = crop(motion, rect)
        gameplay = motion[:, width//2-width//8:width//2+width//8]
        face_motion = [crop(motion, [sx-sw/2, sy-sh/2, sw, sh]).mean()
                       for _, sx, sy, sw, sh in seen]
        if (np.median(gameplay) < 14 or np.median(inside) > .72*np.median(gameplay)
                or np.median(face_motion) < 4):
            continue
        return rect
    return None


def analyze(frames, times, channel, settings):
    report = {"sampleMs": times, "confidence": "low"}
    if len(frames) < 4:
        return {**report, "reason": "Too few distinct decoded frames to verify a camera inset."}
    if any(frame.shape != frames[0].shape for frame in frames):
        return {**report, "reason": "The source changed dimensions during this clip."}
    if frames[0].shape[0] >= frames[0].shape[1]:
        return {**report, "reason": "Portrait source; retain the original composition."}
    model = face_detector()
    detected = [faces(model, frame) for frame in frames]
    report["framesWithFaces"] = sum(bool(boxes) for boxes in detected)
    known = references(channel)
    for p in known:
        matches = matching_room(frames, detected, p)
        if matches >= 4:
            rect = p["facecam"]
            use_profile = settings.get("facecam") and np.allclose(settings["facecam"], rect, atol=.014)
            return {**report, "confidence": "high", "reason": f"Reviewed room and face visible in {matches}/{len(frames)} samples.",
                    "facecam": settings["facecam"] if use_profile else rect,
                    "gameplay": settings["gameplay"] if use_profile else p["gameplay"],
                    **({"hud": p["hud"]} if "hud" in p else {})}
    rect = locate_inset(frames, detected)
    if rect is None:
        return {**report, "reason": "Several frames showed insufficient evidence of a separate active camera inset."}
    # Keep reviewed crops when the detected inset encloses that same facecam.
    source_profile = settings if settings.get("facecam") else next(iter(known), {})
    reviewed = source_profile.get("facecam")
    if reviewed and sum(face is not None for face in camera_faces(detected, reviewed)) >= 4:
        a = np.array(reviewed)
        b = np.array(rect)
        if np.all(np.abs(a[:2]+a[2:]/2-b[:2]-b[2:]/2) < np.minimum(a[2:], b[2:])*.38):
            return {**report, "confidence": "high", "reason": "Persistent moving camera inset agrees with the source crop.",
                    "facecam": reviewed, "gameplay": source_profile["gameplay"],
                    **({"hud": source_profile["hud"]} if "hud" in source_profile else {})}
    # Leave the widest gameplay rectangle that omits the camera.
    x, _, w, _ = rect
    game = [x+w, 0, 1-x-w, 1] if x < .5 else [0, 0, x, 1]
    return {**report, "confidence": "high", "reason": "Fixed inset edges enclose a moving face across separate gameplay changes.",
            "facecam": rect, "gameplay": game}


def dialogue_band(frames, layout, profile):
    """Compare texture and motion behind short phrases in the composed gameplay panel."""
    if len(frames) < 2:
        return .77
    ys = [.77, .75, .79, .80]
    candidates = []
    for y in ys:
        patches = []
        for frame in frames:
            h, w = frame.shape[:2]
            rect = layout.get("gameplay") or profile.get("gameplayCrop") or [0, 0, 1, 1]
            x0, y0, rw, rh = rect
            pw, ph = rw*w, rh*h
            seam = round(1920*profile.get("fraction", .53)) if layout.get("facecam") else 0
            canvas = 1920-seam
            scale = (max if seam else min)(1080/pw, canvas/ph)
            # Transform this output strip back through the crop and scale.
            xc, yc = (x0+rw/2)*w, (y0+rh/2)*h + (1920*y-seam-canvas/2)/scale
            top, bottom = max(int(y0*h), round(yc-26/scale)), min(int((y0+rh)*h), round(yc+26/scale))
            left, right = max(int(x0*w),round(xc-310/scale)), min(int((x0+rw)*w),round(xc+310/scale))
            if bottom-top < 2 or right-left < 2:
                break
            patches.append(frame[top:bottom,left:right].mean(axis=2))
        if len(patches) != len(frames):
            # The wide picture ends above this band.
            cost = 0
        else:
            edges = np.mean([np.abs(np.diff(p,axis=1)).mean()+np.abs(np.diff(p,axis=0)).mean() for p in patches])
            motion = np.mean([np.abs(a-b).mean() for a,b in zip(patches,patches[1:])])
            cost = edges + .3*motion
        candidates.append((cost + abs(y-.77)*10, y))
    return min(candidates)[1]


def main():
    path, start_ms, end_ms, channel, profile = sys.argv[1:]
    frames, times = frames_at(Path(path), int(start_ms), int(end_ms))
    settings = json.loads(profile)
    result = analyze(frames, times, channel, settings)
    result["subtitleY"] = dialogue_band(frames, result, settings)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
