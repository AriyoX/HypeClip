from .errors import WorkerError
from .speech import Cue, SUBTITLE_LITERAL


def seam_height(height, settings):
    return 2 * round(height * settings.get("fraction", 0.53) / 2)


def panel_crop(rect):
    x, y, w, h = rect
    if w <= 0 or h <= 0 or x + w > 1.000001 or y + h > 1.000001:
        raise WorkerError("INVALID_CROP", "Panel crop extends outside the source frame.")
    return f"crop=iw*{w}:ih*{h}:iw*{x}:ih*{y}"


def composition(base, cover, width, height, settings):
    seam = seam_height(height, settings)
    if "facecam" in settings:
        branches = "split=3[cam][game][hud]" if "hud" in settings else "split=2[cam][game]"
        graph = (f"{base},{branches};"
                 f"[cam]{panel_crop(settings['facecam'])},{cover(width, seam)}[top];"
                 f"[game]{panel_crop(settings['gameplay'])},{cover(width, height - seam)}[bottom];"
                 "[top][bottom]vstack")
        if "hud" in settings:
            graph += (f"[panels];[hud]{panel_crop(settings['hud'])},scale={2*round(width*.14)}:-2,setsar=1[meter];"
                      f"[panels][meter]overlay=x=16:y={seam+16}:shortest=1")
    else:
        graph = f"{base},{cover(width, height)}"
        if settings.get("preserveDivider"):
            return graph
    return f"{graph},drawbox=x=0:y={seam - 3}:w=iw:h=6:color=0xEC1622:t=fill"


def phrase_groups(words, max_chars=23):
    group = []
    for word in words:
        if group and (len(" ".join(w.text for w in [*group, word])) > max_chars
                      or word.startMs - group[-1].endMs > 400
                      or word.endMs - group[0].startMs > 2200
                      or (group[-1].text.endswith(",") and word.startMs - group[-1].endMs >= 150)
                      or group[-1].text.endswith((".", "!", "?"))):
            yield group
            group = []
        group.append(word)
    if group:
        yield group


def ass_time(ms):
    seconds, cs = divmod(round(ms / 10), 100)
    return f"{seconds // 3600}:{seconds // 60 % 60:02}:{seconds % 60:02}.{cs:02}"


def scene_subtitles(path, scene, width, height, settings, duration):
    start, end = scene["startMs"], scene["endMs"]
    if not 0 <= start < end <= duration:
        raise WorkerError("INVALID_REQUEST", "Scene caption must fit within the clip.")
    text = scene["text"].translate(SUBTITLE_LITERAL)
    size = min(round(width * .053), round(width * 1.48 / max(1, len(text))))
    y = round(seam_height(height, settings) * scene["panelY"])
    path.write_text(f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Scene,Arial,{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,{max(2,round(size*.12))},0,5,20,20,0,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 0,{ass_time(start)},{ass_time(end)},Scene,,0,0,0,,{{\\pos({width//2},{y})}}{text}
""", encoding="utf-8")


def seam_subtitles(path, words, width, height, settings):
    size = settings.get("fontSize", 78)
    outline = settings.get("outline", 7)
    rgb = settings.get("highlightColor", "#873BFF")[1:]
    color = "&H00" + rgb[4:6] + rgb[2:4] + rgb[0:2]
    anchor = (f"{{\\an5\\pos({width // 2},{seam_height(height, settings) + settings.get('captionOffset', 0)})}}")
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 0
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Words,Arial,{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,{outline},0,5,28,28,0,1
Style: Box,Arial,{size},&HFFFFFFFF,&HFFFFFFFF,{color},{color},-1,0,0,0,100,100,0,0,3,3,0,5,28,28,0,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    events, phrases = [], []
    for group in phrase_groups(words, max(8, min(26, round(1.8 * width / size)))):
        tokens = [w.text.translate(SUBTITLE_LITERAL) for w in group]
        line = " ".join(tokens)
        phrases.append(Cue(group[0].startMs, group[-1].endMs, line))
        events.append(f"Dialogue: 1,{ass_time(group[0].startMs)},{ass_time(group[-1].endMs)},Words,,0,0,0,,{anchor}{line}")
        for i, w in enumerate(group):
            if ass_time(w.startMs) == ass_time(w.endMs):
                continue
            box = " ".join(("{\\3a&H00&}" if j == i else "{\\3a&HFF&}") + token
                           for j, token in enumerate(tokens))
            events.append(f"Dialogue: 0,{ass_time(w.startMs)},{ass_time(w.endMs)},Box,,0,0,0,,{anchor}{box}")
    path.write_text("\n".join([header, *events, ""]), encoding="utf-8")
    return phrases


def card_extent(path, header, lines, size, width, height):
    """Measure the actual libass glyphs on the same FFmpeg/font installation."""
    import subprocess
    import numpy as np
    from .video import binary
    from .stages import track

    band = min(height, max(100, round(size * 5)))
    band += band % 2
    text = r"\N".join(lines)
    mask = path.with_name("card-metrics.ass")
    mask.write_text(header.replace(f"PlayResY: {height}", f"PlayResY: {band}") +
                    f"\nDialogue: 0,0:00:00.00,0:00:01.00,Card,,0,0,0,,"
                    f"{{\\pos({width//2},{band//2})\\fs{size}\\1c&HFFFFFF&}}{text}\n", encoding="utf-8")
    try:
        args = [binary("ffmpeg"), "-v", "error", "-nostdin", "-f", "lavfi", "-i",
                f"color=black:s={width}x{band}", "-vf", "ass=filename=card-metrics.ass",
                "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]
        with subprocess.Popen(args, cwd=path.parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc, track(proc):
            data, _ = proc.communicate(timeout=30)
        if proc.returncode:
            raise WorkerError("RENDER_FAILED", "Could not measure scene card text.")
        ys, xs = np.where(np.frombuffer(data, np.uint8).reshape(band, width) > 64)
        if not xs.size:
            raise WorkerError("INVALID_REQUEST", "The scene caption has no visible glyphs.")
        return int(xs.max()-xs.min()+1), int(ys.max()-ys.min()+1), round((ys.min()+ys.max())/2-band/2)
    finally:
        mask.unlink(missing_ok=True)


def studio_subtitles(path, words, scene, width, height, split, presentation):
    """One ASS composition for the card and the independent phrase track."""
    import textwrap
    scale = width / 1080
    size, dialogue_size = round(56 * scale), round(38 * scale)
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Card,Segoe UI Semibold,{size},&H00121212,&H00121212,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1
Style: Dialogue,Segoe UI Semibold,{dialogue_size},&H00FFFFFF,&H00FFFFFF,&H00151515,&H00151515,0,0,0,0,100,100,0,0,1,{max(1,round(2.4*scale))},0,5,0,0,0,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"""
    events, phrases = [], []
    if scene:
        literal = scene["text"].translate(SUBTITLE_LITERAL)
        # Scale widths per glyph to keep narrow captions compact.
        def measure(text):
            return sum(.27 if c in " iIjl.,!|'’" else .84 if c in "WwMm@%" else
                       .61 if c.isupper() else .50 for c in text) * size
        limit = width * .65 - 44 * scale
        while True:
            lines = []
            for token in textwrap.wrap(literal, max(5, int(limit / size)), break_on_hyphens=False) if " " not in literal else literal.split():
                if lines and measure(lines[-1] + " " + token) <= limit:
                    lines[-1] += " " + token
                else:
                    lines.append(token)
            if len(lines) <= 3 and max(map(measure, lines)) <= limit or size <= width * .024:
                break
            size -= 1
        ink_w, ink_h, baseline = card_extent(path, header, lines, size, width, height)
        if ink_w > limit:
            size = max(1, int(size * limit / ink_w))
            ink_w, ink_h, baseline = card_extent(path, header, lines, size, width, height)
        w = round(ink_w + 36 * scale)
        h = round(ink_h + 24 * scale)
        panel = seam_height(height, split) if split and split.get("facecam") else height
        y = max(h//2 + 5, min(round(panel * scene["panelY"]), panel-h//2-round(12*scale)))
        x, top, r = (width - w)//2, y - h//2, max(2, round(12*scale))
        # ASS drawings and libass text share coordinates through preview and export.
        box = f"m {r} 0 l {w-r} 0 b {w} 0 {w} 0 {w} {r} l {w} {h-r} b {w} {h} {w} {h} {w-r} {h} l {r} {h} b 0 {h} 0 {h} 0 {h-r} l 0 {r} b 0 0 0 0 {r} 0"
        times = f'{ass_time(scene["startMs"])},{ass_time(scene["endMs"])}'
        events.append(f"Dialogue: 0,{times},Card,,0,0,0,,{{\\an7\\pos({x},{top})\\p1\\1c&HFFFFFF&}}{box}")
        text = r"\N".join(lines)
        events.append(f"Dialogue: 1,{times},Card,,0,0,0,,{{\\fs{size}\\pos({width//2},{y-baseline})}}{text}")
    seam = seam_height(height, split) if split and split.get("facecam") else 0
    y = max(seam + dialogue_size, round(height * presentation["subtitleY"]))
    for group in phrase_groups(words, 38):
        line = " ".join(w.text for w in group)
        a, b = group[0].startMs, group[-1].endMs
        phrases.append(Cue(a, b, line))
        events.append(f"Dialogue: 2,{ass_time(a)},{ass_time(b)},Dialogue,,0,0,0,,{{\\pos({width//2},{y})}}{line.translate(SUBTITLE_LITERAL)}")
    path.write_text("\n".join([header, *events, ""]), encoding="utf-8")
    return phrases
