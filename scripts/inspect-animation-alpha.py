#!/usr/bin/env python3
"""Print alpha coverage and per-cell bounding boxes for animation QA."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image


for raw in sys.argv[1:]:
    path = Path(raw)
    image = Image.open(path).convert("RGBA")
    alpha = np.asarray(image)[..., 3]
    print(path, image.size, {value: int(np.sum(alpha >= value)) for value in (1, 24, 64, 128, 192, 240, 254, 255)})
    columns, rows = ((4, 5) if "contact" in path.name else (8, 6))
    for threshold in (24, 128, 240, 254):
        boxes = []
        for row in range(rows):
            for column in range(columns):
                left = round(column * image.width / columns)
                top = round(row * image.height / rows)
                right = round((column + 1) * image.width / columns)
                bottom = round((row + 1) * image.height / rows)
                cell = Image.fromarray(alpha[top:bottom, left:right]).point(
                    lambda value: 255 if value >= threshold else 0,
                )
                bbox = cell.getbbox()
                boxes.append(None if bbox is None else (bbox[2] - bbox[0], bbox[3] - bbox[1]))
        print(" threshold", threshold, boxes)
