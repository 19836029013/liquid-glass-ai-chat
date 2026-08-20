#!/usr/bin/env python3
"""Generate the Liquid Glass AI Chat Android launcher icons (Pillow only)."""

import math
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "app", "src", "main", "res")
DESIGN = os.path.join(ROOT, "design")
SIZE = 1024


def vgrad(size, top, bottom):
    img = Image.new("RGBA", size)
    d = ImageDraw.Draw(img)
    for y in range(size[1]):
        t = y / (size[1] - 1)
        d.line([(0, y), (size[0], y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))
    return img


def rounded_mask(size, box, radius):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    return mask


def star_points(cx, cy, r_out, r_in, n=4, rot=45):
    pts = []
    for i in range(n * 2):
        ang = math.radians(rot + i * 360 / (n * 2))
        r = r_out if i % 2 == 0 else r_in
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts


def draw_logo(box, radius, shadow_off=20):
    """Draw the liquid-glass chat logo on a transparent canvas."""
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    x0, y0, x1, y1 = box

    # soft drop shadow
    shadow_box = (x0, y0 + shadow_off, x1, y1 + shadow_off)
    shadow = rounded_mask((SIZE, SIZE), shadow_box, radius)
    shadow = shadow.filter(ImageFilter.GaussianBlur(48))
    img.paste((60, 110, 95, 110), (0, 0), shadow)

    # glass body with vertical white -> mint gradient
    body = vgrad((SIZE, SIZE), (255, 255, 255, 242), (198, 235, 222, 214))
    mask = rounded_mask((SIZE, SIZE), box, radius)
    body.putalpha(mask)
    img.alpha_composite(body)

    # glossy top highlight
    hl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hl_d = ImageDraw.Draw(hl)
    hl_d.rounded_rectangle(
        (x0 + 32, y0 + 30, x0 + (x1 - x0) * 0.52, y0 + (y1 - y0) * 0.30),
        radius=int((y1 - y0) * 0.14),
        fill=(255, 255, 255, 120),
    )
    hl = hl.filter(ImageFilter.GaussianBlur(26))
    img.alpha_composite(hl)

    # crisp glass border
    ImageDraw.Draw(img).rounded_rectangle(box, radius=radius, outline=(255, 255, 255, 215), width=7)

    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2
    dot_r = (y1 - y0) * 0.065

    # three chat dots (teal) with a subtle shadow
    for dx in (-(x1 - x0) * 0.085, 0, (x1 - x0) * 0.085):
        px, py = cx + dx, cy + (y1 - y0) * 0.015
        sd = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        ImageDraw.Draw(sd).ellipse(
            (px - dot_r - 3, py - dot_r + 6, px + dot_r - 3, py + dot_r + 6), fill=(60, 110, 95, 80)
        )
        sd = sd.filter(ImageFilter.GaussianBlur(6))
        img.alpha_composite(sd)
        ImageDraw.Draw(img).ellipse(
            (px - dot_r, py - dot_r, px + dot_r, py + dot_r), fill=(79, 191, 166, 255)
        )

    # teal sparkle top-right
    sx = x1 - (x1 - x0) * 0.165
    sy = y0 + (y1 - y0) * 0.175
    sp = star_points(sx, sy, (y1 - y0) * 0.088, (y1 - y0) * 0.034)
    ImageDraw.Draw(img).polygon(sp, fill=(63, 169, 143, 255))

    return img


def diagonal_bg():
    bg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(bg)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        d.line([(0, y), (SIZE, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip((228, 244, 238, 255), (142, 203, 187, 255))))
    return bg


def save_png(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG")
    print("wrote", path, img.size)


def main():
    os.makedirs(DESIGN, exist_ok=True)

    # Master assets
    foreground = draw_logo((208, 208, 816, 816), 238, shadow_off=18)
    full = diagonal_bg()
    full.alpha_composite(draw_logo((140, 140, 884, 884), 252, shadow_off=22))
    save_png(foreground, os.path.join(DESIGN, "logo-foreground-1024.png"))
    save_png(full, os.path.join(DESIGN, "logo-full-1024.png"))

    # Adaptive foreground (density independent, large enough for all screens)
    save_png(foreground, os.path.join(RES, "drawable-nodpi", "ic_launcher_foreground.png"))

    # Legacy launcher PNGs
    for dpi, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        icon = full.resize((size, size), Image.LANCZOS)
        save_png(icon, os.path.join(RES, f"mipmap-{dpi}", "ic_launcher.png"))
        save_png(icon, os.path.join(RES, f"mipmap-{dpi}", "ic_launcher_round.png"))


if __name__ == "__main__":
    main()
