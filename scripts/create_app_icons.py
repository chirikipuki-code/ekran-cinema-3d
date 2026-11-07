"""Generate the dependency-free PNG app icons used by the installable mobile app."""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "web" / "icons"


def blend(a: tuple[int, int, int], b: tuple[int, int, int], alpha: float) -> tuple[int, int, int]:
    alpha = max(0.0, min(1.0, alpha))
    return tuple(round(x * (1 - alpha) + y * alpha) for x, y in zip(a, b))


def smooth(edge: float, width: float = 1.5) -> float:
    return max(0.0, min(1.0, 0.5 + edge / width))


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def create(size: int) -> None:
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            nx, ny = (x + 0.5) / size, (y + 0.5) / size
            glow = max(0.0, 1.0 - math.hypot(nx - 0.83, ny - 0.13) / 0.85)
            base = blend((14, 13, 23), (76, 37, 55), glow * 0.7)
            # A clean Cyrillic Э inside the safe area for circular app launchers.
            radius = math.hypot(nx - 0.5, ny - 0.5)
            ring = smooth(0.043 - abs(radius - 0.252), 2 / size)
            ring *= smooth(nx - 0.353, 2 / size)
            bar = smooth(nx - 0.495, 2 / size) * smooth(0.72 - nx, 2 / size) * smooth(0.027 - abs(ny - 0.5), 2 / size)
            ink = max(ring, bar)
            color = blend(base, (255, 153, 126), ink)
            pixels.extend(color)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(pixels), 9)) + chunk(b"IEND", b"")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"icon-{size}.png").write_bytes(data)


if __name__ == "__main__":
    for icon_size in (192, 512):
        create(icon_size)
