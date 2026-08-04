#!/usr/bin/env python3
"""Build compact browser grids from NOAA GFS and NASA OSCAR vector data."""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests
from eccodes import codes_get, codes_get_values, codes_grib_new_from_file, codes_release
from netCDF4 import Dataset

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = ROOT / "public" / "data"
DEFAULT_WORK_DIR = ROOT / ".vector-data"
OUTPUT_DIR = DEFAULT_OUTPUT_DIR
WORK_DIR = DEFAULT_WORK_DIR
DEPLOYED_OUTPUT_DIR: Path | None = ROOT / "out" / "data"
SCHEMA = "terrawatch-vector-grid-v1"
CMR_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"
OSCAR_COLLECTION = "C2102958977-POCLOUD"


def encode_grid(values: np.ndarray, scale: float) -> str:
    missing = ~np.isfinite(values)
    quantized = np.rint(np.nan_to_num(values, nan=0.0) / scale)
    quantized = np.clip(quantized, -32767, 32767).astype("<i2")
    quantized[missing] = -32768
    return base64.b64encode(quantized.tobytes(order="C")).decode("ascii")


def write_grid(
    output: Path,
    *,
    source: str,
    source_url: str,
    valid_time: str,
    latency: str,
    units: str,
    longitude_start: float,
    latitude_start: float,
    longitude_step: float,
    latitude_step: float,
    u: np.ndarray,
    v: np.ndarray,
    scale: float,
) -> None:
    if u.shape != v.shape or u.ndim != 2:
        raise ValueError(f"invalid vector grid shapes: {u.shape}, {v.shape}")
    payload = {
        "schema": SCHEMA,
        "source": source,
        "sourceUrl": source_url,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "validTime": valid_time,
        "latency": latency,
        "units": units,
        "width": int(u.shape[1]),
        "height": int(u.shape[0]),
        "longitudeStart": longitude_start,
        "latitudeStart": latitude_start,
        "longitudeStep": longitude_step,
        "latitudeStep": latitude_step,
        "scale": scale,
        "missing": -32768,
        "u": encode_grid(u, scale),
        "v": encode_grid(v, scale),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    temporary.replace(output)
    deployed_output = DEPLOYED_OUTPUT_DIR / output.name if DEPLOYED_OUTPUT_DIR else None
    if deployed_output and (ROOT / "out").exists():
        deployed_output.parent.mkdir(parents=True, exist_ok=True)
        deployed_temporary = deployed_output.with_suffix(".tmp")
        shutil.copyfile(output, deployed_temporary)
        deployed_temporary.replace(deployed_output)
    print(f"wrote {output} ({output.stat().st_size / 1024:.1f} KiB, {u.shape[1]}x{u.shape[0]})")


def latest_gfs_url() -> tuple[str, datetime]:
    now = datetime.now(timezone.utc)
    start = now.replace(minute=0, second=0, microsecond=0)
    for hours_back in range(0, 43, 6):
        candidate = start - timedelta(hours=hours_back)
        cycle = (candidate.hour // 6) * 6
        run = candidate.replace(hour=cycle)
        date = run.strftime("%Y%m%d")
        cycle_text = f"{cycle:02d}"
        url = (
            "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?"
            f"file=gfs.t{cycle_text}z.pgrb2.0p25.f000"
            "&lev_10_m_above_ground=on&var_UGRD=on&var_VGRD=on"
            f"&dir=%2Fgfs.{date}%2F{cycle_text}%2Fatmos"
        )
        response = requests.get(url, stream=True, timeout=30)
        if response.ok and response.headers.get("content-type", "").lower().find("text/html") < 0:
            response.close()
            return url, run
        response.close()
    raise RuntimeError("no recent NOAA GFS analysis cycle was available")


def update_wind() -> None:
    url, run = latest_gfs_url()
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    grib_path = WORK_DIR / "gfs-wind.grib2"
    with requests.get(url, stream=True, timeout=120) as response:
        response.raise_for_status()
        with grib_path.open("wb") as handle:
            for chunk in response.iter_content(1024 * 1024):
                handle.write(chunk)

    components: dict[str, np.ndarray] = {}
    metadata: dict[str, float | int] = {}
    with grib_path.open("rb") as handle:
        while message := codes_grib_new_from_file(handle):
            try:
                short_name = str(codes_get(message, "shortName"))
                ni = int(codes_get(message, "Ni"))
                nj = int(codes_get(message, "Nj"))
                values = np.asarray(codes_get_values(message), dtype=np.float32).reshape(nj, ni)
                components[short_name] = values
                metadata = {
                    "lon": float(codes_get(message, "longitudeOfFirstGridPointInDegrees")),
                    "lat": float(codes_get(message, "latitudeOfFirstGridPointInDegrees")),
                    "di": float(codes_get(message, "iDirectionIncrementInDegrees")),
                    "dj": -abs(float(codes_get(message, "jDirectionIncrementInDegrees"))),
                }
            finally:
                codes_release(message)

    if "10u" not in components or "10v" not in components:
        raise RuntimeError(f"GFS file did not contain both wind components: {components.keys()}")

    stride = 4  # 0.25° source -> compact 1° browser grid.
    write_grid(
        OUTPUT_DIR / "wind-latest.json",
        source="NOAA GFS · 10 m wind analysis",
        source_url="https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast",
        valid_time=run.isoformat().replace("+00:00", "Z"),
        latency="Analysis cycle · updated four times daily",
        units="m/s",
        longitude_start=float(metadata["lon"]),
        latitude_start=float(metadata["lat"]),
        longitude_step=float(metadata["di"]) * stride,
        latitude_step=float(metadata["dj"]) * stride,
        u=components["10u"][::stride, ::stride],
        v=components["10v"][::stride, ::stride],
        scale=0.01,
    )


def earthdata_token() -> str:
    if token := os.environ.get("EARTHDATA_TOKEN", "").strip():
        return token
    token_path = Path.home() / ".config" / "terrawatch" / "earthdata-token"
    if token_path.exists():
        return token_path.read_text(encoding="utf-8").strip()
    raise RuntimeError(
        "NASA Earthdata token missing; set EARTHDATA_TOKEN or create "
        "~/.config/terrawatch/earthdata-token with mode 0600"
    )


def latest_oscar_granule() -> tuple[str, str]:
    response = requests.get(
        CMR_URL,
        params={
            "collection_concept_id": OSCAR_COLLECTION,
            "page_size": 1,
            "sort_key": "-start_date",
        },
        timeout=30,
    )
    response.raise_for_status()
    entry = response.json()["feed"]["entry"][0]
    data_link = next(
        link["href"]
        for link in entry["links"]
        if link.get("rel", "").endswith("/data#") and link["href"].endswith(".nc")
    )
    return data_link, entry["time_start"]


def squeeze_component(variable) -> np.ma.MaskedArray:
    values = np.ma.asarray(variable[:])
    return np.ma.squeeze(values)


def update_currents() -> None:
    token = earthdata_token()
    url, valid_time = latest_oscar_granule()
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    nc_path = WORK_DIR / "oscar-currents.nc"
    headers = {"Authorization": f"Bearer {token}"}
    with requests.get(url, headers=headers, stream=True, timeout=180) as response:
        response.raise_for_status()
        if "text/html" in response.headers.get("content-type", "").lower():
            raise RuntimeError("NASA returned an HTML login page; check the Earthdata token")
        with nc_path.open("wb") as handle:
            for chunk in response.iter_content(1024 * 1024):
                handle.write(chunk)

    with Dataset(nc_path) as dataset:
        lat_name = "latitude" if "latitude" in dataset.variables else "lat"
        lon_name = "longitude" if "longitude" in dataset.variables else "lon"
        latitude = np.asarray(dataset.variables[lat_name][:], dtype=np.float64)
        longitude = np.asarray(dataset.variables[lon_name][:], dtype=np.float64)
        u_variable = dataset.variables["u"]
        v_variable = dataset.variables["v"]
        u = squeeze_component(u_variable)
        v = squeeze_component(v_variable)
        latitude_dimension = dataset.variables[lat_name].dimensions[0]
        longitude_dimension = dataset.variables[lon_name].dimensions[0]
        component_dimensions = tuple(dimension for dimension in u_variable.dimensions if dimension != "time")

    if component_dimensions == (longitude_dimension, latitude_dimension):
        u = np.ma.transpose(u)
        v = np.ma.transpose(v)
    elif component_dimensions != (latitude_dimension, longitude_dimension):
        raise RuntimeError(f"unexpected OSCAR dimension order: {component_dimensions}")

    if u.ndim != 2 or v.ndim != 2:
        raise RuntimeError(f"unexpected OSCAR component shapes: {u.shape}, {v.shape}")
    u = np.ma.filled(u, np.nan).astype(np.float32)
    v = np.ma.filled(v, np.nan).astype(np.float32)
    if latitude[0] < latitude[-1]:
        latitude = latitude[::-1]
        u = u[::-1, :]
        v = v[::-1, :]
    order = np.argsort(np.mod(longitude, 360.0))
    longitude = np.mod(longitude[order], 360.0)
    u = u[:, order]
    v = v[:, order]

    stride = 2  # 0.25° source -> 0.5° browser grid; retains major boundary currents.
    write_grid(
        OUTPUT_DIR / "currents-latest.json",
        source="NASA/JPL OSCAR NRT · surface currents",
        source_url="https://www.earthdata.nasa.gov/data/catalog/pocloud-oscar-l4-oc-nrt-v2.0-2.0",
        valid_time=valid_time,
        latency="Near real time · approximately 2-day latency",
        units="m/s",
        longitude_start=float(longitude[0]),
        latitude_start=float(latitude[0]),
        longitude_step=float(abs(longitude[1] - longitude[0])) * stride,
        latitude_step=-float(abs(latitude[1] - latitude[0])) * stride,
        u=u[::stride, ::stride],
        v=v[::stride, ::stride],
        scale=0.001,
    )


def main() -> int:
    global OUTPUT_DIR, WORK_DIR, DEPLOYED_OUTPUT_DIR
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", choices=("wind", "currents", "all"), nargs="?", default="all")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(os.environ.get("TERRAWATCH_DATA_DIR", DEFAULT_OUTPUT_DIR)),
        help="Directory where the browser data files are published.",
    )
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=Path(os.environ.get("TERRAWATCH_VECTOR_WORK_DIR", DEFAULT_WORK_DIR)),
        help="Directory for temporary GRIB and NetCDF downloads.",
    )
    args = parser.parse_args()
    OUTPUT_DIR = args.output_dir.resolve()
    WORK_DIR = args.work_dir.resolve()
    DEPLOYED_OUTPUT_DIR = (
        ROOT / "out" / "data"
        if OUTPUT_DIR == DEFAULT_OUTPUT_DIR.resolve()
        else None
    )
    if args.dataset in ("wind", "all"):
        update_wind()
    if args.dataset in ("currents", "all"):
        update_currents()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"vector update failed: {error}", file=sys.stderr)
        raise SystemExit(1)
