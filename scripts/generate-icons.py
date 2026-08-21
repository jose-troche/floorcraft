#!/usr/bin/env python3
"""
Generates Floorcraft's app icons into apps/web/src/client/public/.

The icon is a miniature floor plan: an outer wall rectangle divided into three
rooms. Geometry is defined once, below, and both the SVG and the PNG fallbacks
are emitted from it — edit WALLS here and re-run rather than hand-editing an
output file, or the formats drift apart.

    python3 scripts/generate-icons.py

Pure stdlib (zlib is all a PNG needs), so it runs anywhere Node does.
"""

import os
import struct
import zlib

# --- geometry, in a 64x64 viewBox -------------------------------------------

VIEW = 64
CORNER_RADIUS = 12
BG_HEX = "#0072B2"  # --accent from style.css
BG_RGBA = (0x00, 0x72, 0xB2, 255)
WALL_RGBA = (255, 255, 255, 255)

# (x, y, w, h) filled rectangles. Filled rather than stroked so the SVG and the
# rasterizer describe the exact same shapes with no stroke-alignment mismatch.
WALLS = [
    (10, 10, 44, 6),   # top exterior wall
    (10, 48, 44, 6),   # bottom exterior wall
    (10, 10, 6, 44),   # left exterior wall
    (48, 10, 6, 44),   # right exterior wall
    (29, 10, 6, 44),   # interior wall, full height
    (35, 29, 19, 6),   # interior wall, splitting the right side
]

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "apps", "web", "src", "client", "public")


# --- SVG ---------------------------------------------------------------------

def build_svg() -> str:
    rects = "\n".join(
        f'    <rect x="{x}" y="{y}" width="{w}" height="{h}"/>' for x, y, w, h in WALLS
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VIEW} {VIEW}" width="{VIEW}" height="{VIEW}">\n'
        f'  <title>Floorcraft</title>\n'
        f'  <rect width="{VIEW}" height="{VIEW}" rx="{CORNER_RADIUS}" fill="{BG_HEX}"/>\n'
        f'  <g fill="#fff">\n{rects}\n  </g>\n'
        f'</svg>\n'
    )


# --- PNG ---------------------------------------------------------------------

def inside_rounded_square(x: float, y: float) -> bool:
    if not (0 <= x <= VIEW and 0 <= y <= VIEW):
        return False
    # Clamp into the straight-edged core; whatever distance remains is the corner arc.
    cx = min(max(x, CORNER_RADIUS), VIEW - CORNER_RADIUS)
    cy = min(max(y, CORNER_RADIUS), VIEW - CORNER_RADIUS)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= CORNER_RADIUS * CORNER_RADIUS


def inside_wall(x: float, y: float) -> bool:
    return any(rx <= x < rx + rw and ry <= y < ry + rh for rx, ry, rw, rh in WALLS)


def sample(x: float, y: float):
    if not inside_rounded_square(x, y):
        return (0, 0, 0, 0)
    return WALL_RGBA if inside_wall(x, y) else BG_RGBA


def rasterize(size: int, supersample: int = 4) -> bytes:
    """Renders to raw RGBA rows, box-filtering `supersample`^2 samples per pixel for AA."""
    scale = VIEW / size
    step = scale / supersample
    offset = step / 2
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(supersample):
                y = py * scale + sy * step + offset
                for sx in range(supersample):
                    x = px * scale + sx * step + offset
                    sr, sg, sb, sa = sample(x, y)
                    # Weight color by coverage so transparent samples don't darken edges.
                    r += sr * sa
                    g += sg * sa
                    b += sb * sa
                    a += sa
            if a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                n = supersample * supersample
                row += bytes((round(r / a), round(g / a), round(b / a), round(a / n)))
        rows.append(bytes(row))
    return b"".join(b"\x00" + r for r in rows)  # filter byte 0 per scanline


def write_png(path: str, size: int) -> None:
    raw = rasterize(size)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def main() -> None:
    out = os.path.normpath(OUT_DIR)
    os.makedirs(out, exist_ok=True)

    svg_path = os.path.join(out, "favicon.svg")
    with open(svg_path, "w") as f:
        f.write(build_svg())
    print(f"wrote {svg_path}")

    for name, size in (("favicon-32.png", 32), ("apple-touch-icon.png", 180)):
        path = os.path.join(out, name)
        write_png(path, size)
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
