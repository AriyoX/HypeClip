"""Victus acceptance runner. All providers are replaced before the CLI starts."""
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time

import psutil
from gta6_fixtures import build, SHOWS

ROOT = Path(__file__).resolve().parents[1]


def binaries():
    os.chdir(ROOT)
    binary = shutil.which("ffmpeg") or next((Path(os.environ["LOCALAPPDATA"]) / "HypeClip/tools").glob("*/bin/ffmpeg.exe"))
    os.environ.update(HYPECLIP_FFMPEG=str(binary), HYPECLIP_FFPROBE=str(Path(binary).with_name("ffprobe.exe")))


def environment(run):
    # Do not inherit credentials, CLI preloads, provider endpoints, proxy or .env.
    keys = "PATH PATHEXT SYSTEMROOT WINDIR COMSPEC SYSTEMDRIVE TEMP TMP USERPROFILE HOME LOCALAPPDATA APPDATA PROGRAMDATA PROGRAMFILES PROGRAMFILES(X86) HYPECLIP_FFMPEG HYPECLIP_FFPROBE"
    env = {k: os.environ[k] for k in keys.split() if k in os.environ}
    return dict(env,HYPECLIP_ISOLATED="1",HYPECLIP_HOME=str(run/"state"),HYPECLIP_CALL_LOG=str(run/"provider.log"),
                OLLAMA_BASE_URL="http://localhost:11434",OLLAMA_MODEL="qwen3:4b",HF_HUB_OFFLINE="1")


def inject(path, anchor, delay, stop):
    base = dt.datetime.fromisoformat(anchor.replace("Z","+00:00")).timestamp()
    for t, user, message in [(i,0,"Following the discussion") for i in range(4,40,5)] + [
            (42+delay/1000,i,("Wow, the arrow flipped!" if path.stem=="detail" else "Wow, seven for rain!")) for i in range(8)]:
        if stop.wait(max(0,base+t-time.time())):
            return
        stamp = dt.datetime.fromtimestamp(base+t,dt.timezone.utc).isoformat(timespec="milliseconds")
        with path.open("a",encoding="utf-8") as out:
            out.write(json.dumps(dict(eventId=f"{path.stem}-{t}-{user}",userId=f"sim-{user}",eventAt=stamp,
                                      receivedAt=dt.datetime.now(dt.timezone.utc).isoformat(),text=message,fixture=True))+"\n")


def sample(pid, stop, dest):
    system=psutil.virtual_memory()
    peak_rss=peak_cpu=0
    low_free=system.available
    gpu_peak=None
    while not stop.wait(1):
        processes=[]
        try:
            processes=[psutil.Process(pid),*psutil.Process(pid).children(recursive=True)]
        except psutil.Error:
            pass
        rss=0
        for p in processes:
            try:rss+=p.memory_info().rss
            except psutil.Error:pass
        peak_rss=max(peak_rss,rss)
        peak_cpu=max(peak_cpu,psutil.cpu_percent())
        low_free=min(low_free,psutil.virtual_memory().available)
        if shutil.which("nvidia-smi"):
            gpu=subprocess.run(["nvidia-smi","--query-gpu=memory.used","--format=csv,noheader,nounits"],capture_output=True,text=True)
            if gpu.returncode==0:gpu_peak=max(gpu_peak or 0,int(gpu.stdout.strip().splitlines()[0]))
    dest.write_text(json.dumps(dict(peakCliTreeRSS=peak_rss,peakSystemCPUPercent=peak_cpu,minSystemAvailableRAM=low_free,
                                   peakSystemGPUUsedMiB=gpu_peak,systemRAM=system.total),indent=2))


def capture(run):
    fixtures=run/"fixtures"
    if not (fixtures/"manifest.json").exists():
        build(fixtures)
    env=environment(run)
    cmd=["node","--experimental-strip-types","--import","./tests/support/observe-publisher.mjs","cli.ts","live-multi","--manifest",str(fixtures/"manifest.json"),"--once"]
    stop=threading.Event()
    with (run/"stderr.log").open("w") as err, (run/"events.jsonl").open("w") as log, subprocess.Popen(
            cmd,env=env,cwd=ROOT,stdout=subprocess.PIPE,stderr=err,text=True,encoding="utf-8") as process:
        monitor=threading.Thread(target=sample,args=(process.pid,stop,run/"resources.json"))
        monitor.start()
        try:
            for line in process.stdout:
                log.write(line);log.flush()
                event=json.loads(line)
                print(event,flush=True)
                if event["event"]=="capture-start":
                    key=event["source"]
                    delay=next(s[4] for s in SHOWS if s[0]==key)
                    threading.Thread(target=inject,args=(fixtures/(key+".jsonl"),event["anchor"],delay,stop),daemon=True).start()
            if process.wait():
                raise RuntimeError((run/"stderr.log").read_text())
        finally:
            stop.set();monitor.join()
    if (run/"provider.log").exists():
        raise RuntimeError("Publisher observer recorded an unexpected call")


if __name__=="__main__":
    binaries()
    parent=Path(os.environ["LOCALAPPDATA"])/"HypeClip/gta6-runs"
    parent.mkdir(parents=True,exist_ok=True)
    run=Path(tempfile.mkdtemp(prefix="run-",dir=parent))
    print(run,flush=True)
    capture(run)
    from gta6_handoff import deliver
    deliver(run,environment(run))
