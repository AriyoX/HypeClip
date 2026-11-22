"""Kill a receiver, crash its coordinator, then release a delayed SQLite claim."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import time

import psutil


def until(check, timeout, description):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        value=check()
        if value:
            return value
        time.sleep(.2)
    raise RuntimeError("Timeout waiting for "+description)


def verify(run, env):
    folder=run/"faults"
    folder.mkdir(exist_ok=True)
    receipt=folder/"receipt.json"
    if receipt.exists():
        return json.loads(receipt.read_text())
    start=dt.datetime(2026,1,1,tzinfo=dt.timezone.utc)
    sources=json.loads((run/"fixtures/manifest.json").read_text())["sources"]
    for s in sources:
        s["chat"]=str(folder/(s["id"]+".jsonl"))
        s["mediaStart"]=start.isoformat(timespec="milliseconds")
        s["reactionMs"]=2000
        # A replayed chat spike at media 8s reserves [0,31).
        ts=(start+dt.timedelta(seconds=8)).isoformat(timespec="milliseconds")
        Path(s["chat"]).write_text("".join(json.dumps(dict(eventId=str(i),userId=f"sim-{i}",text="Wow!",
            fixture=True,eventAt=ts,receivedAt=ts))+"\n" for i in range(8)))
    manifest=folder/"manifest.json"
    manifest.write_text(json.dumps(dict(sources=sources,retentionMs=40000)))
    with socket.socket() as offline:
        offline.bind(("127.0.0.1",0))
        isolated=dict(env,HYPECLIP_HOME=str(folder/"state"),OLLAMA_BASE_URL=f"http://127.0.0.1:{offline.getsockname()[1]}",
                      HYPECLIP_CALL_LOG=str(folder/"calls.log"))
        cmd=["node","--experimental-strip-types","--import","./tests/support/observe-publisher.mjs","cli.ts","live-multi","--manifest",str(manifest),"--once"]
        log=folder/"events.jsonl"
        def events():
            return [json.loads(l) for l in log.read_text().splitlines() if l.endswith("}")]
        def spawn(logfile):
            return subprocess.Popen(cmd,env=isolated,stdout=logfile,stderr=errors)
        with log.open("w") as out,(folder/"stderr.log").open("w") as errors:
            proc=spawn(out)
            try:
                started=until(lambda:len([e for e in events() if e["event"]=="capture-start"])==2,25,"receivers")
                db=sqlite3.connect(folder/"state/jobs.sqlite",timeout=15,isolation_level=None)
                db.row_factory=sqlite3.Row
                try:
                    # A different, live test process holds the atomic claim. The
                    # real scheduler cannot render until that claim is released.
                    db.execute(f"""CREATE TRIGGER hold_job AFTER INSERT ON jobs BEGIN
                        UPDATE jobs SET owner='{os.getpid()}-fault-test',leaseUntil=32503680000000 WHERE id=NEW.id; END""")
                    until(lambda:db.execute("select count(*) from live_windows where state='waiting'").fetchone()[0]==2,22,"both reservations")
                    capture={e["source"]:psutil.Process(e["pid"]) for e in events() if e["event"]=="capture-start"}
                    capture["poll"].kill()
                    until(lambda:db.execute("select 1 from live_windows where source='poll' and state='incomplete'").fetchone(),10,"explicit early ending")
                    head=db.execute("select head from live_sources where id='detail'").fetchone()[0]
                    until(lambda:db.execute("select head from live_sources where id='detail'").fetchone()[0]>head,12,"peer capture advancement")
                    original=db.execute("select id from live_windows where source='detail'").fetchone()[0]
                    proc.kill();proc.wait(5)
                    until(lambda:not capture["detail"].is_running(),10,"orphaned FFmpeg to exit")
                    assert db.execute("select state from live_windows where id=?",(original,)).fetchone()[0]=="waiting"
                    proc=spawn(out)
                    def past_retention():
                        row=db.execute("select j.owner,w.readyAt,w.end,s.head from jobs j join live_windows w on j.id=w.id join live_sources s on s.id=w.source where j.id=?",(original,)).fetchone()
                        return row if row and row["owner"] and row["head"]>row["end"]+40000 and time.time()*1000-row["readyAt"]>40000 else None
                    held=until(past_retention,110,"post-roll, durable extract and complete eviction")
                    assert db.execute("select count(*) from live_segments where source='detail' and start<?",(held["end"],)).fetchone()[0]==0
                    path=Path(json.loads(db.execute("select details from jobs where id=?",(original,)).fetchone()[0])["request"]["candidate"]["sourcePath"])
                    digest=hashlib.sha256(path.read_bytes()).hexdigest()
                    delay=round(time.time()*1000-held["readyAt"])
                    db.execute("drop trigger hold_job")
                    db.execute("update jobs set owner=null,leaseUntil=null where id=?",(original,))
                    assert proc.wait(timeout=165)==0
                    result=db.execute("select state,result,evaluation from jobs where id=?",(original,)).fetchone()
                    assert result["state"]=="review" and json.loads(result["evaluation"]).get("error")
                    video=json.loads(result["result"])
                    assert hashlib.sha256(Path(video["verticalPath"]).read_bytes()).hexdigest()==video["sha256"]
                    assert hashlib.sha256(path.read_bytes()).hexdigest()==digest
                    assert db.execute("select count(*) from jobs").fetchone()[0]==1
                    assert not (folder/"calls.log").exists()
                    evidence=dict(droppedFeed="poll",continuedFeed="detail",crashedWithReservation=original,
                                  orphanCaptureReaped=True,retentionMs=40000,queueDelayMs=delay,originalSegmentsRemaining=0,
                                  recoveredState="review",ollama="unused local port",reservedSha256=digest,videoSha256=video["sha256"])
                    receipt.write_text(json.dumps(evidence,indent=2))
                    return evidence
                finally:
                    db.close()
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
