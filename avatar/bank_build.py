"""Turn MuseTalk's mouth passes over the avatar's motion loop into the bank the console plays live.

  <musetalk venv python> bank_build.py <build dir> <avatar dir>

Reads <build dir>/loop.mp4 (head motion and blinks, mouth closed) and out/v15/pass*.mp4 (the same loop,
lip-synced to different speech). Writes <avatar dir>/base/NNNN.jpg (the loop), pass<i>.jpg (a sprite
sheet of each pass's mouth region, one cell per loop frame) and manifest.json: per frame where the
cell goes and how open each pass's mouth is (0 closed .. 1 wide). The page plays the loop and, while
audio plays, draws the pass whose mouth openness is closest to the sound's loudness right then.
"""
import glob, json, os, sys

import cv2
import numpy as np
import face_alignment

build, avatar = sys.argv[1], sys.argv[2]
COLS, PAD, THRESH = 16, 10, 28


def frames(path):
    cap, out = cv2.VideoCapture(path), []
    while True:
        ok, f = cap.read()
        if not ok:
            return out
        out.append(f)


base = frames(os.path.join(build, "loop.mp4"))
fps = cv2.VideoCapture(os.path.join(build, "loop.mp4")).get(cv2.CAP_PROP_FPS)
passes = [frames(p)[: len(base)] for p in sorted(glob.glob(os.path.join(build, "out", "v15", "pass*.mp4")))]
passes = [p for p in passes if len(p) == len(base)]
if not passes:
    raise SystemExit("no complete pass*.mp4 in out/v15")
n, (H, W) = len(base), base[0].shape[:2]
print(f"{n} loop frames {W}x{H} at {fps:g} fps, {len(passes)} passes")

# Mouth openness: inner-lip gap over face height, from 68-point landmarks.
fa = face_alignment.FaceAlignment(face_alignment.LandmarksType.TWO_D, flip_input=False, device="cpu")
boxes = []


def openness(img, i):
    lm = fa.get_landmarks_from_image(img[:, :, ::-1], detected_faces=[boxes[i]])
    if not lm:
        return 0.0
    lm = lm[0]
    gap = np.mean([lm[66][1] - lm[62][1], lm[67][1] - lm[61][1], lm[65][1] - lm[63][1]])
    return float(max(0.0, gap) / max(1.0, lm[8][1] - lm[27][1]))


for i, f in enumerate(base):
    _, _, b = fa.get_landmarks_from_image(f[:, :, ::-1], return_bboxes=True)
    boxes.append(b[0][:4] if b else boxes[-1])
base_open = [openness(f, i) for i, f in enumerate(base)]
pass_open = [[openness(p[i], i) for i in range(n)] for p in passes]
scale = float(np.percentile(np.array(pass_open), 95)) or 1.0
print(f"openness: loop median {np.median(base_open):.3f}, passes p95 {scale:.3f}")

# Where the passes differ from the loop: one cell size for all frames, placed per frame.
regions = []
for i in range(n):
    x1, y1, x2, y2 = [int(v) for v in boxes[i]]
    mx, my = int((x2 - x1) * 0.25), int((y2 - y1) * 0.25)
    X1, Y1, X2, Y2 = max(0, x1 - mx), max(0, y1 - my), min(W, x2 + mx), min(H, y2 + my)
    d = np.zeros((Y2 - Y1, X2 - X1), bool)
    for p in passes:
        diff = cv2.absdiff(p[i][Y1:Y2, X1:X2], base[i][Y1:Y2, X1:X2]).max(axis=2)
        d |= cv2.morphologyEx((diff > THRESH).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
    ys, xs = np.nonzero(d)
    regions.append((X1 + xs.min(), Y1 + ys.min(), X1 + xs.max(), Y1 + ys.max()) if len(xs) else None)
found = [r for r in regions if r]
cw = int(min(W, np.percentile([r[2] - r[0] for r in found], 98) + 2 * PAD))
ch = int(min(H, np.percentile([r[3] - r[1] for r in found], 98) + 2 * PAD))
pos, last = [], ((W - cw) // 2, (H - ch) // 2)
for r in regions:
    if r:
        cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
        last = (int(min(max(cx - cw / 2, 0), W - cw)), int(min(max(cy - ch / 2, 0), H - ch)))
    pos.append(last)
pos = np.array(pos, float)
k = np.ones(5) / 5      # the cell follows the head smoothly
pos = np.stack([np.convolve(np.pad(pos[:, j], 2, mode="edge"), k, mode="valid") for j in (0, 1)], 1).round().astype(int)
print(f"mouth cell {cw}x{ch}")

os.makedirs(os.path.join(avatar, "base"), exist_ok=True)
for i, f in enumerate(base):
    cv2.imwrite(os.path.join(avatar, "base", f"{i:04d}.jpg"), f, [cv2.IMWRITE_JPEG_QUALITY, 90])
rows = (n + COLS - 1) // COLS
for k_, p in enumerate(passes):
    sheet = np.zeros((rows * ch, COLS * cw, 3), np.uint8)
    for i in range(n):
        x, y = pos[i]
        r, c = divmod(i, COLS)
        sheet[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw] = p[i][y:y + ch, x:x + cw]
    cv2.imwrite(os.path.join(avatar, f"pass{k_}.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 92])
json.dump({
    "name": os.environ.get("AVATAR_NAME", "Clara"), "voice": os.environ.get("AVATAR_VOICE", "bf_emma"),
    "label": os.environ.get("AVATAR_LABEL", "Clara is fictional: her face and voice are AI-generated, on this Mac."),
    "fps": fps, "frames": n, "width": W, "height": H, "cell": [cw, ch], "cols": COLS, "passes": len(passes),
    "pos": pos.tolist(),
    "open": [[round(min(1.0, v / scale), 3) for v in po] for po in pass_open],
    "base_open": [round(min(1.0, v / scale), 3) for v in base_open],
}, open(os.path.join(avatar, "manifest.json"), "w"))
print("bank written to", avatar)
