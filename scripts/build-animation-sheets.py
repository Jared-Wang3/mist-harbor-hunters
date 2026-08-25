#!/usr/bin/env python3
"""Normalize generated 4x5 contact sheets into the game's 8x6 sprite contract."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


SOURCE_COLUMNS = 4
SOURCE_ROWS = 5
OUTPUT_COLUMNS = 8
OUTPUT_ROWS = 6
CELL_SIZE = 256
MAX_CHARACTER_HEIGHT = 216
ALPHA_THRESHOLD = 24


def cell_bounds(image: Image.Image, column: int, row: int) -> tuple[int, int, int, int]:
    left = round(column * image.width / SOURCE_COLUMNS)
    top = round(row * image.height / SOURCE_ROWS)
    right = round((column + 1) * image.width / SOURCE_COLUMNS)
    bottom = round((row + 1) * image.height / SOURCE_ROWS)
    return left, top, right, bottom


def opaque_bbox(cell: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = cell.getchannel("A").point(lambda value: 255 if value > ALPHA_THRESHOLD else 0)
    return alpha.getbbox()


def normalize_frame(
    source: Image.Image,
    source_index: int,
    max_height: int = MAX_CHARACTER_HEIGHT,
    cell_size: int = CELL_SIZE,
) -> Image.Image:
    source_col = source_index % SOURCE_COLUMNS
    source_row = source_index // SOURCE_COLUMNS
    cell = source.crop(cell_bounds(source, source_col, source_row))
    # Discard only the deliberately feathered fringe before resizing.
    red, green, blue, alpha = cell.split()
    alpha = alpha.point(
        lambda value: 0 if value <= ALPHA_THRESHOLD else min(255, round((value - ALPHA_THRESHOLD) * 255 / (255 - ALPHA_THRESHOLD))),
    )
    cell = Image.merge("RGBA", (red, green, blue, alpha))
    bbox = opaque_bbox(cell)
    output = Image.new("RGBA", (cell_size, cell_size), (0, 0, 0, 0))
    if bbox is None:
        return output

    character = cell.crop(bbox)
    # Keep long sword/gun silhouettes readable without letting frame scale vary wildly.
    maximum_width = cell_size - max(4, round(cell_size * 0.03125))
    maximum_height = max_height
    scale = min(maximum_width / character.width, maximum_height / character.height, 1.18)
    resized = character.resize(
        (max(1, round(character.width * scale)), max(1, round(character.height * scale))),
        Image.Resampling.LANCZOS,
    )
    left = round((cell_size - resized.width) / 2)
    foot_anchor_y = round(cell_size * 0.875)
    top = foot_anchor_y - resized.height
    output.alpha_composite(resized, (left, top))
    return output


def build_sheet(
    source_path: Path,
    output_path: Path,
    max_height: int = MAX_CHARACTER_HEIGHT,
    cell_size: int = CELL_SIZE,
) -> None:
    source = Image.open(source_path).convert("RGBA")
    alpha = source.getchannel("A")
    transparent = sum(1 for value in alpha.getdata() if value <= ALPHA_THRESHOLD)
    coverage = 1 - transparent / (source.width * source.height)
    corners = [alpha.getpixel(point) for point in ((0, 0), (source.width - 1, 0), (0, source.height - 1), (source.width - 1, source.height - 1))]
    if coverage > 0.45 or any(value > ALPHA_THRESHOLD for value in corners):
        raise ValueError(
            f"{source_path} is not a clean alpha contact sheet "
            f"(coverage={coverage:.1%}, corners={corners}); remove the chroma key first"
        )
    if cell_size < 64:
        raise ValueError("cell size must be at least 64 pixels")
    if max_height >= cell_size:
        raise ValueError("max height must be smaller than the cell size")
    frames = [
        normalize_frame(source, index, max_height, cell_size)
        for index in range(SOURCE_COLUMNS * SOURCE_ROWS)
    ]

    # Generated rows contain four meaningful poses. Duplicate them in ping-pong order so
    # the runtime can use a uniform eight-frame animation contract without frozen frames.
    ping_pong = [0, 1, 2, 3, 2, 1, 0, 1]
    sheet = Image.new(
        "RGBA",
        (OUTPUT_COLUMNS * cell_size, OUTPUT_ROWS * cell_size),
        (0, 0, 0, 0),
    )
    for output_row in range(OUTPUT_ROWS):
        source_row = min(output_row, SOURCE_ROWS - 1)
        for output_col, source_col in enumerate(ping_pong):
            frame = frames[source_row * SOURCE_COLUMNS + source_col]
            sheet.alpha_composite(frame, (output_col * cell_size, output_row * cell_size))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.suffix.lower() == ".png":
        sheet.save(output_path, "PNG", optimize=True)
    else:
        sheet.save(output_path, "WEBP", lossless=True, method=6)
    print(f"Wrote {output_path} ({sheet.width}x{sheet.height})")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--max-height", type=int, default=MAX_CHARACTER_HEIGHT)
    parser.add_argument("--cell-size", type=int, default=CELL_SIZE)
    args = parser.parse_args()
    build_sheet(args.source, args.output, args.max_height, args.cell_size)


if __name__ == "__main__":
    main()
