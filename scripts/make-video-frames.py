"""Renders the demo video frames as 1920x1080 PNGs into video-frames/.

Each frame is a finished still. Drop them straight into a timeline, or upload them one
at a time. Nothing here needs the app running.

    python scripts/make-video-frames.py
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
MARGIN = 150
OUT = "video-frames"

VOID = "#08090c"
DEEP = "#0d1117"
PANEL = "#161b22"
LINE = "#2c333d"
PAPER = "#eef2f6"
MUTE = "#8b949e"
SIGNAL = "#58a6ff"
STOP = "#f85149"
CLEAR = "#3fb950"

FONTS = "C:/Windows/Fonts/"
DISPLAY = FONTS + "ARIALNB.TTF"   # Arial Narrow Bold, our condensed display face
BODY = FONTS + "segoeui.ttf"
BODY_B = FONTS + "segoeuib.ttf"
MONO = FONTS + "consola.ttf"
MONO_B = FONTS + "consolab.ttf"

_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def f(path: str, size: int) -> ImageFont.FreeTypeFont:
    key = (path, size)
    if key not in _cache:
        _cache[key] = ImageFont.truetype(path, size)
    return _cache[key]


def frame(bg: str = DEEP) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (W, H), bg)
    return img, ImageDraw.Draw(img)


def runs(d: ImageDraw.ImageDraw, x: int, y: int, segments, font, tracking: int = 0) -> int:
    """Draw coloured segments on one line. Returns the x the line ended at."""
    for text, colour in segments:
        if tracking:
            for ch in text:
                d.text((x, y), ch, font=font, fill=colour)
                x += int(d.textlength(ch, font=font)) + tracking
        else:
            d.text((x, y), text, font=font, fill=colour)
            x += int(d.textlength(text, font=font))
    return x


def wrap(d: ImageDraw.ImageDraw, segments, font, max_w: int):
    """Wrap coloured segments into lines that fit max_w. Keeps colour per word."""
    words = []
    for text, colour in segments:
        for w_ in text.split(" "):
            if w_:
                words.append((w_, colour))

    lines, cur, cur_w = [], [], 0
    space = d.textlength(" ", font=font)
    for word, colour in words:
        ww = d.textlength(word, font=font)
        if cur and cur_w + space + ww > max_w:
            lines.append(cur)
            cur, cur_w = [(word, colour)], ww
        else:
            if cur:
                cur_w += space
            cur.append((word, colour))
            cur_w += ww
    if cur:
        lines.append(cur)
    return lines


def block(d, x, y, segments, font, max_w, leading, tracking=0) -> int:
    """Draw a wrapped, coloured block. Returns the y below it."""
    for line in wrap(d, segments, font, max_w):
        cx = x
        for i, (word, colour) in enumerate(line):
            if i:
                cx += int(d.textlength(" ", font=font))
            cx = runs(d, cx, y, [(word, colour)], font, tracking)
        y += leading
    return y


def eyebrow(d, x, y, text, colour=MUTE, size=22) -> int:
    runs(d, x, y, [(text.upper(), colour)], f(MONO_B, size), tracking=6)
    return y + size + 30


def rounded(d, box, radius, fill=None, outline=None, width=1) -> None:
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


# --------------------------------------------------------------------------- frames

def frame_01():
    img, d = frame(VOID)
    fnt = f(DISPLAY, 170)
    y = 300
    y = block(d, MARGIN, y, [("A key gets committed.", PAPER)], fnt, W - MARGIN * 2, 165)
    block(d, MARGIN, y, [("Nobody kills it.", STOP)], fnt, W - MARGIN * 2, 165)
    return img, "01-problem"


def frame_02():
    img, d = frame(VOID)
    y = 260
    y = block(d, MARGIN, y, [("You could automate it.", PAPER)], f(DISPLAY, 130), W - MARGIN * 2, 130)
    y += 60
    y = block(
        d, MARGIN, y,
        [("But the same agent that investigates could revoke a key production depends on.", PAPER)],
        f(BODY, 58), W - MARGIN * 2, 82,
    )
    y += 34
    block(d, MARGIN, y, [("So nobody does.", STOP)], f(DISPLAY, 96), W - MARGIN * 2, 100)
    return img, "02-the-trap"


def wordmark(d, x, y, size):
    fnt = f(DISPLAY, size)
    x = runs(d, x, y, [("Cont", PAPER)], fnt)
    x = runs(d, x, y, [("AI", SIGNAL)], fnt)
    runs(d, x, y, [("n", PAPER)], fnt)


def frame_03():
    img, d = frame(DEEP)
    wordmark(d, MARGIN, 190, 150)
    y = 400
    y = block(d, MARGIN, y, [("Earns information.", PAPER)], f(DISPLAY, 96), W - MARGIN * 2, 100)
    y = block(d, MARGIN, y, [("Never permissions.", STOP)], f(DISPLAY, 96), W - MARGIN * 2, 100)

    labels = ["Scan", "Verify", "Blast radius", "Plan", "Approval", "Revoke"]
    states = ["AUTO", "AUTO", "AUTO", "AUTO", "STOPS HERE", "AUTO"]
    top, box_h, gap = 760, 150, 16
    total = W - MARGIN * 2
    box_w = (total - gap * 5) // 6

    for i, (lab, st) in enumerate(zip(labels, states)):
        x = MARGIN + i * (box_w + gap)
        halt = st == "STOPS HERE"
        rounded(d, (x, top, x + box_w, top + box_h), 12,
                outline=STOP if halt else LINE, width=3 if halt else 2)
        sf = f(MONO_B, 19)
        sw = sum(int(d.textlength(c, font=sf)) + 4 for c in st) - 4
        runs(d, x + (box_w - sw) // 2, top + 34, [(st, STOP if halt else MUTE)], sf, tracking=4)
        lf = f(BODY_B if halt else BODY, 34)
        lw = int(d.textlength(lab, font=lf))
        d.text((x + (box_w - lw) // 2, top + 80), lab, font=lf, fill=STOP if halt else PAPER)

    return img, "03-the-split"


def frame_04():
    img, d = frame(DEEP)
    y = eyebrow(d, MARGIN, 150, "gitleaks  .  full git history  .  3 findings")

    rows = [
        ("ghp_****ZTHG", "deploy/staging.yml", "LIVE", STOP),
        ("ghp_****1KOc", ".github/workflows/ci.yml", "DEAD", CLEAR),
        ("ghp_****r4vz", "test/helpers.js", "DEAD", CLEAR),
    ]
    row_h, gap = 132, 22
    y = 300
    for token, path, tag, colour in rows:
        rounded(d, (MARGIN, y, W - MARGIN, y + row_h), 10, fill=PANEL)
        d.rectangle((MARGIN, y, MARGIN + 8, y + row_h), fill=colour)
        d.text((MARGIN + 50, y + 44), token, font=f(MONO_B, 46), fill=PAPER)
        d.text((MARGIN + 560, y + 50), path, font=f(MONO, 38), fill=MUTE)
        tf = f(BODY_B, 42)
        tw = int(d.textlength(tag, font=tf))
        d.text((W - MARGIN - 50 - tw, y + 46), tag, font=tf, fill=colour)
        y += row_h + gap

    y += 40
    block(d, MARGIN, y,
          [("The live one was deleted two commits later. It is nowhere in the current code.", MUTE)],
          f(BODY, 42), W - MARGIN * 2, 60)
    return img, "04-found-and-tested"


def frame_05():
    img, d = frame(DEEP)
    y = eyebrow(d, MARGIN, 160, "blast radius", STOP)
    y = 300
    y = block(
        d, MARGIN, y,
        [("Anyone holding this key can ", PAPER),
         ("administer the enterprise account", STOP),
         (", administer organisations including who belongs to them, and ", PAPER),
         ("permanently delete repositories.", STOP)],
        f(BODY, 66), W - MARGIN * 2, 94,
    )
    y += 50
    block(d, MARGIN, y, [("Plus 18 further permissions.", MUTE)], f(BODY, 44), W - MARGIN * 2, 60)
    return img, "05-blast-radius"


def frame_06():
    img, d = frame(DEEP)
    box = (MARGIN - 30, 150, W - MARGIN + 30, H - 150)
    rounded(d, box, 22, fill="#1a1216", outline=STOP, width=6)

    x = MARGIN + 30
    d.text((x, 215), "HUMAN APPROVAL REQUIRED", font=f(DISPLAY, 104), fill=STOP)
    d.text((x, 350), "This action may affect production.", font=f(BODY, 46), fill=PAPER)

    y = 470
    for label, value in (("credential", "ghp_****ZTHG"), ("proposed", "revoke_and_rotate")):
        d.text((x, y), label, font=f(MONO, 36), fill=MUTE)
        d.text((x + 330, y - 2), value, font=f(MONO_B, 38), fill=PAPER)
        y += 62

    y += 40
    d.text((x, y), "Revoking is permanent. GitHub cannot restore it.",
           font=f(BODY_B, 44), fill=STOP)

    y += 110
    bw, bh = 470, 96
    rounded(d, (x, y, x + bw, y + bh), 12, fill=STOP)
    lf = f(BODY_B, 40)
    lw = int(d.textlength("Approve revocation", font=lf))
    d.text((x + (bw - lw) // 2, y + 26), "Approve revocation", font=lf, fill="#ffffff")

    x2 = x + bw + 26
    rounded(d, (x2, y, x2 + 220, y + bh), 12, outline=LINE, width=3)
    dw = int(d.textlength("Deny", font=lf))
    d.text((x2 + (220 - dw) // 2, y + 26), "Deny", font=lf, fill=PAPER)

    return img, "06-the-freeze"


def frame_07():
    img, d = frame(DEEP)
    y = eyebrow(d, MARGIN, 170, "after approval", CLEAR)

    y = 300
    rounded(d, (MARGIN, y, W - MARGIN, y + 250), 12, fill="#0f1a12")
    d.rectangle((MARGIN, y, MARGIN + 8, y + 250), fill=CLEAR)
    d.text((MARGIN + 60, y + 60), "Confirmed dead.", font=f(DISPLAY, 88), fill=CLEAR)
    runs(d, MARGIN + 60, y + 165,
         [("Provider returned 202, then re-verification observed ", PAPER),
          ("LIVE", STOP), (" to ", PAPER), ("DEAD", CLEAR), (".", PAPER)],
         f(BODY, 40))

    y += 330
    block(
        d, MARGIN, y,
        [("GitHub returns 202 for any token, including one that never existed. "
          "So the agent went back and checked.", MUTE)],
        f(BODY, 44), W - MARGIN * 2, 64,
    )
    return img, "07-proof"


def frame_08():
    img, d = frame(VOID)
    wordmark(d, MARGIN, 260, 170)
    y = 520
    y = block(d, MARGIN, y, [("Earns information,", PAPER)], f(DISPLAY, 106), W - MARGIN * 2, 112)
    y = block(d, MARGIN, y, [("not permissions.", STOP)], f(DISPLAY, 106), W - MARGIN * 2, 112)
    y += 70
    runs(d, MARGIN, y, [("github.com/dankbelfort1/contain", SIGNAL)], f(MONO_B, 38), tracking=2)
    return img, "08-end-card"


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    builders = [frame_01, frame_02, frame_03, frame_04,
                frame_05, frame_06, frame_07, frame_08]
    for build in builders:
        img, name = build()
        path = os.path.join(OUT, f"{name}.png")
        img.save(path, "PNG")
        print(f"  {path}")
    print(f"\n{len(builders)} frames at {W}x{H} in {OUT}/")


if __name__ == "__main__":
    main()
