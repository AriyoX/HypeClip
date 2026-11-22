"""Probe and decode the copies in the Windows Videos known folder."""
import datetime as dt
from difflib import SequenceMatcher
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import socket
import sqlite3
import subprocess

import numpy as np


def command(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout


def sha(path):
    with open(path,"rb") as stream:
        return hashlib.file_digest(stream,"sha256").hexdigest()


def utc(ms):
    return dt.datetime.fromtimestamp(ms/1000,dt.timezone.utc).isoformat(timespec="milliseconds")


def test_suite(run, env):
    folder=run/"checks"
    folder.mkdir(exist_ok=True)
    result=[]
    commands=[
        ("TypeScript",["node","node_modules/typescript/bin/tsc","--noEmit"]),
        ("Vitest",["node","node_modules/vitest/vitest.mjs","run"]),
        ("Python worker",[str(Path(".venv/Scripts/python.exe").resolve()),"-m","unittest","discover","-s","workers/tests","-v"]),
    ]
    for name,args in commands:
        check=subprocess.run(args,capture_output=True,env=env)
        output=(check.stdout+b"\n"+check.stderr).decode("utf-8",errors="replace")
        (folder/(name+".log")).write_text(output,encoding="utf-8")
        if check.returncode:
            raise RuntimeError(f"{name} failed. See {folder}")
        match=re.search(r"Tests\s+(\d+) passed|Ran (\d+) tests",re.sub(r"\x1b\[[\d;]*m","",output))
        result.append(name+" passed" + (" ("+next(i for i in match.groups() if i)+" tests)" if match else ""))
    # Exercise a real connection failure on a copy of the finished queue.
    with tempfile.TemporaryDirectory(dir=run) as tmp:
        src=sqlite3.connect(run/"state/jobs.sqlite")
        dest=sqlite3.connect(Path(tmp)/"jobs.sqlite")
        src.backup(dest)
        job,raw=dest.execute("select id,result from jobs where result is not null limit 1").fetchone()
        media=json.loads(raw)
        paths=[Path(media[k]) for k in ("originalPath","verticalPath","transcriptPath","subtitlePath")]
        before=[(p.stat().st_mtime_ns,sha(p)) for p in paths]
        dest.close();src.close()
        with socket.socket() as port:
            port.bind(("127.0.0.1",0))
            local=dict(env,HYPECLIP_HOME=tmp,OLLAMA_BASE_URL=f"http://127.0.0.1:{port.getsockname()[1]}")
            body=json.loads(command(["node","--experimental-strip-types","--import","./tests/support/observe-publisher.mjs","cli.ts","evaluate",job],env=local))
        assert body["state"]=="review" and body["evaluation"].get("error")
        assert before==[(p.stat().st_mtime_ns,sha(p)) for p in paths]
        assert not (run/"provider.log").exists()
    result.append("Real loopback Ollama outage: review, all four artifacts retained byte-for-byte and zero publisher calls.")
    return result


def validate_media(output, source, other, start, script, subtitles, preview):
    ff=os.environ["HYPECLIP_FFMPEG"]
    streams=json.loads(command([os.environ["HYPECLIP_FFPROBE"],"-v","error","-show_format","-show_streams","-of","json",str(output)]))
    video,audio=streams["streams"]
    assert (video["width"],video["height"],video["codec_name"],audio["codec_name"])==(1080,1920,"h264","aac")
    command([ff,"-v","error","-xerror","-i",str(output),"-map","0:v","-map","0:a","-f","null","-"])
    def picture(path,t):
        data=command([ff,"-v","error","-ss",str(t),"-i",str(path),"-vf","scale=135:240,crop=135:145:0:0","-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","-"])
        return np.frombuffer(data,dtype="uint8").astype(float)
    t=44-start
    actual=picture(output,t)
    errors=[float(np.abs(actual-picture(p,44)).mean()) for p in (source,other)]
    assert errors[0]<5 and errors[1]>errors[0]+10, errors
    def sound(path,offset):
        raw=command([ff,"-v","error","-ss",str(offset),"-i",str(path),"-t","55","-vn","-ar","1000","-ac","1","-f","f32le","-"])
        return np.frombuffer(raw,dtype="<f4")
    a=sound(source,start); b=sound(output,0)
    # Use 10 ms RMS envelopes, robust to AAC re-encoding. Check offset in both directions.
    n=min(len(a),len(b))//10*10
    a,b=[np.sqrt(np.mean(x[:n].reshape(-1,10)**2,axis=1)) for x in (a,b)]
    correlations=[float(np.corrcoef(a[60:-60],b[60+i:len(b)-60+i])[0,1]) for i in range(-50,51)]
    shift=(int(np.argmax(correlations))-50)*10
    assert abs(shift)<180 and max(correlations)>.90,(shift,max(correlations))
    def seconds(s):
        h,m,t=s.replace(",",".").split(":")
        return int(h)*3600+int(m)*60+float(t)
    cues=[(seconds(a),seconds(b)) for a,b in re.findall(r"([\d:,]+) --> ([\d:,]+)",subtitles.read_text(encoding="utf-8"))]
    assert cues and all(0<=a<b<=55.05 for a,b in cues)
    # Compare the actual audio envelope with the subtitle intervals.
    covered = np.zeros(len(b), dtype=bool)
    for begin, end in cues:
        covered[max(0, round(begin * 100) - 20):round(end * 100) + 20] = True
    voiced = b > max(.002, np.percentile(b, 85) * .12)
    cue_coverage = float(covered[voiced].mean())
    assert cue_coverage > .85, cue_coverage


    blocks=subtitles.read_text(encoding="utf-8").strip().split("\n\n")
    # Select the spoken payoff, well inside its on-screen subtitle interval.
    candidates=[cue for cue,block in zip(cues,blocks) if cue[0]<51-start and cue[1]>42.6-start and
                re.search(r"flipped|votes? for rain",block,re.I)]
    cue=(candidates or [cue for cue in cues if cue[0]<48-start and cue[1]>43-start])[-1]
    preview_at=(cue[0]+cue[1])/2
    command([ff,"-v","error","-y","-ss",str(preview_at),"-i",str(output),"-frames:v","1","-q:v","2",str(preview)])
    # Compare the caption zone against the decoded source at the same instant.
    def bright_caption_pixels(path,t):
        pixels=command([ff,"-v","error","-ss",str(t),"-i",str(path),"-vf","scale=270:480,crop=270:105:0:366",
                        "-frames:v","1","-pix_fmt","gray","-f","rawvideo","-"])
        return int((np.frombuffer(pixels,dtype="uint8")>210).sum())
    assert bright_caption_pixels(output,preview_at)>bright_caption_pixels(source,start+preview_at)+50
    actual_words = " ".join(" ".join(block.splitlines()[2:]) for block in blocks)
    expected_words = " ".join(line for ts, line in script if start <= ts < start + 55)
    numbers = {"1":"one","2":"two","3":"three","4":"four","7":"seven","10":"ten"}
    def words(text):
        return [numbers.get(token,token) for token in re.findall("[a-z0-9]+",text.lower())]
    original, heard = words(expected_words), words(actual_words)
    review = []
    for op, a1, a2, b1, b2 in SequenceMatcher(None,original,heard,autojunk=False).get_opcodes():
        if op != "equal":
            review.append({"script":" ".join(original[a1:a2]),"subtitle":" ".join(heard[b1:b2])})
    return dict(voicedCueCoverage=round(cue_coverage,4),subtitleReview=review,duration=float(streams["format"]["duration"]),video="H.264 1080x1920",audio="AAC",srtCues=len(cues),audioOffsetMs=shift,
                audioCorrelation=round(max(correlations),4),pictureMeanError=errors,decodedAllFrames=True,previewCue=cue)


def deliver(run,env):
    db=sqlite3.connect(run/"state/jobs.sqlite")
    db.row_factory=sqlite3.Row
    windows=list(db.execute("select * from live_windows order by source"))
    assert len(windows)==2 and db.execute("select count(*) from intents").fetchone()[0]==0
    assert db.execute("select count(*) from policy").fetchone()[0]==0
    events=[json.loads(l) for l in (run/"events.jsonl").read_text().splitlines()]
    evidence=json.loads((run/"resources.json").read_text())
    tests=test_suite(run,env)
    from gta6_faults import verify
    fault=verify(run,env)
    tests.append("Killed the poll receiver during post-roll. Its peer advanced. Killed and restarted the coordinator with a pending reservation.")
    tests.append(f"Recovered the same candidate. Real queue hold {fault['queueDelayMs']/1000:.3f}s exceeded {fault['retentionMs']/1000:.0f}s retention; zero original segments remained. Render passed and the offline evaluator preserved the video for review.")
    folder=Path(subprocess.check_output(["powershell","-NoProfile","-Command","[Environment]::GetFolderPath('MyVideos')"],text=True).strip())
    assert folder.is_absolute()
    target=folder/"HypeClip/GTA6-Demo"/(dt.datetime.now().strftime("%Y-%m-%d_%H-%M-%S"))
    target.mkdir(parents=True)
    entries={r["id"]:r for r in json.loads((run/"fixtures/editorial.json").read_text())}
    lines=["HypeClip | GTA 6 discussion fixtures","Two original local TTS broadcasts, fed at 1x. Synthetic chat. Local review only.",
           "Whisper small on CPU/int8; qwen3:4b via local Ollama. Mock publishers. Zero intents and provider calls.",
           "Working files and test logs: "+str(run),""]
    stages=[dict(r) for r in db.execute("select * from live_stages order by start")]
    assert all(s["end"] is not None for s in stages)
    for s in stages:
        active=[t["stage"] for t in stages if t["start"]<=s["start"]<t["end"]]
        assert len(active)<=2 and len(set(active))==len(active)
    overlap=[]
    for a,b in itertools.combinations(stages,2):
        ms=min(a["end"],b["end"])-max(a["start"],b["start"])
        if ms>0 and a["job"]!=b["job"]:
            ids={w["id"]:w["source"] for w in windows}
            overlap.append(f'{ids[a["job"]]} {a["stage"]} + {ids[b["job"]]} {b["stage"]}: {ms/1000:.3f}s')
    assert overlap,"No measured processing overlap"
    for w in windows:
        key=w["source"];entry=entries[key]
        job=db.execute("select * from jobs where id=?",(w["id"],)).fetchone()
        result=json.loads(job["result"]); model=json.loads(job["evaluation"])
        assert model.get("decision") and model["model"]=="qwen3:4b",model
        end=next(e for e in events if e["event"]=="clip-finished" and e["source"]==key)
        assert end["inputRunning"] and w["decisionAt"] < end["at"]
        assert w["destination"]==job["destination"]=="local-gta6-review"
        name=("Frame Desk - The Arrow Flip" if key=="detail" else "Forecast Club - Rain or Radio")
        out=target/(name+".mp4");sub=out.with_suffix(".srt")
        shutil.copyfile(result["verticalPath"],out);shutil.copyfile(result["subtitlePath"],sub)
        assert sha(out)==sha(result["verticalPath"])==result["sha256"]
        out.with_suffix(".txt").write_text(entry["caption"]+"\n",encoding="utf-8")
        media=validate_media(out,run/f"fixtures/{key}.mp4",run/f"fixtures/{'poll' if key=='detail' else 'detail'}.mp4",
                             w["start"]/1000,entry["script"],sub,target/(name+" - Preview.jpg"))
        timings={k:utc(w[k]) for k in ("triggerAt","readyAt","renderAt","decisionAt")}
        metadata=dict(fixture="Local synthetic GTA 6 discussion stream",source=key,show=entry["show"],destination=w["destination"],
                      editorialCaption=entry["caption"],script=entry["script"],review="Check automatic subtitles against the supplied original script. Poll counts are fictional. Artwork is original.",
                      generatedEvaluation=model,transcript=json.loads(Path(result["transcriptPath"]).read_text(encoding="utf-8")),sha256=sha(out),
                      testedSourceFile=result["verticalPath"],verified=media,timesUTC=timings,candidate=w["id"],windowMs=[w["start"],w["end"]])
        out.with_suffix(".json").write_text(json.dumps(metadata,indent=2,ensure_ascii=False),encoding="utf-8")
        lines.extend([name+" | "+key+" -> "+w["destination"], "  Source window %.3f to %.3fs. Simulated chat delay %.1fs."%(w["start"]/1000,w["end"]/1000,2.3 if key=="detail" else 6),
                      "  "+" | ".join(f"{k} {v}" for k,v in timings.items()),
                      "  Decision %.3fs after trigger; capture still running at %.3fs."%((w["decisionAt"]-w["triggerAt"])/1000,end["head"]/1000),
                      f"  {media['duration']:.3f}s, {media['video']}, AAC. Full decode passed. Audio offset {media['audioOffsetMs']}ms. {media['srtCues']} subtitle cues.",
                      "  Spoken-script differences for editorial review: "+json.dumps(media["subtitleReview"]),
                      "  Qwen "+model["decision"]["decision"]+"; queue "+job["state"]+". SHA-256 "+sha(out),""])
    gaps=[e for e in events if e["event"] in ("gap","disconnect","input-error","input-ended")]
    storage=next(e for e in events if e["event"]=="storage")
    lines+=["Trigger separation %.3fs"%(abs(windows[0]["triggerAt"]-windows[1]["triggerAt"])/1000),"Measured cross-clip overlap:",*overlap,
            "Capture gaps or unexpected endings: "+json.dumps(gaps),f"Peak CLI process-tree working set {evidence['peakCliTreeRSS']/2**20:.1f} MiB. Peak system CPU {evidence['peakSystemCPUPercent']:.1f}%. Minimum available system RAM {evidence['minSystemAvailableRAM']/2**30:.2f} GiB. Peak system GPU memory {evidence['peakSystemGPUUsedMiB']} MiB.",
            f"Peak sampled state directory {storage['peakSampledBytes']/2**20:.1f} MiB. Minimum free disk {storage['minFreeDiskBytes']/2**30:.1f} GiB.","",*tests,
            "Provider duplicate-send and ambiguous-response reconciliation checks used mocks. No live account integrations exercised."]
    db.close()
    (target/"results.txt").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print(target,flush=True)
