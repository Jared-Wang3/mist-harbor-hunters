#!/usr/bin/env python3
"""Remove magenta ImageGen contact-sheet backgrounds without preserving compression blocks."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def clean_key(source: Path, output: Path) -> None:
    image = Image.open(source).convert("RGBA")
    rgb = np.asarray(image, dtype=np.uint8)[..., :3].astype(np.float32)
    red, green, blue = rgb[..., 0], rgb[..., 1], rgb[..., 2]

    # ImageGen's nominal #ff00ff background arrives as a broad JPEG-like colour
    # family. Its defining property is high red+blue and very low green. Distance
    # to a single sampled RGB value is therefore insufficient.
    chroma_strength = np.minimum(red, blue) - green
    magenta_balance = np.abs(red - blue)
    definitely_key = (
        (red > 150)
        & (blue > 150)
        & (green < 105)
        & (chroma_strength > 78)
        & (magenta_balance < 95)
    )
    edge_key = (
        (red > 125)
        & (blue > 125)
        & (green < 130)
        & (chroma_strength > 42)
        & (magenta_balance < 125)
    )

    alpha = np.full(red.shape, 255, dtype=np.uint8)
    alpha[definitely_key] = 0
    soft = edge_key & ~definitely_key
    alpha[soft] = np.clip((chroma_strength[soft] - 42) * -7 + 255, 0, 255).astype(np.uint8)

    # Contract a little, then feather a fraction of a pixel to remove the last
    # coloured halo while keeping ink lines and weapon effects crisp.
    matte = Image.fromarray(alpha, mode="L").filter(ImageFilter.MinFilter(3))
    matte = matte.filter(ImageFilter.GaussianBlur(0.35))
    rgba = image.copy()
    rgba.putalpha(matte)

    output.parent.mkdir(parents=True, exist_ok=True)
    rgba.save(output, "PNG", optimize=True)
    values = np.asarray(matte)
    print(
        f"Wrote {output}; transparent={int(np.sum(values == 0))}; "
        f"partial={int(np.sum((values > 0) & (values < 255)))}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    clean_key(args.source, args.output)


if __name__ == "__main__":
    main()
