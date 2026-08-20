#!/usr/bin/env python3
"""Turn the user's icon image into all Android launcher icon sizes."""

import os
import statistics

from PIL import Image, ImageDraw

SRC = r"D:\软件缓存与素材\chrome\ChatGPT Image 2026年8月20日 20_22_40.png"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "app", "src", "main", "res")
DESIGN = os.path.join(ROOT, "design")
SIZE = 1024


def average(vals, fallback=(255, 255, 255)):
    if not vals:
        return fallback
    return tuple(round(statistics.mean(c[i] for c in vals)) for i in range(3))


def hex_color(rgb):
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def vertical_gradient(top, bottom):
    img = Image.new("RGBA", (SIZE, SIZE))
    d = ImageDraw.Draw(img)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        d.line([(0, y), (SIZE, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))
    return img


def sample_region(px, x0, y0, x1, y1):
    vals = []
    for x in range(x0, x1, 4):
        for y in range(y0, y1, 4):
            r, g, b, a = px[x, y]
            if a > 240:
                vals.append((r, g, b))
    return vals


def save_png(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG")
    print("wrote", path, img.size)


def main():
    im = Image.open(SRC).convert("RGBA")
    w, h = im.size
    bbox = im.getchannel("A").getbbox()
    crop = im.crop(bbox)
    cw, ch = crop.size
    side = max(cw, ch)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(crop, ((side - cw) // 2, (side - ch) // 2), crop)
    master = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    save_png(master, os.path.join(DESIGN, "logo-user-1024.png"))

    px = master.load()
    tl = average(sample_region(px, 0, 0, 320, 320))
    br = average(sample_region(px, 704, 704, SIZE, SIZE))
    print("background colors: top-left", hex_color(tl), "bottom-right", hex_color(br))

    # Adaptive foreground: whole image scaled into the safe zone (about 70%).
    fg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    target = 717
    scaled = master.resize((target, target), Image.LANCZOS)
    fg.paste(scaled, ((SIZE - target) // 2, (SIZE - target) // 2), scaled)
    save_png(fg, os.path.join(RES, "drawable-nodpi", "ic_launcher_foreground.png"))
    save_png(fg, os.path.join(DESIGN, "logo-user-adaptive.png"))

    # Legacy full-bleed icons: gradient background + image at 86% for a little margin.
    full = vertical_gradient(tl, br)
    t2 = 880
    m2 = master.resize((t2, t2), Image.LANCZOS)
    full.alpha_composite(m2, ((SIZE - t2) // 2, (SIZE - t2) // 2))
    save_png(full, os.path.join(DESIGN, "logo-user-full-1024.png"))

    for dpi, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        icon = full.resize((size, size), Image.LANCZOS)
        save_png(icon, os.path.join(RES, f"mipmap-{dpi}", "ic_launcher.png"))
        save_png(icon, os.path.join(RES, f"mipmap-{dpi}", "ic_launcher_round.png"))

    with open(os.path.join(DESIGN, "background-colors.txt"), "w", encoding="utf-8") as f:
        f.write(f"top-left={hex_color(tl)}\nbottom-right={hex_color(br)}\n")


if __name__ == "__main__":
    main()
