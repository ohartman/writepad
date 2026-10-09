"""Generate WritePad PWA icons with Pillow.

Usage:  python tools/make_icons.py

Writes icons/icon-192.png, icons/icon-512.png, icons/icon-maskable-512.png
and icons/favicon-48.png. The design is a blue rounded tile with a white
sheet of paper carrying a few text lines, so it reads at small sizes with
no font dependency.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"

BLUE = (31, 95, 191)
BLUE_DARK = (24, 76, 153)
WHITE = (255, 255, 255)
LINE = (116, 128, 144)
ACCENT = (31, 95, 191)


def draw_icon(size: int, maskable: bool = False) -> Image.Image:
    """Render at 4x then downsample for smooth edges."""
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        # Maskable icons must fill the whole canvas; content sits in the
        # central 80% safe zone.
        d.rectangle([0, 0, s, s], fill=BLUE)
        pad = s * 0.10
    else:
        radius = s * 0.22
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BLUE)
        pad = 0

    # Sheet of paper
    inner = s - 2 * pad
    sheet_w = inner * 0.56
    sheet_h = inner * 0.70
    x0 = pad + (inner - sheet_w) / 2
    y0 = pad + (inner - sheet_h) / 2
    x1, y1 = x0 + sheet_w, y0 + sheet_h
    corner = inner * 0.06

    # Soft shadow
    shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    off = inner * 0.02
    sd.rounded_rectangle([x0 + off, y0 + off * 1.6, x1 + off, y1 + off * 1.6], radius=corner, fill=(0, 0, 0, 70))
    img.alpha_composite(shadow)
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([x0, y0, x1, y1], radius=corner, fill=WHITE)

    # Folded corner
    fold = sheet_w * 0.26
    d.polygon([(x1 - fold, y0), (x1, y0 + fold), (x1 - fold, y0 + fold)], fill=(222, 228, 236))
    d.polygon([(x1 - fold, y0), (x1, y0), (x1, y0 + fold)], fill=BLUE)

    # Text lines
    line_h = sheet_h * 0.055
    gap = sheet_h * 0.115
    left = x0 + sheet_w * 0.14
    top = y0 + sheet_h * 0.30
    widths = [0.72, 0.62, 0.72, 0.46]
    for i, w in enumerate(widths):
        yy = top + i * gap
        color = ACCENT if i == 0 else LINE
        d.rounded_rectangle([left, yy, left + sheet_w * w, yy + line_h], radius=line_h / 2, fill=color)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    draw_icon(192).save(OUT / "icon-192.png", optimize=True)
    draw_icon(512).save(OUT / "icon-512.png", optimize=True)
    draw_icon(512, maskable=True).save(OUT / "icon-maskable-512.png", optimize=True)
    draw_icon(48).save(OUT / "favicon-48.png", optimize=True)
    for p in sorted(OUT.glob("*.png")):
        print(f"wrote {p.relative_to(ROOT)} ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
