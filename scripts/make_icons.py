#!/usr/bin/env python3
"""Generate the extension's PNG icons with the standard library only.

Draws a rounded-square "clay" tile with a partial progress ring, matching the
floating meter's look. Produces icons/icon16.png, icon48.png, icon128.png.
"""
import os
import struct
import zlib
import math

CLAY = (201, 100, 66)       # #c96442 background
RING_BG = (255, 255, 255, 60)
RING_FG = (255, 255, 255, 235)
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")


def blend(bg, fg, a):
    return tuple(round(bg[i] * (1 - a) + fg[i] * a) for i in range(3))


def rounded_alpha(x, y, w, h, radius):
    """Coverage (0..1) for a rounded rectangle at pixel center (x,y)."""
    cx = min(max(x, radius), w - radius)
    cy = min(max(y, radius), h - radius)
    dist = math.hypot(x - cx, y - cy)
    return max(0.0, min(1.0, radius - dist + 0.5))


def make_icon(size, fraction=0.68):
    radius = size * 0.24
    cx = cy = size / 2.0
    ring_r = size * 0.30
    ring_w = max(1.0, size * 0.10)
    start = -math.pi / 2  # 12 o'clock
    end = start + 2 * math.pi * fraction

    px = bytearray()
    for y in range(size):
        px.append(0)  # PNG filter byte (none)
        for x in range(size):
            fx, fy = x + 0.5, y + 0.5
            cov = rounded_alpha(fx, fy, size, size, radius)
            if cov <= 0:
                px.extend((0, 0, 0, 0))
                continue
            color = list(CLAY)

            d = math.hypot(fx - cx, fy - cy)
            ring_edge = abs(d - ring_r)
            if ring_edge <= ring_w / 2 + 0.5:
                ang = math.atan2(fy - cy, fx - cx)
                a = ang
                while a < start:
                    a += 2 * math.pi
                on_arc = a <= end
                aa = max(0.0, min(1.0, ring_w / 2 + 0.5 - ring_edge))
                if on_arc:
                    color = blend(color, RING_FG[:3], RING_FG[3] / 255 * aa)
                else:
                    color = blend(color, RING_BG[:3], RING_BG[3] / 255 * aa)

            alpha = round(255 * cov)
            px.extend((color[0], color[1], color[2], alpha))
    return bytes(px)


def write_png(path, size, raw):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in (16, 48, 128):
        write_png(os.path.join(OUT_DIR, f"icon{s}.png"), s, make_icon(s))
        print(f"wrote icon{s}.png")


if __name__ == "__main__":
    main()
