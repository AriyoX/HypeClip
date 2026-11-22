"""Build two local discussion broadcasts from original artwork and Windows voices."""
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import wave

from PIL import Image, ImageDraw, ImageFont

DURATION = 240
SHOWS = [
    ("detail", "Frame Desk", "The arrow test", "Hazel", 2300, [
        (12, "I made a little sign for our trailer discussion. Watch the arrow in the window."),
        (22, "Here is the game. Close your eyes, count to three, then tell me which way it points."),
        (33, "The first card points left. I am going to switch cards. Watch the window."),
        (42, "Did anyone else catch that detail? The arrow flipped. Now it points right."),
        (52, "Same street, same sign, opposite direction. That is how a tiny edit can change where you look."),
        (61, "This is my drawing for our discussion. Try the two cards again."),
        (82, "For the next exercise, sketch your own street sign. Start with the outline and leave the lettering out."),
        (103, "Now hide one corner of the sign. Does the direction still read clearly? Mine needs a wider arrow."),
        (130, "For a night version I would try a pale blue border against a dark sky. The edge has to stay visible."),
        (159, "What if sound led your eye before the sign even changed? A bicycle bell could do it."),
        (188, "I would save the bell for the second card. The first pass gives the audience time to look."),
        (218, "That finishes our storyboard exercise. Next time I want to try the same edit with two sounds."),
    ]),
    ("poll", "Forecast Club", "Rain or radio?", "Zira", 6000, [
        (12, "Time for our prediction poll. What would make the better opening sound for an imaginary trailer?"),
        (22, "Rain on a roof, or a radio tuning in? I picked the radio. I like the crackle before a song."),
        (34, "Our sample votes are in. Ten in total. Let's count it down. Three, two, one."),
        (42, "Rain wins! Seven votes for rain, three for radio. My prediction missed by four votes."),
        (53, "I can hear that first drop before the picture even appears. Which sound would you choose?"),
        (62, "These are made up votes for our discussion, and the trailer idea is a prediction."),
        (84, "For the rain version, I would begin with three drops, then let the room go quiet."),
        (105, "For radio, my version would start halfway through a weather report. A voice can place you in a scene."),
        (132, "Both sounds suggest a place before the picture arrives. That is what makes this prediction fun."),
        (156, "Try making the rain sound with your fingers on a desk. Tap slowly, then bring in the other hand."),
        (187, "Now imagine those taps cutting out when the picture arrives. The silence becomes part of the reveal."),
        (217, "Keep your own vote. We can use the same two choices for another sound experiment."),
    ]),
]
CAPTIONS = [
    "Did you spot the arrow flip? Two original cards, one tiny edit. Local GTA 6 discussion fixture with simulated chat. #GTA6 #TrailerDiscussion",
    "Rain or radio for an imaginary trailer opener? Rain wins our fictional poll, 7 to 3. Local GTA 6 prediction fixture with simulated votes. #GTA6 #FanPrediction",
]


def font(size, bold=False, mono=False):
    face = "consola.ttf" if mono else ("arialbd.ttf" if bold else "arial.ttf")
    return ImageFont.truetype(str(Path(os.environ["WINDIR"]) / "Fonts" / face), size)


def card(directory, index, phase):
    key, show, title, *_ = SHOWS[index]
    ink, paper = ("#17253A", "#FFF1D4") if not index else ("#151F22", "#E4F3E6")
    accent = "#FF9268" if not index else "#AEF478"
    canvas = Image.new("RGB", (540, 960), ink)
    d = ImageDraw.Draw(canvas)
    def label(x, y, words, size, color=paper, bold=False, mono=False):
        d.text((x, y), words, font=font(size, bold, mono), fill=color, stroke_width=0)
    d.rectangle((0, 0, 539, 9), fill=accent)
    label(32, 36, "LOCAL FIXTURE   /   SIMULATED STREAM", 19, accent, mono=True)
    label(32, 92, show, 61, bold=True)
    label(34, 174, "GTA 6   /   " + ("TRAILER DISCUSSION" if not index else "FAN PREDICTIONS"), 22, mono=True)
    if not index:
        d.rectangle((32, 243, 508, 543), fill="#EFAD85")
        d.ellipse((338, 265, 455, 382), fill="#FFE39B")
        for j in range(10):
            x = 32 + j * 48
            top = 375 - round(45 * math.sin(j * 2))
            d.rectangle((x, top, x+37, 542), fill="#80566A")
            for y in range(top + 10, 532, 22):
                d.rectangle((x+8, y, x+17, y+7), fill="#E3A386")
        d.rectangle((128, 338, 405, 484), fill=ink, outline=paper, width=5)
        points = [(165,411),(223,369),(223,390),(370,390),(370,432),(223,432),(223,452)]
        if phase >= 1:
            points = [(535-x,y) for x,y in points]
        d.polygon(points, fill=accent)
        label(32, 564, "ORIGINAL STORYBOARD   /   " + ("CARD B" if phase else "CARD A"), 18, accent, mono=True)
    else:
        d.rectangle((32, 243, 508, 543), fill="#293837")
        label(55, 267, "FICTIONAL POLL", 23, accent, mono=True)
        for j, word in enumerate(["Rain", "Radio"]):
            y = 323 + 99*j
            label(55, y, word, 29, bold=True)
            d.rectangle((55, y+43, 484, y+61), fill="#4E625A")
            if phase:
                d.rectangle((55, y+43, 55 + (300 if j == 0 else 129), y+61), fill=accent if j==0 else "#86B4AB")
                label(437, y-2, "7" if not j else "3", 30, bold=True)
        label(32, 564, "SAMPLE VOTES   /   " + ("RESULT" if phase else "COUNTDOWN"), 18, accent, mono=True)
    label(32, 605, title, 46, bold=True)
    d.line((32, 701, 508, 701), fill=accent)
    label(32, 718, "SYNTHETIC CHAT", 17, accent, mono=True)
    label(32, 750, (("SketchFan   Left, I think.", "SketchFan   It flipped right!") if not index else
                       ("RainFan   My guess is rain.", "RainFan   Seven for rain!"))[phase==2], 22)
    # Keep all editorial graphics above the worker's burned-in subtitle area.
    content = canvas.crop((0, 10, 540, 790)).resize((472, 682), Image.Resampling.LANCZOS)
    frame = Image.new("RGB", canvas.size, ink)
    frame.paste(content, (34, 10))
    ImageDraw.Draw(frame).rectangle((0, 0, 539, 9), fill=accent)
    frame.save(directory / f"{key}-{phase}.png")


def build(directory):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "speech.json").write_text(json.dumps(SHOWS), encoding="utf-8")
    # SpeechSynthesizer ships with Windows PowerShell / .NET Framework.
    subprocess.run(["powershell", "-NoProfile", "-File", str(Path(__file__).with_name("gta6-voices.ps1")), str(directory)], check=True)
    sources = []
    for index, (key, show, title, _, delay, lines) in enumerate(SHOWS):
        for phase in range(3):
            card(directory, index, phase)
        pcm = None
        for i, (start, _) in enumerate(lines):
            with wave.open(str(directory / f"{key}-{i}.wav")) as wav:
                assert wav.getsampwidth() == 2 and wav.getnchannels() == 1
                rate = wav.getframerate()
                if pcm is None:
                    pcm = bytearray(DURATION * rate * 2)
                data = wav.readframes(wav.getnframes())
                pcm[start*rate*2:start*rate*2+len(data)] = data
        with wave.open(str(directory / f"{key}.wav"), "wb") as wav:
            wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
            wav.writeframes(pcm)
        sequence = directory / f"{key}.ffconcat"
        marks = [0, 42, 42+delay/1000, DURATION]
        sequence.write_text("".join(f"file '{key}-{i}.png'\nduration {marks[i+1]-marks[i]}\n" for i in range(3)) + f"file '{key}-2.png'\n")
        filt = "fps=12,drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='%{pts\\:hms}':x=62:y=580:fontsize=20:fontcolor=white"
        target = directory / f"{key}.mp4"
        subprocess.run([os.environ["HYPECLIP_FFMPEG"], "-v","error","-y","-f","concat","-safe","1","-i",str(sequence),
                        "-i",str(directory/f"{key}.wav"),"-vf",filt,"-t",str(DURATION),"-c:v","libx264","-preset","ultrafast",
                        "-threads","3","-g","24","-bf","0","-pix_fmt","yuv420p","-c:a","aac","-metadata","comment=Local synthetic GTA 6 discussion fixture",str(target)],check=True)
        chat = directory / f"{key}.jsonl"
        chat.touch()
        sources.append(dict(id=key,file=str(target),chat=str(chat),reactionMs=delay,fixture=True,
                            destination="local-gta6-review",rights=True))
    (directory / "manifest.json").write_text(json.dumps({"sources":sources},indent=2))
    (directory / "editorial.json").write_text(json.dumps([dict(id=s[0],show=s[1],title=s[2],script=s[-1],caption=c) for s,c in zip(SHOWS,CAPTIONS)],indent=2))


if __name__ == "__main__":
    build(Path(sys.argv[1]).resolve())
