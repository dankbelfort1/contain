"""Renders the title cards as PNGs into video-frames/.

These are the frames that carry the argument: the problem, the split, and the close.
The steps in between are real screenshots, captured by scripts/capture-ui-screens.mjs.

Output is 2880x1800, matching that capture exactly, so title cards and real screens sit
at one size in a prototype rather than letterboxing differently step to step.

    python scripts/make-video-frames.py
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

# Laid out against a 1920x1200 grid, drawn at 1.5x. Designing at the output size means
# every coordinate is an awkward number; designing small and scaling keeps them round.
BASE_W, BASE_H = 1920, 1200
SCALE = 1.5
W, H = int(BASE_W * SCALE), int(BASE_H * SCALE)   # 2880x1800
MARGIN = int(150 * SCALE)
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


def px(v: float) -> int:
    """Scale a design-grid value to output pixels."""
    return int(round(v * SCALE))


def f(path: str, size: int) -> ImageFont.FreeTypeFont:
    """Load a font at a design-grid size, scaled to output."""
    key = (path, px(size))
    if key not in _cache:
        _cache[key] = ImageFont.truetype(path, px(size))
    return _cache[key]


def frame(bg: str = DEEP) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (W, H), bg)
    return img, ImageDraw.Draw(img)


def runs(d, x, y, segments, font, tracking: int = 0) -> int:
    """Draw coloured segments on one line. Returns the x the line ended at."""
    for text, colour in segments:
        if tracking:
            for ch in text:
                d.text((x, y), ch, font=font, fill=colour)
                x += int(d.textlength(ch, font=font)) + px(tracking)
        else:
            d.text((x, y), text, font=font, fill=colour)
            x += int(d.textlength(text, font=font))
    return x


def wrap(d, segments, font, max_w: int):
    """Wrap coloured segments into lines that fit max_w, keeping colour per word."""
    words = [(w, c) for text, c in segments for w in text.split(" ") if w]

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


def block(d, x, y, segments, font, max_w, leading) -> int:
    """Draw a wrapped, coloured block. Returns the y below it."""
    for line in wrap(d, segments, font, max_w):
        cx = x
        for i, (word, colour) in enumerate(line):
            if i:
                cx += int(d.textlength(" ", font=font))
            cx = runs(d, cx, y, [(word, colour)], font)
        y += px(leading)
    return y


def eyebrow(d, x, y, text, colour=MUTE, size=22) -> None:
    runs(d, x, y, [(text.upper(), colour)], f(MONO_B, size), tracking=6)


def rounded(d, box, radius, fill=None, outline=None, width=1) -> None:
    d.rounded_rectangle(box, radius=px(radius), fill=fill, outline=outline,
                        width=px(width))


def content_width() -> int:
    return W - MARGIN * 2


# --------------------------------------------------------------------------- frames

def frame_01():
    """Opens on the problem, with nothing else on screen to look at."""
    img, d = frame(VOID)
    fnt = f(DISPLAY, 170)
    y = block(d, MARGIN, px(390), [("A key gets committed.", PAPER)], fnt, content_width(), 165)
    block(d, MARGIN, y, [("Nobody kills it.", STOP)], fnt, content_width(), 165)
    return img, "01-problem"


def frame_02():
    """The reason nobody automates it, which is the gap the project sits in."""
    img, d = frame(VOID)
    y = block(d, MARGIN, px(300), [("You could automate it.", PAPER)],
              f(DISPLAY, 130), content_width(), 140)
    y += px(50)
    y = block(
        d, MARGIN, y,
        [("But the same agent that investigates could revoke a key production depends on.", PAPER)],
        f(BODY, 58), content_width(), 84,
    )
    y += px(50)
    block(d, MARGIN, y, [("So nobody does.", STOP)], f(DISPLAY, 96), content_width(), 100)
    return img, "02-the-trap"


def wordmark(d, x, y, size) -> None:
    fnt = f(DISPLAY, size)
    x = runs(d, x, y, [("Cont", PAPER)], fnt)
    x = runs(d, x, y, [("AI", SIGNAL)], fnt)
    runs(d, x, y, [("n", PAPER)], fnt)


def frame_03():
    """The answer, with the loop laid out so the stop is visible before it happens."""
    img, d = frame(DEEP)
    wordmark(d, MARGIN, px(210), 150)

    y = block(d, MARGIN, px(440), [("Earns information.", PAPER)],
              f(DISPLAY, 96), content_width(), 104)
    block(d, MARGIN, y, [("Never permissions.", STOP)], f(DISPLAY, 96), content_width(), 104)

    labels = ["Scan", "Verify", "Blast radius", "Plan", "Approval", "Revoke"]
    states = ["AUTO", "AUTO", "AUTO", "AUTO", "STOPS HERE", "AUTO"]
    top, box_h, gap = px(860), px(160), px(16)
    box_w = (content_width() - gap * 5) // 6

    for i, (label, state) in enumerate(zip(labels, states)):
        x = MARGIN + i * (box_w + gap)
        halt = state == "STOPS HERE"
        rounded(d, (x, top, x + box_w, top + box_h), 12,
                outline=STOP if halt else LINE, width=2 if halt else 1)

        sf = f(MONO_B, 19)
        sw = sum(int(d.textlength(c, font=sf)) + px(4) for c in state) - px(4)
        runs(d, x + (box_w - sw) // 2, top + px(36), [(state, STOP if halt else MUTE)],
             sf, tracking=4)

        lf = f(BODY_B if halt else BODY, 34)
        lw = int(d.textlength(label, font=lf))
        d.text((x + (box_w - lw) // 2, top + px(86)), label, font=lf,
               fill=STOP if halt else PAPER)

    return img, "03-the-split"


def frame_04():
    """Closes on the thesis, the repository, and the stack it was built on."""
    img, d = frame(VOID)
    wordmark(d, MARGIN, px(300), 170)
    y = block(d, MARGIN, px(580), [("Earns information,", PAPER)],
              f(DISPLAY, 106), content_width(), 116)
    y = block(d, MARGIN, y, [("not permissions.", STOP)], f(DISPLAY, 106), content_width(), 116)

    y += px(64)
    runs(d, MARGIN, y, [("github.com/dankbelfort1/contain", SIGNAL)], f(MONO_B, 38), tracking=2)

    # The sign-off. Credits the harness and the reviewer, both of whom are reading.
    y += px(72)
    runs(d, MARGIN, y,
         [("Built on ", MUTE), ("TrueForge", PAPER),
          ("   .   ", MUTE), ("Reviewed by ", MUTE), ("Qodo", PAPER)],
         f(BODY, 40))
    return img, "04-end-card"


def frame_05():
    """Architecture. The mechanism the whole project rests on, in one screen."""
    img, d = frame(DEEP)
    eyebrow(d, MARGIN, px(140), "architecture")
    y = block(d, MARGIN, px(210), [("The gate is in the manifest,", PAPER)],
              f(DISPLAY, 82), content_width(), 90)
    block(d, MARGIN, y, [("not in the code.", STOP)], f(DISPLAY, 82), content_width(), 90)

    tools = [
        ("scan_repository", "read-only", MUTE),
        ("verify_credential", "read-only", MUTE),
        ("build_remediation_plan", "read-only", MUTE),
        ("read_audit_trail", "read-only", MUTE),
        ("revoke_credential", "DESTRUCTIVE", STOP),
    ]
    top, row_h = px(500), px(84)
    for i, (name, tag, colour) in enumerate(tools):
        ry = top + i * row_h
        destructive = colour is STOP
        if destructive:
            rounded(d, (MARGIN - px(20), ry - px(14),
                        MARGIN + px(900), ry + px(60)), 8, outline=STOP, width=2)
        d.text((MARGIN, ry), name, font=f(MONO_B, 40), fill=PAPER if destructive else MUTE)
        d.text((MARGIN + px(620), ry + px(4)), tag,
               font=f(BODY_B if destructive else BODY, 34), fill=colour)

    y = top + len(tools) * row_h + px(70)
    d.text((MARGIN, y), 'require_approval_for_tools: ["@destructive"]',
           font=f(MONO_B, 38), fill=SIGNAL)
    block(d, MARGIN, y + px(70),
          [("TrueForge resolves that selector from the annotations above. "
            "There is no approval branch in our code to delete.", MUTE)],
          f(BODY, 36), content_width(), 52)
    return img, "05-architecture"


def frame_06():
    """The stack, with what each piece is actually for."""
    img, d = frame(DEEP)
    eyebrow(d, MARGIN, px(140), "tech stack")
    block(d, MARGIN, px(210), [("Every piece doing one job.", PAPER)],
          f(DISPLAY, 82), content_width(), 90)

    stack = [
        ("TrueForge", "agent harness, tool approvals"),
        ("MCP", "how the tools are published"),
        ("Gemini 2.5 Flash", "the model, on the free tier"),
        ("gitleaks", "detection, wrapped not rewritten"),
        ("Node sandbox", "isolated execution, egress allowlist"),
        ("TypeScript + React", "the loop and the interface"),
        ("Qodo", "review on every pull request"),
        ("Playwright + vitest", "123 tests"),
    ]
    top, row_h = px(420), px(76)
    for i, (name, role) in enumerate(stack):
        ry = top + i * row_h
        d.text((MARGIN, ry), name, font=f(BODY_B, 40), fill=PAPER)
        d.text((MARGIN + px(560), ry + px(3)), role, font=f(BODY, 34), fill=MUTE)
    return img, "06-stack"


def frame_07():
    """What broke. The most honest thing in the deck, and the most interesting."""
    img, d = frame(DEEP)
    eyebrow(d, MARGIN, px(140), "what we got wrong")
    block(d, MARGIN, px(210), [("62 findings from Qodo.", PAPER)],
          f(DISPLAY, 82), content_width(), 90)

    lessons = [
        ("The scanner reported clean when it crashed.",
         "Any unreadable report became an empty finding list. For a security tool that is "
         "the worst failure: it looks exactly like good news."),
        ("The sandbox could be walked around.",
         "Connecting to a literal IP skipped the DNS check entirely. Our network-restricted "
         "claim was false until it was fixed."),
        ("One of my fixes was worse than the bug.",
         "Making an approval optional let any local caller revoke with no human at all. "
         "Qodo caught that too."),
    ]
    y = px(400)
    for title, detail in lessons:
        d.text((MARGIN, y), title, font=f(BODY_B, 42), fill=STOP)
        y = block(d, MARGIN, y + px(62), [(detail, MUTE)], f(BODY, 34),
                  content_width() - px(120), 48)
        y += px(46)
    return img, "07-what-broke"


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for build in (frame_01, frame_02, frame_03, frame_04,
                  frame_05, frame_06, frame_07):
        img, name = build()
        path = os.path.join(OUT, f"{name}.png")
        img.save(path, "PNG")
        print(f"  {path}")
    print(f"\n4 title cards at {W}x{H} in {OUT}/")
    print("The steps between them are real screenshots: npm run screens")


if __name__ == "__main__":
    main()
