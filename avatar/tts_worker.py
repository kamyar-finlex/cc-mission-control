"""Local text-to-speech for the console's avatar: Kokoro-82M kept loaded, one JSON request per line.

  stdin:  {"id": 1, "text": "...", "voice": "bf_emma", "out": "/path/to/file.wav"}
  stdout: {"id": 1, "ok": true, "ms": 840} or {"id": 1, "ok": false, "error": "..."}

Started by server.mjs with the Kokoro venv's python (CCMC_KOKORO_PYTHON). Nothing leaves the machine:
the model is read from the local Hugging Face cache.
"""
import json, os, sys, time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
home = os.path.expanduser(os.environ.get("PRESENTER_FILM_HOME", "~/.local/share/presenter-film"))
if os.path.isdir(os.path.join(home, "espeak-ng-data")):
    import espeakng_loader
    espeakng_loader.get_data_path = lambda: os.path.join(home, "espeak-ng-data")   # the bundled path is too long for espeak-ng
import numpy as np
import soundfile as sf
from kokoro import KPipeline

pipes = {}
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    t = time.time()
    try:
        voice = req.get("voice") or "bf_emma"
        if voice[0] not in pipes:      # loaded once per language, then kept
            pipes[voice[0]] = KPipeline(lang_code=voice[0], repo_id="hexgrad/Kokoro-82M")
        pipe = pipes[voice[0]]
        audio = np.concatenate([np.asarray(a) for _, _, a in pipe(req["text"], voice=voice)])
        tmp = req["out"] + ".tmp.wav"
        sf.write(tmp, np.clip(audio, -1, 1), 24000)
        os.replace(tmp, req["out"])
        print(json.dumps({"id": req.get("id"), "ok": True, "ms": int((time.time() - t) * 1000)}), flush=True)
    except Exception as e:  # one bad sentence must not stop the voice
        print(json.dumps({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"}), flush=True)
