"""Speech for the avatar's mouth bank: six varied lines in the avatar's Kokoro voice, each placed on a
silent track exactly as long as the motion loop, so MuseTalk renders every loop frame once per line.

  <kokoro venv python> bank_speech.py <build dir> <frames> <fps> [voice]
"""
import os, sys

import numpy as np
import soundfile as sf

home = os.path.expanduser(os.environ.get("PRESENTER_FILM_HOME", "~/.local/share/presenter-film"))
import espeakng_loader
espeakng_loader.get_data_path = lambda: os.path.join(home, "espeak-ng-data")   # the bundled path is too long for espeak-ng
from kokoro import KPipeline

LINES = [
    "Hello, I'm Clara. I'll read Claude's replies out loud while you work, so you can keep your eyes on the code and still follow along.",
    "The build finished, but two tests failed in the payments module. I've opened the logs and I'm looking at the first failure now.",
    "Would you like me to commit this change, or should we wait for the review? Either way, nothing is pushed until you say so.",
    "Okay! Fixed it. The bug was a missing await in the loader, which meant the page rendered before the data arrived.",
    "Quick question: should the avatar speak every reply, or only the ones from the session you have open right now?",
    "Done. Everything is green, the branch is up to date, and the pull request is ready for you to look at whenever you like.",
]
SR, LEAD = 24000, 0.3

out, frames, fps = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
voice = sys.argv[4] if len(sys.argv) > 4 else "bf_emma"
pipe = KPipeline(lang_code=voice[0], repo_id="hexgrad/Kokoro-82M")
total = int(round(frames / fps * SR))
said = [np.concatenate([np.asarray(a) for _, _, a in pipe(t, voice=voice)]) for t in LINES]
gap = np.zeros(int(0.25 * SR), np.float32)
for i in range(len(LINES)):
    # each track runs on into the next lines, so every loop frame gets speech in every pass
    track = [np.zeros(int(LEAD * SR), np.float32)]
    k = i
    while sum(len(a) for a in track) < total:
        track += [said[k % len(said)], gap]
        k += 1
    track = np.concatenate(track)[:total]
    sf.write(os.path.join(out, f"pass{i}.wav"), np.clip(track, -1, 1), SR)
    print(f"pass{i}: {total / SR:.2f} s, lines {i}..{(k - 1) % len(said)}")
