#!/usr/bin/env python3
"""Build semantic v6 world tiles, atlases, and animation masks.

The v6 pipeline never stretches a painted overview into the playable world.
It composes the 5120x2880 ground from seamless surface sources and semantic
polygons, then packs transparent props separately for runtime y-sorting.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps, ImageStat

WORLD_SIZE = (5120, 2880)
TILE_SIZE = (1280, 720)
MASK_SCALE = 0.25
MASK_TILE_SIZE = (320, 180)
OVERVIEW_SIZE = (512, 288)
GRID_COLUMNS = 4
GRID_ROWS = 4
SURFACE_CELL_SIZE = 512
FOREGROUND_CELL_SIZE = 384
SURFACE_COLUMNS = 2
FOREGROUND_COLUMNS = 4
MAP_MAX_BYTES = 750_000
OVERVIEW_MAX_BYTES = 170_000
SURFACE_MAX_BYTES = 900_000
FOREGROUND_MAX_BYTES = 1_800_000
ROUTE_SURFACES = frozenset(("boardwalk", "timber-wharf", "bridge-deck"))
ORGANIC_TRANSITION_BY_STAGE = {
    "stage-01": 32,
    "stage-02": 18,
    "stage-03": 28,
}


@dataclass(frozen=True)
class StageAssets:
    surfaces: tuple[str, str, str, str]
    props: tuple[str, str, str, str, str, str]


STAGE_ASSETS = {
    "stage-01": StageAssets(
        ("sand-stone", "marsh-mud", "boardwalk", "deep-water"),
        ("hunter-hut", "broken-pier", "reef-cluster", "flood-wall", "market-stall", "lighthouse-base"),
    ),
    "stage-02": StageAssets(
        ("market-stone", "wet-brick", "timber-wharf", "canal-water"),
        ("landing-arch", "canal-bridge", "sluice-machine", "cargo-shrine", "opera-stage", "regent-gate"),
    ),
    "stage-03": StageAssets(
        ("heavenly-stone", "gold-inlay", "bridge-deck", "cloud-void"),
        ("sky-dock", "bridge-anchor", "cloud-bell", "beacon-tower", "heavenly-altar", "return-gate"),
    ),
}


def save_webp_with_budget(
    image: Image.Image,
    output: Path,
    *,
    initial_quality: int,
    minimum_quality: int,
    maximum_bytes: int,
    exact: bool = False,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    for quality in range(initial_quality, minimum_quality - 1, -2):
        image.save(output, "WEBP", quality=quality, method=6, exact=exact)
        if output.stat().st_size <= maximum_bytes:
            print(f"Wrote {output} ({image.width}x{image.height}, q={quality}, {output.stat().st_size}B)")
            return
    raise ValueError(f"{output} exceeds {maximum_bytes}B at quality {minimum_quality}")


def read_stage(project_root: Path, stage_id: str) -> dict[str, Any]:
    path = project_root / "src" / "world-v6" / f"{stage_id}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != 6 or data.get("id") != stage_id:
        raise ValueError(f"invalid v6 stage metadata: {path}")
    world = data.get("world")
    if not isinstance(world, dict) or (world.get("width"), world.get("height")) != WORLD_SIZE:
        raise ValueError(f"{path} must target the {WORLD_SIZE[0]}x{WORLD_SIZE[1]} world")
    if len(data.get("zones", ())) != 5 or len(data.get("objectives", ())) != 3:
        raise ValueError(f"{path} must define five zones and three objectives")
    if not data.get("surfaceZones") or not data.get("walkablePolygons"):
        raise ValueError(f"{path} is missing semantic surface geometry")
    return data


def border_rms(image: Image.Image) -> tuple[float, float]:
    sample = image.convert("RGB").resize((512, 512), Image.Resampling.LANCZOS)
    left = sample.crop((0, 0, 8, 512))
    right = ImageOps.mirror(sample.crop((504, 0, 512, 512)))
    top = sample.crop((0, 0, 512, 8))
    bottom = ImageOps.flip(sample.crop((0, 504, 512, 512)))
    horizontal = math.sqrt(sum(value * value for value in ImageStat.Stat(ImageChops.difference(left, right)).rms) / 3)
    vertical = math.sqrt(sum(value * value for value in ImageStat.Stat(ImageChops.difference(top, bottom)).rms) / 3)
    return horizontal, vertical


def load_surface(path: Path) -> Image.Image:
    with Image.open(path) as opened:
        source = opened.convert("RGB")
    if source.width < 1024 or source.height < 1024:
        raise ValueError(f"surface source must be at least 1024x1024 without upscaling: {path}")
    side = min(source.width, source.height)
    left = (source.width - side) // 2
    top = (source.height - side) // 2
    source = source.crop((left, top, left + side, top + side))
    if side > 1024:
        source = source.resize((1024, 1024), Image.Resampling.LANCZOS)
    horizontal, vertical = border_rms(source)
    status = "seam-safe" if max(horizontal, vertical) <= 32 else "mirror-normalized"
    print(f"Checked {path} (border RMS {horizontal:.1f}/{vertical:.1f}, {status})")
    return source


def texture_canvas(source: Image.Image, size: tuple[int, int]) -> Image.Image:
    variants = (
        source,
        ImageOps.mirror(source),
        ImageOps.flip(source),
        ImageOps.flip(ImageOps.mirror(source)),
    )
    canvas = Image.new("RGB", size)
    for row, y in enumerate(range(0, size[1], source.height)):
        for column, x in enumerate(range(0, size[0], source.width)):
            variant = variants[(row % 2) * 2 + (column % 2)]
            canvas.paste(variant, (x, y))
    return canvas


def polygon_mask(polygons: list[list[list[int]]], size: tuple[int, int] = WORLD_SIZE) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    scale_x = size[0] / WORLD_SIZE[0]
    scale_y = size[1] / WORLD_SIZE[1]
    for polygon in polygons:
        draw.polygon([(round(x * scale_x), round(y * scale_y)) for x, y in polygon], fill=255)
    return mask


def region_mask(region: dict[str, Any], size: tuple[int, int] = WORLD_SIZE) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    scale_x = size[0] / WORLD_SIZE[0]
    scale_y = size[1] / WORLD_SIZE[1]
    if region["shape"] == "circle":
        x = region["x"] * scale_x
        y = region["y"] * scale_y
        radius_x = region["radius"] * scale_x
        radius_y = region["radius"] * scale_y
        draw.ellipse((x - radius_x, y - radius_y, x + radius_x, y + radius_y), fill=255)
    else:
        draw.rectangle(
            (
                round(region["x"] * scale_x),
                round(region["y"] * scale_y),
                round((region["x"] + region["width"]) * scale_x),
                round((region["y"] + region["height"]) * scale_y),
            ),
            fill=255,
        )
    return mask


def alpha_composite_masked(base: Image.Image, overlay: Image.Image, mask: Image.Image) -> None:
    base.paste(overlay, (0, 0), mask)


def low_frequency_noise(size: tuple[int, int], label: str, cell_size: int = 128) -> Image.Image:
    columns = math.ceil(size[0] / cell_size) + 2
    rows = math.ceil(size[1] / cell_size) + 2
    generator = random.Random(zlib.crc32(label.encode("utf-8")))
    values = bytes(generator.randrange(48, 209) for _ in range(columns * rows))
    coarse = Image.frombytes("L", (columns, rows), values)
    noise = coarse.resize(size, Image.Resampling.BICUBIC)
    coarse.close()
    return noise


def organicize_mask(base: Image.Image, label: str, transition: int) -> Image.Image:
    softened = base.filter(ImageFilter.GaussianBlur(transition))
    noise = low_frequency_noise(base.size, label)
    perturbed = ImageChops.add(softened, noise, scale=1, offset=-128)

    def feather(value: int) -> int:
        amount = max(0.0, min(1.0, (value - 112) / 32))
        amount = amount * amount * (3 - 2 * amount)
        return round(amount * 255)

    result = perturbed.point(feather).filter(ImageFilter.GaussianBlur(3.2))
    softened.close()
    noise.close()
    perturbed.close()
    return result


def organic_polygon_mask(polygons: list[list[list[int]]], label: str, transition: int) -> Image.Image:
    base = polygon_mask(polygons)
    result = organicize_mask(base, label, transition)
    base.close()
    return result


def organic_region_mask(region: dict[str, Any], label: str, transition: int) -> Image.Image:
    base = region_mask(region)
    result = organicize_mask(base, label, transition)
    base.close()
    return result


def corridor_angle(points: list[list[int]]) -> float:
    if len(points) != 4:
        return 0
    edges = []
    for index, (x1, y1) in enumerate(points):
        x2, y2 = points[(index + 1) % len(points)]
        edges.append((math.hypot(x2 - x1, y2 - y1), index))
    short_edges = sorted(edges)[:2]
    midpoints = []
    for _, index in short_edges:
        x1, y1 = points[index]
        x2, y2 = points[(index + 1) % len(points)]
        midpoints.append(((x1 + x2) / 2, (y1 + y2) / 2))
    (x1, y1), (x2, y2) = midpoints
    angle = -math.degrees(math.atan2(y2 - y1, x2 - x1))
    while angle > 90:
        angle -= 180
    while angle < -90:
        angle += 180
    return angle


def oriented_texture_patch(source: Image.Image, size: tuple[int, int], angle: float) -> Image.Image:
    diagonal = math.ceil(math.hypot(*size)) + 32
    canvas = texture_canvas(source, (diagonal, diagonal))
    rotated = canvas.rotate(angle, resample=Image.Resampling.BICUBIC, expand=False)
    left = round((diagonal - size[0]) / 2)
    top = round((diagonal - size[1]) / 2)
    patch = rotated.crop((left, top, left + size[0], top + size[1]))
    canvas.close()
    rotated.close()
    return patch


def paste_route_surface(
    world: Image.Image,
    source: Image.Image,
    polygon: list[list[int]],
) -> Image.Image:
    base = polygon_mask([polygon])
    mask = base.filter(ImageFilter.GaussianBlur(2.2))
    base.close()
    bbox = mask.getbbox()
    if bbox is None:
        return mask
    left, top, right, bottom = bbox
    patch = oriented_texture_patch(source, (right - left, bottom - top), corridor_angle(polygon))
    local_mask = mask.crop(bbox)
    world.paste(patch, (left, top), local_mask)
    patch.close()
    local_mask.close()
    return mask


def build_ground(
    stage: dict[str, Any],
    surfaces: dict[str, Image.Image],
    edge_source: Image.Image,
) -> tuple[Image.Image, dict[str, Image.Image]]:
    canvases: dict[str, Image.Image] = {}

    def canvas_for(surface: str) -> Image.Image:
        if surface not in canvases:
            canvases[surface] = texture_canvas(surfaces[surface], WORLD_SIZE)
        return canvases[surface]

    ordered = sorted(stage["surfaceZones"], key=lambda zone: zone["priority"])
    base_surface = ordered[0]["surface"]
    world = canvas_for(base_surface).copy()
    transition = ORGANIC_TRANSITION_BY_STAGE[stage["id"]]
    non_route_zones = [zone for zone in ordered[1:] if zone["surface"] not in ROUTE_SURFACES]
    if not non_route_zones:
        raise ValueError(f"{stage['id']} requires at least one non-route land surface")
    fallback_zone = non_route_zones[0]
    land_polygons = [
        polygon
        for zone in non_route_zones
        for polygon in zone["polygons"]
    ]
    land_visual = organic_polygon_mask(
        land_polygons,
        f"{stage['id']}:land-silhouette",
        transition,
    )
    alpha_composite_masked(world, canvas_for(fallback_zone["surface"]), land_visual)
    for zone in ordered[1:]:
        if zone["surface"] in ROUTE_SURFACES:
            for polygon in zone["polygons"]:
                mask = paste_route_surface(world, surfaces[zone["surface"]], polygon)
                combined = ImageChops.lighter(land_visual, mask)
                land_visual.close()
                land_visual = combined
                mask.close()
            continue
        if zone["id"] == fallback_zone["id"]:
            continue
        zone_transition = transition + (12 if zone["priority"] >= 20 else 0)
        mask = organic_polygon_mask(
            zone["polygons"],
            f"{stage['id']}:{zone['id']}",
            zone_transition,
        )
        clipped = ImageChops.multiply(mask, land_visual)
        alpha_composite_masked(world, canvas_for(zone["surface"]), clipped)
        clipped.close()
        mask.close()

    blocked = Image.new("L", WORLD_SIZE, 0)
    for region in stage.get("blockedRegions", ()):
        mask = organic_region_mask(
            region,
            f"{stage['id']}:{region['id']}",
            max(10, round(transition * 0.72)),
        )
        alpha_composite_masked(world, canvas_for(base_surface), mask)
        combined = ImageChops.lighter(blocked, mask)
        blocked.close()
        blocked = combined
        mask.close()

    visible_land = ImageChops.subtract(land_visual, blocked)
    expanded = visible_land.filter(ImageFilter.MaxFilter(15))
    edge_mask = ImageChops.subtract(expanded, visible_land).filter(ImageFilter.GaussianBlur(1.6))
    expanded.close()
    decal_alpha = edge_source.getchannel("A")
    decal_color = tuple(round(value) for value in ImageStat.Stat(edge_source.convert("RGB"), decal_alpha).mean)
    edge_rgba = Image.new("RGBA", WORLD_SIZE, (*decal_color, 0))
    source_alpha = texture_canvas(decal_alpha.convert("RGB"), WORLD_SIZE).convert("L")
    variation = source_alpha.point(lambda value: 70 + round(value * 0.25))
    edge_alpha = ImageChops.multiply(variation, edge_mask)
    edge_rgba.putalpha(edge_alpha)
    world = Image.alpha_composite(world.convert("RGBA"), edge_rgba).convert("RGB")
    edge_rgba.close()
    source_alpha.close()
    variation.close()
    edge_alpha.close()
    decal_alpha.close()
    edge_mask.close()
    visible_land.close()
    land_visual.close()
    blocked.close()
    return world, canvases


def validate_transparent_source(path: Path, minimum_size: int) -> Image.Image:
    with Image.open(path) as opened:
        source = opened.convert("RGBA")
    if source.width < minimum_size or source.height < minimum_size:
        raise ValueError(f"transparent source must be at least {minimum_size}px on both axes: {path}")
    alpha = source.getchannel("A")
    extrema = alpha.getextrema()
    corners = [
        alpha.getpixel(point)
        for point in ((0, 0), (source.width - 1, 0), (0, source.height - 1), (source.width - 1, source.height - 1))
    ]
    if extrema[0] > 8 or extrema[1] < 128 or any(value > 24 for value in corners):
        raise ValueError(f"source lacks usable transparent separation: {path} extrema={extrema}, corners={corners}")
    return source


def normalize_foreground(source: Image.Image) -> tuple[Image.Image, tuple[int, int, int, int]]:
    alpha = source.getchannel("A").point(lambda value: 0 if value <= 8 else value)
    bbox = alpha.point(lambda value: 255 if value >= 24 else 0).getbbox()
    if bbox is None:
        raise ValueError("transparent foreground source has no visible pixels")
    item = source.crop(bbox)
    margin_x = 24
    margin_y = 20
    maximum = (FOREGROUND_CELL_SIZE - margin_x * 2, FOREGROUND_CELL_SIZE - margin_y * 2)
    scale = min(1, maximum[0] / item.width, maximum[1] / item.height)
    if scale < 1:
        item = item.resize(
            (max(1, round(item.width * scale)), max(1, round(item.height * scale))),
            Image.Resampling.LANCZOS,
        )
    cell = Image.new("RGBA", (FOREGROUND_CELL_SIZE, FOREGROUND_CELL_SIZE), (0, 0, 0, 0))
    left = round((FOREGROUND_CELL_SIZE - item.width) / 2)
    top = FOREGROUND_CELL_SIZE - margin_y - item.height
    cell.alpha_composite(item, (left, top))
    return cell, (left, top, item.width, item.height)


def build_surface_atlas(surfaces: dict[str, Image.Image], order: tuple[str, ...], output: Path) -> None:
    atlas = Image.new(
        "RGB",
        (SURFACE_COLUMNS * SURFACE_CELL_SIZE, 2 * SURFACE_CELL_SIZE),
        (0, 0, 0),
    )
    for index, name in enumerate(order):
        cell = surfaces[name].resize((SURFACE_CELL_SIZE, SURFACE_CELL_SIZE), Image.Resampling.LANCZOS)
        atlas.paste(cell, ((index % SURFACE_COLUMNS) * SURFACE_CELL_SIZE, (index // SURFACE_COLUMNS) * SURFACE_CELL_SIZE))
    save_webp_with_budget(
        atlas,
        output,
        initial_quality=88,
        minimum_quality=68,
        maximum_bytes=SURFACE_MAX_BYTES,
    )
    atlas.close()


def build_foreground_atlas(
    stage_root: Path,
    output_root: Path,
    order: tuple[str, ...],
    stage: dict[str, Any],
) -> None:
    rows = math.ceil(len(order) / FOREGROUND_COLUMNS)
    atlas = Image.new(
        "RGBA",
        (FOREGROUND_COLUMNS * FOREGROUND_CELL_SIZE, rows * FOREGROUND_CELL_SIZE),
        (0, 0, 0, 0),
    )
    manifest: dict[str, Any] = {
        "version": 6,
        "cellSize": FOREGROUND_CELL_SIZE,
        "columns": FOREGROUND_COLUMNS,
        "rows": rows,
        "assets": {},
    }
    anchor_by_asset = {
        entry["asset"]: entry.get("anchor", [0.5, 0.9])
        for entry in stage.get("props", ())
    }
    for index, name in enumerate(order):
        source_path = stage_root / "props" / f"{name}-source.png"
        source = validate_transparent_source(source_path, 768)
        cell, content = normalize_foreground(source)
        column = index % FOREGROUND_COLUMNS
        row = index // FOREGROUND_COLUMNS
        atlas.alpha_composite(cell, (column * FOREGROUND_CELL_SIZE, row * FOREGROUND_CELL_SIZE))
        manifest["assets"][name] = {
            "column": column,
            "row": row,
            "anchor": anchor_by_asset.get(name, [0.5, 0.9]),
            "content": list(content),
        }
        source.close()
        cell.close()

    save_webp_with_budget(
        atlas,
        output_root / "foreground-v6.webp",
        initial_quality=92,
        minimum_quality=72,
        maximum_bytes=FOREGROUND_MAX_BYTES,
        exact=True,
    )
    (output_root / "foreground-v6.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {output_root / 'foreground-v6.json'}")
    atlas.close()


def scaled_polygon(points: list[list[int]], size: tuple[int, int]) -> list[tuple[int, int]]:
    return [
        (round(x * size[0] / WORLD_SIZE[0]), round(y * size[1] / WORLD_SIZE[1]))
        for x, y in points
    ]


def add_radial(channel: Image.Image, emitter: dict[str, Any], size: tuple[int, int]) -> None:
    x = round(emitter["x"] * size[0] / WORLD_SIZE[0])
    y = round(emitter["y"] * size[1] / WORLD_SIZE[1])
    radius = max(8, round(emitter["radius"] * size[0] / WORLD_SIZE[0]))
    intensity = round(255 * max(0, min(1, emitter.get("intensity", 0.5))))
    patch = Image.new("L", size, 0)
    draw = ImageDraw.Draw(patch)
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=intensity)
    patch = patch.filter(ImageFilter.GaussianBlur(max(4, radius * 0.42)))
    combined = ImageChops.lighter(channel, patch)
    channel.paste(combined)
    patch.close()
    combined.close()


def build_ambient_mask(stage: dict[str, Any], output_root: Path) -> None:
    size = (round(WORLD_SIZE[0] * MASK_SCALE), round(WORLD_SIZE[1] * MASK_SCALE))
    red = Image.new("L", size, 0)
    green = Image.new("L", size, 0)
    blue = Image.new("L", size, 0)
    fog = Image.new("L", size, 0)
    draw_red = ImageDraw.Draw(red)
    ordered = sorted(stage["surfaceZones"], key=lambda zone: zone["priority"])
    base_surface = ordered[0]["surface"]
    water_names = {base_surface, "deep-water", "canal-water", "cloud-void"}
    for zone in ordered:
        value = 230 if zone["surface"] in water_names else 0
        for polygon in zone["polygons"]:
            draw_red.polygon(scaled_polygon(polygon, size), fill=value)
    for region in stage.get("blockedRegions", ()):
        mask = region_mask(region, size)
        red.paste(235, (0, 0), mask)
        mask.close()

    draw_green = ImageDraw.Draw(green)
    for entry in stage["walkablePolygons"]:
        points = scaled_polygon(entry["points"], size)
        draw_green.line(points + [points[0]], fill=150, width=7, joint="curve")
    green = green.filter(ImageFilter.GaussianBlur(3.2))
    fog.paste(red.point(lambda value: round(value * 0.18)))

    for emitter in stage.get("ambientEmitters", ()):
        kind = emitter["kind"]
        if kind in ("water", "cloud"):
            add_radial(red, emitter, size)
        elif kind in ("foam", "wind"):
            add_radial(green, emitter, size)
        elif kind in ("glow", "reflection"):
            add_radial(blue, emitter, size)
        elif kind == "fog":
            add_radial(fog, emitter, size)

    weighted_glow = blue.point(lambda value: round(value * 0.9))
    ambient_effect = ImageChops.lighter(weighted_glow, fog)
    mask = Image.merge("RGB", (red, green, ambient_effect))
    for row in range(GRID_ROWS):
        for column in range(GRID_COLUMNS):
            left = column * MASK_TILE_SIZE[0]
            top = row * MASK_TILE_SIZE[1]
            tile = mask.crop((left, top, left + MASK_TILE_SIZE[0], top + MASK_TILE_SIZE[1]))
            output = output_root / f"ambient-mask-r{row}-c{column}-v6.png"
            tile.save(output, "PNG", optimize=True)
            print(f"Wrote {output} ({tile.width}x{tile.height}, RGB, {output.stat().st_size}B)")
            tile.close()
    mask.close()
    ambient_effect.close()
    weighted_glow.close()
    red.close()
    green.close()
    blue.close()
    fog.close()


def build_stage(project_root: Path, stage_id: str, validate_only: bool) -> None:
    stage = read_stage(project_root, stage_id)
    assets = STAGE_ASSETS[stage_id]
    source_root = project_root / "art-source" / "v6" / stage_id
    output_root = project_root / "public" / "assets" / "world" / stage_id
    surfaces = {
        name: load_surface(source_root / "surfaces" / f"{name}-source.png")
        for name in assets.surfaces
    }
    edge = validate_transparent_source(source_root / "edge-decal-source.png", 768)
    for name in assets.props:
        source = validate_transparent_source(source_root / "props" / f"{name}-source.png", 768)
        source.close()
    if validate_only:
        print(f"Validated {stage_id} v6 sources and semantic data")
        for source in surfaces.values():
            source.close()
        edge.close()
        return

    output_root.mkdir(parents=True, exist_ok=True)
    build_surface_atlas(surfaces, assets.surfaces, output_root / "surface-v6.webp")
    build_foreground_atlas(source_root, output_root, assets.props, stage)
    world, canvases = build_ground(stage, surfaces, edge)
    overview = world.resize(OVERVIEW_SIZE, Image.Resampling.LANCZOS)
    save_webp_with_budget(
        overview,
        output_root / "overview-v6.webp",
        initial_quality=86,
        minimum_quality=68,
        maximum_bytes=OVERVIEW_MAX_BYTES,
    )
    overview.close()
    for row in range(GRID_ROWS):
        for column in range(GRID_COLUMNS):
            left = column * TILE_SIZE[0]
            top = row * TILE_SIZE[1]
            tile = world.crop((left, top, left + TILE_SIZE[0], top + TILE_SIZE[1]))
            save_webp_with_budget(
                tile,
                output_root / f"ground-r{row}-c{column}-v6.webp",
                initial_quality=84,
                minimum_quality=60,
                maximum_bytes=MAP_MAX_BYTES,
            )
            tile.close()
    build_ambient_mask(stage, output_root)
    world.close()
    for canvas in canvases.values():
        canvas.close()
    for source in surfaces.values():
        source.close()
    edge.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--stage", choices=("all", *STAGE_ASSETS), default="all")
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    project_root = args.project_root.resolve()
    stages = tuple(STAGE_ASSETS) if args.stage == "all" else (args.stage,)
    for stage_id in stages:
        build_stage(project_root, stage_id, args.validate_only)


if __name__ == "__main__":
    main()
