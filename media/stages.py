"""Borrow a heavy-stage slot from the live coordinator over private pipes."""
from contextlib import contextmanager
import os
from pathlib import Path
import sys
from threading import Thread, Lock
import time

_children = set()
_lock = Lock()
_watching = False


def _watch_parent():
    parent = int(os.environ["HYPECLIP_STAGE_PARENT"])
    stop = Path(os.environ["HYPECLIP_STAGE_CANCEL"])
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        handle = kernel.OpenProcess(0x00100000, False, parent)  # SYNCHRONIZE
        while handle and kernel.WaitForSingleObject(handle, 250) == 258 and not stop.exists():
            pass
    else:
        while os.getppid() == parent and not stop.exists():
            time.sleep(0.25)
    with _lock:
        for child in _children:
            child.kill()
    os._exit(1)


@contextmanager
def track(child):
    with _lock:
        _children.add(child)
    try:
        yield
    finally:
        with _lock:
            _children.discard(child)


@contextmanager
def stage(name):
    global _watching
    if not os.environ.get("HYPECLIP_STAGE_CONTROL"):
        yield
        return
    if not _watching:
        _watching = True
        Thread(target=_watch_parent, daemon=True).start()
    print("acquire " + name, flush=True)
    if sys.stdin.readline().strip() != "go":
        raise RuntimeError("Live scheduler disconnected")
    try:
        yield
    finally:
        print("release " + name, flush=True)
