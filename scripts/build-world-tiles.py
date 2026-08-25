#!/usr/bin/env python3
"""Build versioned three-stage world tiles, terrain atlases, and boss sheets."""

from __future__ import annotations

import argparse
import importlib.util
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps

WORLD_SIZE = (5120, 2880)
TILE_SIZE = (1280, 720)
OVERVIEW_SIZE = (512, 288)
GRID_COLUMNS = 4
GRID_ROWS = 4
MAP_MAX_BYTES = 700_000
OVERVIEW_MAX_BYTES = 160_000


@dataclass(frozen=True)
class StageSpec:
    directory: str
    version: str
    source: str


@dataclass(frozen=True)
class TerrainSpec:
    source: str
    output: str
    columns: int
    rows: int
    size: tuple[int, int]


STAGES = (
    StageSpec("stage-01", "v5", "stage-01-map-master.png"),
    StageSpec("stage-02", "v1", "stage-02-map-master.png"),
    StageSpec("stage-03", "v1", "stage-03-map-master.png"),
)

TERRAINS = (
    TerrainSpec("terrain-common-source.png", "terrain-common-v1.webp", 4, 2, (1536, 768)),
    TerrainSpec("terrain-stage-02-source.png", "stage-02/terrain-stage-02-v1.webp", 2, 2, (1024, 1024)),
    TerrainSpec("terrain-stage-03-source.png", "stage-03/terrain-stage-03-v1.webp", 2, 2, (1024, 1024)),
)

BOSSES = (
    ("lantern-regent-contact-source.png", "lantern-regent-anim-v1.png"),
    ("tide-tortoise-contact-source.png", "tide-tortoise-anim-v1.png"),
)


def save_webp_with_budget(
    image: Image.Image,
    output: Path,
    *,
    initial_quality: int,
    minimum_quality: int,
    maximum_bytes: int,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    for quality in range(initial_quality, minimum_quality - 1, -2):
        image.save(output, "WEBP", quality=quality, method=6)
        if output.stat().st_size <= maximum_bytes:
            print(f"Wrote {output} ({image.width}x{image.height}, q={quality}, {output.stat().st_size}B)")
            return
    raise ValueError(f"{output} exceeds {maximum_bytes}B at quality {minimum_quality}")


def normalized_world(source: Path) -> Image.Image:
    with Image.open(source) as opened:
        image = opened.convert("RGB")
    world = ImageOps.fit(
        image,
        WORLD_SIZE,
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    )
    return world.filter(ImageFilter.UnsharpMask(radius=1.1, percent=108, threshold=3))


def build_stage(source_root: Path, output_root: Path, stage: StageSpec) -> None:
    world = normalized_world(source_root / stage.source)
    stage_root = output_root / stage.directory
    overview = world.resize(OVERVIEW_SIZE, Image.Resampling.LANCZOS)
    save_webp_with_budget(
        overview,
        stage_root / f"overview-{stage.version}.webp",
        initial_quality=82,
        minimum_quality=72,
        maximum_bytes=OVERVIEW_MAX_BYTES,
    )

    for row in range(GRID_ROWS):
        for column in range(GRID_COLUMNS):
            left = column * TILE_SIZE[0]
            top = row * TILE_SIZE[1]
            tile = world.crop((left, top, left + TILE_SIZE[0], top + TILE_SIZE[1]))
            save_webp_with_budget(
                tile,
                stage_root / f"map-r{row}-c{column}-{stage.version}.webp",
                initial_quality=84,
                minimum_quality=72,
                maximum_bytes=MAP_MAX_BYTES,
            )
    world.close()


def cell_bounds(
    image: Image.Image,
    column: int,
    row: int,
    columns: int,
    rows: int,
) -> tuple[int, int, int, int]:
    return (
        round(column * image.width / columns),
        round(row * image.height / rows),
        round((column + 1) * image.width / columns),
        round((row + 1) * image.height / rows),
    )


def normalized_terrain_cell(cell: Image.Image, size: tuple[int, int]) -> Image.Image:
    red, green, blue, alpha = cell.convert("RGBA").split()
    alpha = alpha.point(lambda value: 0 if value <= 8 else value)
    cell = Image.merge("RGBA", (red, green, blue, alpha))
    bbox = alpha.point(lambda value: 255 if value >= 24 else 0).getbbox()
    if bbox is None:
        raise ValueError("terrain contact sheet contains an empty cell")
    item = cell.crop(bbox)
    margin = max(12, round(min(size) * 0.045))
    scale = min((size[0] - margin * 2) / item.width, (size[1] - margin * 2) / item.height)
    item = item.resize(
        (max(1, round(item.width * scale)), max(1, round(item.height * scale))),
        Image.Resampling.LANCZOS,
    )
    output = Image.new("RGBA", size, (0, 0, 0, 0))
    left = round((size[0] - item.width) / 2)
    top = size[1] - margin - item.height
    output.alpha_composite(item, (left, top))
    return output


def build_terrain(source_root: Path, output_root: Path, spec: TerrainSpec) -> None:
    with Image.open(source_root / spec.source) as opened:
        source = opened.convert("RGBA")
    cell_width = spec.size[0] // spec.columns
    cell_height = spec.size[1] // spec.rows
    atlas = Image.new("RGBA", spec.size, (0, 0, 0, 0))
    for row in range(spec.rows):
        for column in range(spec.columns):
            source_cell = source.crop(cell_bounds(source, column, row, spec.columns, spec.rows))
            cell = normalized_terrain_cell(source_cell, (cell_width, cell_height))
            atlas.alpha_composite(cell, (column * cell_width, row * cell_height))
    output = output_root / spec.output
    output.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(output, "WEBP", quality=90, method=6, exact=True)
    print(f"Wrote {output} ({atlas.width}x{atlas.height}, alpha, {output.stat().st_size}B)")


def load_animation_builder(project_root: Path):
    script = project_root / "scripts" / "build-animation-sheets.py"
    spec = importlib.util.spec_from_file_location("mist_harbor_animation_builder", script)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_bosses(project_root: Path, source_root: Path, assets_root: Path) -> None:
    animation = load_animation_builder(project_root)
    ping_pong = (0, 1, 2, 3, 2, 1, 0, 1)
    for source_name, output_name in BOSSES:
        with Image.open(source_root / source_name) as opened:
            source = opened.convert("RGBA")
        corners = [
            source.getchannel("A").getpixel(point)
            for point in (
                (0, 0),
                (source.width - 1, 0),
                (0, source.height - 1),
                (source.width - 1, source.height - 1),
            )
        ]
        if any(value > animation.ALPHA_THRESHOLD for value in corners):
            raise ValueError(f"{source_name} does not have transparent corners: {corners}")
        frames = [
            animation.normalize_frame(source, index, max_height=108, cell_size=128)
            for index in range(animation.SOURCE_COLUMNS * animation.SOURCE_ROWS)
        ]
        sheet = Image.new("RGBA", (1024, 768), (0, 0, 0, 0))
        for output_row in range(6):
            source_row = min(output_row, 4)
            for output_column, source_column in enumerate(ping_pong):
                frame = frames[source_row * 4 + source_column]
                sheet.alpha_composite(frame, (output_column * 128, output_row * 128))
        output = assets_root / output_name
        output.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(output, "PNG", optimize=True)
        print(f"Wrote {output} ({sheet.width}x{sheet.height}, alpha, {output.stat().st_size}B)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--kind", choices=("all", "maps", "terrain", "bosses"), default="all")
    parser.add_argument("--stage", choices=("all", *(stage.directory for stage in STAGES)), default="all")
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    source_root = project_root / "art-source" / "v5"
    assets_root = project_root / "public" / "assets"
    world_root = assets_root / "world"

    if args.kind in ("all", "maps"):
        stages = STAGES if args.stage == "all" else tuple(
            stage for stage in STAGES if stage.directory == args.stage
        )
        for stage in stages:
            build_stage(source_root, world_root, stage)
    if args.kind in ("all", "terrain"):
        for terrain in TERRAINS:
            build_terrain(source_root, world_root, terrain)
    if args.kind in ("all", "bosses"):
        build_bosses(project_root, source_root, assets_root)


if __name__ == "__main__":
    main()
