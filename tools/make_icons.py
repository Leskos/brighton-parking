"""Generate the app's PNG icons (a white "P" on navy) using only the standard library.

Usage: python tools/make_icons.py
"""

import struct
import zlib
from pathlib import Path

BG = (0x1F, 0x3A, 0x5F)
FG = (0xFF, 0xFF, 0xFF)
OUT = Path(__file__).resolve().parent.parent / "site" / "icons"
SS = 3  # supersampling per axis, for anti-aliased edges


def inside_p(x, y):
    """Is unit-square point (x, y) inside the letter P?"""
    if 0.31 <= x <= 0.44 and 0.22 <= y <= 0.80:            # stem
        return True
    cx, cy = 0.50, 0.405                                    # bowl: half ring right of the stem
    d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    if x >= 0.44 - 1e-9 and 0.075 <= d <= 0.185 and (x >= cx or abs(y - cy) >= 0.075):
        return True
    return False


def render(size):
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter: none
        for px in range(size):
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    hits += inside_p((px + (sx + .5) / SS) / size, (py + (sy + .5) / SS) / size)
            a = hits / (SS * SS)
            row += bytes(round(b * (1 - a) + f * a) for b, f in zip(BG, FG))
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]:
        (OUT / name).write_bytes(png(size, render(size)))
        print("wrote", OUT / name)
