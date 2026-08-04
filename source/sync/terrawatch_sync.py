#!/usr/bin/env python3
"""Near-real-time data synchronizer for a self-hosted TERRAWATCH instance.

The process deliberately publishes plain files instead of keeping an application
API in the request path.  Nginx can serve the files directly, so visitors still
see the most recent successful snapshot if an upstream source is slow or down.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import logging
import math
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence


PROJECT_DIR = Path(__file__).resolve().parents[1]
SYNC_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SYNC_DIR / "sources.json"
DEFAULT_OUTPUT_DIR = PROJECT_DIR / "public" / "data"
DEFAULT_STATE_DIR = PROJECT_DIR / ".sync-state"
USER_AGENT = "TERRAWATCH-self-hosted-sync/1.0 (+https://github.com/TianyangChen357/TERRAWATCH)"
EVENT_SCHEMA = "terrawatch-events-v1"


class SyncError(RuntimeError):
    """A recoverable source or job failure."""


@dataclass(frozen=True)
class FetchResult:
    changed: bool
    payload: dict[str, Any] | list[Any] | None
    etag: str | None = None
    last_modified: str | None = None


EVENT_VISUALS: dict[str, dict[str, Any]] = {
    "earthquake": {"color": "#ff765f", "label": "地震", "intensity": 0.60},
    "storm": {"color": "#77e4ff", "label": "飓风 / 强风暴", "intensity": 0.78},
    "wildfire": {"color": "#ff914d", "label": "野火", "intensity": 0.72},
    "volcano": {"color": "#d893ff", "label": "火山", "intensity": 0.70},
    "flood": {"color": "#6fa8ff", "label": "洪水", "intensity": 0.66},
    "ice": {"color": "#c9f4ff", "label": "冰雪", "intensity": 0.58},
    "landslide": {"color": "#d6b178", "label": "滑坡", "intensity": 0.58},
    "drought": {"color": "#e9c66e", "label": "干旱", "intensity": 0.58},
    "dust": {"color": "#d7a776", "label": "沙尘", "intensity": 0.58},
    "other": {"color": "#ffcf5c", "label": "自然事件", "intensity": 0.55},
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_time(value: datetime | None = None) -> str:
    return (value or utc_now()).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary_path.replace(path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary_path.unlink()


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write_bytes(
        path,
        (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"),
    )


@contextlib.contextmanager
def exclusive_lock(state_dir: Path) -> Iterator[None]:
    """Prevent overlapping manual runs and the systemd daemon."""

    state_dir.mkdir(parents=True, exist_ok=True)
    lock_path = state_dir / "terrawatch-sync.lock"
    with lock_path.open("w", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SyncError("another TERRAWATCH sync process is already running") from error
        handle.write(str(os.getpid()))
        handle.flush()
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def safe_id(value: str) -> str:
    cleaned = "".join(character if character.isalnum() or character in "-_" else "-" for character in value)
    return cleaned.strip("-") or "source"


def source_cache_path(output_dir: Path, source_id: str) -> Path:
    return output_dir / "raw" / safe_id(source_id) / "latest.json"


def save_source_snapshot(
    output_dir: Path,
    source_id: str,
    payload: dict[str, Any] | list[Any],
    keep: int,
) -> None:
    source_dir = source_cache_path(output_dir, source_id).parent
    latest = source_dir / "latest.json"
    atomic_write_json(latest, payload)
    snapshot = source_dir / f"{utc_now().strftime('%Y%m%dT%H%M%SZ')}.json"
    atomic_write_json(snapshot, payload)
    snapshots = sorted(source_dir.glob("20*.json"), reverse=True)
    for stale_snapshot in snapshots[max(1, keep) :]:
        with contextlib.suppress(OSError):
            stale_snapshot.unlink()


def load_source_snapshot(output_dir: Path, source_id: str) -> dict[str, Any] | list[Any] | None:
    payload = read_json(source_cache_path(output_dir, source_id))
    return payload if isinstance(payload, (dict, list)) else None


def update_feed_state(
    state: dict[str, Any],
    source_id: str,
    *,
    checked_at: str,
    result: FetchResult | None = None,
    error: Exception | None = None,
) -> None:
    feeds = state.setdefault("feeds", {})
    entry = feeds.setdefault(source_id, {})
    entry["last_checked_at"] = checked_at
    if result is not None:
        if result.etag:
            entry["etag"] = result.etag
        if result.last_modified:
            entry["last_modified"] = result.last_modified
        if result.changed:
            entry["last_changed_at"] = checked_at
        entry.pop("last_error", None)
    if error is not None:
        entry["last_error"] = str(error)


def fetch_json(
    feed: Mapping[str, Any],
    previous: Mapping[str, Any] | None,
    *,
    use_conditionals: bool = True,
) -> FetchResult:
    """Fetch one JSON feed, using validators stored from the prior request."""

    url = feed.get("url")
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        raise SyncError(f"feed {feed.get('id', '<unknown>')} has no valid HTTP URL")
    headers = {"Accept": "application/geo+json, application/json;q=0.9, */*;q=0.1", "User-Agent": USER_AGENT}
    if use_conditionals and previous:
        if isinstance(previous.get("etag"), str):
            headers["If-None-Match"] = previous["etag"]
        if isinstance(previous.get("last_modified"), str):
            headers["If-Modified-Since"] = previous["last_modified"]
    request = urllib.request.Request(url, headers=headers)
    max_bytes = int(feed.get("max_bytes", 8 * 1024 * 1024))
    timeout_seconds = float(feed.get("timeout_seconds", 30))
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            content = response.read(max_bytes + 1)
            if len(content) > max_bytes:
                raise SyncError(f"feed {feed.get('id', '<unknown>')} exceeded its {max_bytes} byte limit")
            try:
                payload = json.loads(content.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise SyncError(f"feed {feed.get('id', '<unknown>')} did not return JSON") from error
            if not isinstance(payload, (dict, list)):
                raise SyncError(f"feed {feed.get('id', '<unknown>')} returned an unsupported JSON value")
            return FetchResult(
                changed=True,
                payload=payload,
                etag=response.headers.get("ETag"),
                last_modified=response.headers.get("Last-Modified"),
            )
    except urllib.error.HTTPError as error:
        if error.code == 304:
            return FetchResult(changed=False, payload=None)
        raise SyncError(f"feed {feed.get('id', '<unknown>')} returned HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise SyncError(f"feed {feed.get('id', '<unknown>')} could not be reached: {error.reason}") from error


def number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def point_coordinates(geometry: Any) -> list[float] | None:
    if not isinstance(geometry, Mapping) or geometry.get("type") != "Point":
        return None
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, Sequence) or isinstance(coordinates, (str, bytes)) or len(coordinates) < 2:
        return None
    longitude = number(coordinates[0])
    latitude = number(coordinates[1])
    if longitude is None or latitude is None or not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
        return None
    output = [longitude, latitude]
    depth = number(coordinates[2]) if len(coordinates) > 2 else None
    if depth is not None:
        output.append(depth)
    return output


def classify_event_kind(categories: Sequence[str], title: str) -> str:
    fingerprint = " ".join([*categories, title]).lower()
    checks = (
        ("wildfire", ("wildfire", "wild fire", "forest fire", " fire")),
        ("storm", ("hurricane", "typhoon", "cyclone", "tropical storm", "severe storm", " storm")),
        ("volcano", ("volcano", "volcanic", "eruption")),
        ("flood", ("flood", "inundation")),
        ("ice", ("sea ice", "lake ice", "snow", "iceberg", "glacier")),
        ("landslide", ("landslide", "mudslide")),
        ("drought", ("drought",)),
        ("dust", ("dust", "haze", "sandstorm")),
        ("earthquake", ("earthquake", "seismic")),
    )
    for kind, markers in checks:
        if any(marker in fingerprint for marker in markers):
            return kind
    return "other"


def as_text(value: Any, fallback: str = "") -> str:
    return value.strip() if isinstance(value, str) and value.strip() else fallback


def epoch_to_iso(value: Any) -> str:
    timestamp = number(value)
    if timestamp is None:
        return ""
    return iso_time(datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc))


def normalize_usgs(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, Mapping):
        return []
    features = payload.get("features")
    if not isinstance(features, list):
        return []
    normalized: list[dict[str, Any]] = []
    for index, feature in enumerate(features):
        if not isinstance(feature, Mapping):
            continue
        coordinates = point_coordinates(feature.get("geometry"))
        properties = feature.get("properties") if isinstance(feature.get("properties"), Mapping) else {}
        if coordinates is None:
            continue
        magnitude = number(properties.get("mag"))
        magnitude_text = f"M{magnitude:.1f}" if magnitude is not None else "震级待定"
        place = as_text(properties.get("place"))
        english_title = as_text(properties.get("title"), place or "Earthquake")
        chinese_title = f"{magnitude_text} 地震"
        if place:
            chinese_title = f"{chinese_title} · {place}"
        depth = coordinates[2] if len(coordinates) > 2 else None
        depth_text = f"深度 {depth:.0f} km" if depth is not None else "深度待核实"
        event_id = as_text(feature.get("id"), f"usgs-{index}-{coordinates[0]:.3f}-{coordinates[1]:.3f}")
        intensity = 0.50 if magnitude is None else max(0.36, min(1.0, (magnitude - 3.5) / 4))
        normalized.append(
            {
                "type": "Feature",
                "id": f"usgs-{event_id}",
                "geometry": {"type": "Point", "coordinates": coordinates},
                "properties": {
                    "title": chinese_title,
                    "titleZh": chinese_title,
                    "titleEn": english_title,
                    "kind": "earthquake",
                    "signalId": f"usgs-{event_id}",
                    "effectIntensity": intensity,
                    "sourceLabel": "USGS",
                    "eventColor": EVENT_VISUALS["earthquake"]["color"],
                    "eventTypeLabel": EVENT_VISUALS["earthquake"]["label"],
                    "detail": f"{magnitude_text} · {depth_text}",
                    "detailEn": f"{magnitude_text} · depth {depth:.0f} km" if depth is not None else magnitude_text,
                    "time": epoch_to_iso(properties.get("time")),
                    "updated": epoch_to_iso(properties.get("updated")),
                    "sourceUrl": as_text(properties.get("url")),
                    "place": place,
                },
            }
        )
    return normalized


def eonet_categories(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    categories: list[str] = []
    for category in value:
        if isinstance(category, Mapping):
            title = as_text(category.get("title"))
        else:
            title = as_text(category)
        if title:
            categories.append(title)
    return categories


def eonet_source_url(value: Any, fallback: str) -> str:
    if isinstance(value, list):
        for source in value:
            if isinstance(source, Mapping):
                for key in ("url", "source", "link"):
                    candidate = as_text(source.get(key))
                    if candidate.startswith(("https://", "http://")):
                        return candidate
    return fallback


def normalize_eonet(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, Mapping):
        return []
    features = payload.get("features")
    if not isinstance(features, list):
        return []
    normalized: list[dict[str, Any]] = []
    for index, feature in enumerate(features):
        if not isinstance(feature, Mapping):
            continue
        coordinates = point_coordinates(feature.get("geometry"))
        properties = feature.get("properties") if isinstance(feature.get("properties"), Mapping) else {}
        if coordinates is None:
            continue
        categories = eonet_categories(properties.get("categories"))
        title_en = as_text(properties.get("title"), "Natural event")
        kind = classify_event_kind(categories, title_en)
        visual = EVENT_VISUALS[kind]
        event_id = as_text(feature.get("id"), as_text(properties.get("id"), f"eonet-{index}"))
        title_zh = f"{visual['label']}事件"
        detail_zh = " · ".join(categories) if categories else visual["label"]
        source_url = eonet_source_url(properties.get("sources"), as_text(properties.get("link")))
        normalized.append(
            {
                "type": "Feature",
                "id": f"eonet-{event_id}",
                "geometry": {"type": "Point", "coordinates": coordinates},
                "properties": {
                    "title": title_zh,
                    "titleZh": title_zh,
                    "titleEn": title_en,
                    "kind": kind,
                    "signalId": f"eonet-{event_id}",
                    "effectIntensity": visual["intensity"],
                    "sourceLabel": "NASA EONET",
                    "eventColor": visual["color"],
                    "eventTypeLabel": visual["label"],
                    "detail": detail_zh,
                    "detailEn": " · ".join(categories) if categories else title_en,
                    "time": as_text(properties.get("date")),
                    "sourceUrl": source_url,
                    "categories": categories,
                },
            }
        )
    return normalized


def event_time(feature: Mapping[str, Any]) -> str:
    properties = feature.get("properties")
    return as_text(properties.get("time")) if isinstance(properties, Mapping) else ""


def build_event_collection(usgs: Any, eonet: Any, *, generated_at: str) -> dict[str, Any]:
    features = [*normalize_usgs(usgs), *normalize_eonet(eonet)]
    features.sort(key=event_time, reverse=True)
    return {
        "type": "FeatureCollection",
        "metadata": {
            "schema": EVENT_SCHEMA,
            "generatedAt": generated_at,
            "sources": ["USGS", "NASA EONET"],
            "count": len(features),
        },
        "features": features,
    }


def interval_seconds(job: Mapping[str, Any]) -> int:
    value = job.get("interval_seconds", 4 * 60 * 60)
    try:
        interval = int(value)
    except (TypeError, ValueError) as error:
        raise SyncError(f"job {job.get('id', '<unknown>')} has an invalid interval") from error
    if interval < 60:
        raise SyncError(f"job {job.get('id', '<unknown>')} interval must be at least 60 seconds")
    return interval


def job_due(job: Mapping[str, Any], state: Mapping[str, Any], now: datetime) -> bool:
    job_state = state.get("jobs", {}).get(job.get("id"), {}) if isinstance(state.get("jobs"), Mapping) else {}
    if not isinstance(job_state, Mapping):
        return True
    attempted = parse_iso_time(job_state.get("last_attempt_at"))
    succeeded = parse_iso_time(job_state.get("last_success_at"))
    if succeeded is None:
        retry_seconds = int(job.get("retry_seconds", 15 * 60))
        return attempted is None or (now - attempted).total_seconds() >= retry_seconds
    return (now - succeeded).total_seconds() >= interval_seconds(job)


def sync_events(
    job: Mapping[str, Any],
    state: dict[str, Any],
    output_dir: Path,
) -> dict[str, Any]:
    feeds = job.get("feeds")
    if not isinstance(feeds, list) or not feeds:
        raise SyncError("the events job needs at least one feed")
    raw_payloads: dict[str, Any] = {}
    errors: list[str] = []
    changed_feeds: list[str] = []
    generated_at = iso_time()
    keep = int(job.get("keep_raw_snapshots", 30))
    feed_state = state.setdefault("feeds", {})
    for feed in feeds:
        if not isinstance(feed, Mapping):
            continue
        source_id = as_text(feed.get("id"))
        if not source_id:
            raise SyncError("an events feed is missing an id")
        previous = feed_state.get(source_id) if isinstance(feed_state.get(source_id), Mapping) else None
        try:
            result = fetch_json(feed, previous)
            if not result.changed and load_source_snapshot(output_dir, source_id) is None:
                result = fetch_json(feed, previous, use_conditionals=False)
            update_feed_state(state, source_id, checked_at=generated_at, result=result)
            if result.changed and result.payload is not None:
                save_source_snapshot(output_dir, source_id, result.payload, keep)
                changed_feeds.append(source_id)
            raw_payloads[source_id] = result.payload if result.changed else load_source_snapshot(output_dir, source_id)
        except SyncError as error:
            update_feed_state(state, source_id, checked_at=generated_at, error=error)
            cached = load_source_snapshot(output_dir, source_id)
            if cached is not None:
                raw_payloads[source_id] = cached
                errors.append(f"{source_id}: {error}; using last successful snapshot")
            else:
                errors.append(f"{source_id}: {error}")

    usgs = raw_payloads.get("usgs")
    eonet = raw_payloads.get("eonet")
    if usgs is None and eonet is None:
        raise SyncError("no events feed is available and no prior snapshot exists")
    collection = build_event_collection(usgs or {}, eonet or {}, generated_at=generated_at)
    collection["metadata"]["sourceErrors"] = errors
    output_name = as_text(job.get("output"), "events-latest.geojson")
    atomic_write_json(output_dir / output_name, collection)
    return {
        "output": output_name,
        "count": len(collection["features"]),
        "changed_feeds": changed_feeds,
        "warnings": errors,
    }


def expanded_command(command: Any, output_dir: Path) -> list[str]:
    if not isinstance(command, list) or not command or not all(isinstance(item, str) for item in command):
        raise SyncError("a command job needs a non-empty command array")
    substitutions = {
        "project_dir": str(PROJECT_DIR),
        "output_dir": str(output_dir),
        "python": sys.executable,
    }
    try:
        return [item.format(**substitutions) for item in command]
    except KeyError as error:
        raise SyncError(f"unsupported command placeholder {error}") from error


def sync_command(job: Mapping[str, Any], output_dir: Path) -> dict[str, Any]:
    command = expanded_command(job.get("command"), output_dir)
    timeout_seconds = int(job.get("timeout_seconds", 15 * 60))
    environment = os.environ.copy()
    environment["TERRAWATCH_DATA_DIR"] = str(output_dir)
    completed = subprocess.run(
        command,
        cwd=PROJECT_DIR,
        env=environment,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    if completed.returncode != 0:
        message = (completed.stderr or completed.stdout or "command failed").strip()
        raise SyncError(f"command exited with {completed.returncode}: {message[-1200:]}")
    output_names = job.get("outputs", [])
    if not isinstance(output_names, list):
        raise SyncError("command outputs must be an array")
    missing = [name for name in output_names if not isinstance(name, str) or not (output_dir / name).is_file()]
    if missing:
        raise SyncError(f"command completed without expected output: {', '.join(map(str, missing))}")
    return {"outputs": output_names, "log": (completed.stdout or "").strip()[-1200:]}


def run_job(job: Mapping[str, Any], state: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    job_type = as_text(job.get("type"))
    if job_type == "events":
        return sync_events(job, state, output_dir)
    if job_type == "command":
        return sync_command(job, output_dir)
    raise SyncError(f"unsupported job type {job_type!r}")


def public_entry(entry: Any, *, feed: bool) -> dict[str, Any]:
    if not isinstance(entry, Mapping):
        return {}
    fields = ["last_attempt_at", "last_success_at", "last_checked_at", "last_changed_at"]
    if feed:
        fields.extend(["etag", "last_modified"])
    output = {field: entry[field] for field in fields if isinstance(entry.get(field), str)}
    if entry.get("last_error"):
        output["last_error"] = "latest update failed; serving the last successful snapshot when available"
    return output


def public_status(state: Mapping[str, Any], results: Mapping[str, Any], output_dir: Path) -> None:
    raw_jobs = state.get("jobs", {}) if isinstance(state.get("jobs"), Mapping) else {}
    raw_feeds = state.get("feeds", {}) if isinstance(state.get("feeds"), Mapping) else {}
    jobs = {str(job_id): public_entry(entry, feed=False) for job_id, entry in raw_jobs.items()}
    feeds = {str(feed_id): public_entry(entry, feed=True) for feed_id, entry in raw_feeds.items()}
    public_results: dict[str, dict[str, Any]] = {}
    for job_id, result in results.items():
        if not isinstance(result, Mapping):
            continue
        public_results[str(job_id)] = {
            key: value
            for key, value in result.items()
            if key not in {"log", "error"}
        }
        if result.get("error"):
            public_results[str(job_id)]["error"] = "latest update failed; see server logs"
    atomic_write_json(
        output_dir / "status.json",
        {
            "schema": "terrawatch-sync-status-v1",
            "generatedAt": iso_time(),
            "jobs": jobs,
            "feeds": feeds,
            "latestRun": public_results,
        },
    )


def run_due_jobs(
    config: Mapping[str, Any],
    state: dict[str, Any],
    output_dir: Path,
    *,
    force: bool,
) -> dict[str, Any]:
    jobs = config.get("jobs")
    if not isinstance(jobs, list):
        raise SyncError("config needs a jobs array")
    results: dict[str, Any] = {}
    now = utc_now()
    state_jobs = state.setdefault("jobs", {})
    for job in jobs:
        if not isinstance(job, Mapping) or job.get("enabled", True) is False:
            continue
        job_id = as_text(job.get("id"))
        if not job_id:
            raise SyncError("every enabled job needs an id")
        if not force and not job_due(job, state, now):
            continue
        job_state = state_jobs.setdefault(job_id, {})
        job_state["last_attempt_at"] = iso_time()
        try:
            logging.info("syncing %s", job_id)
            result = run_job(job, state, output_dir)
            job_state["last_success_at"] = iso_time()
            job_state.pop("last_error", None)
            results[job_id] = {"ok": True, **result}
            logging.info("finished %s", job_id)
        except (SyncError, subprocess.TimeoutExpired, OSError) as error:
            job_state["last_error"] = str(error)
            results[job_id] = {"ok": False, "error": str(error)}
            logging.error("%s failed: %s", job_id, error)
    return results


def next_wait_seconds(config: Mapping[str, Any], state: Mapping[str, Any]) -> float:
    jobs = config.get("jobs", [])
    now = utc_now()
    waiting: list[float] = [60.0]
    if not isinstance(jobs, list):
        return waiting[0]
    state_jobs = state.get("jobs", {}) if isinstance(state.get("jobs"), Mapping) else {}
    for job in jobs:
        if not isinstance(job, Mapping) or job.get("enabled", True) is False:
            continue
        job_state = state_jobs.get(job.get("id"), {}) if isinstance(state_jobs, Mapping) else {}
        if not isinstance(job_state, Mapping):
            return 1.0
        succeeded = parse_iso_time(job_state.get("last_success_at"))
        attempted = parse_iso_time(job_state.get("last_attempt_at"))
        if succeeded is None:
            due_at = (attempted or now).timestamp() + int(job.get("retry_seconds", 15 * 60))
        else:
            due_at = succeeded.timestamp() + interval_seconds(job)
        waiting.append(max(1.0, due_at - now.timestamp()))
    return min(waiting)


def load_config(path: Path) -> dict[str, Any]:
    config = read_json(path)
    if not isinstance(config, dict):
        raise SyncError(f"cannot read configuration from {path}")
    if not isinstance(config.get("jobs"), list):
        raise SyncError("configuration must contain a jobs array")
    return config


def run_once(config: dict[str, Any], state_path: Path, output_dir: Path, *, force: bool) -> int:
    state = read_json(state_path, {})
    if not isinstance(state, dict):
        state = {}
    results = run_due_jobs(config, state, output_dir, force=force)
    atomic_write_json(state_path, state)
    public_status(state, results, output_dir)
    return 1 if any(not result.get("ok", False) for result in results.values()) else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(os.environ.get("TERRAWATCH_DATA_DIR", DEFAULT_OUTPUT_DIR)),
        help="Directory Nginx exposes as /data/.",
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path(os.environ.get("TERRAWATCH_STATE_DIR", DEFAULT_STATE_DIR)),
        help="Private state and lock directory; do not expose it over HTTP.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="Run currently due jobs and exit (the default).")
    mode.add_argument("--daemon", action="store_true", help="Keep scheduling jobs until stopped.")
    parser.add_argument("--force", action="store_true", help="Run every enabled job immediately in --once mode.")
    parser.add_argument("--no-initial-sync", action="store_true", help="In daemon mode, wait until jobs are due before the first sync.")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    config = load_config(args.config)
    output_dir = args.output_dir.resolve()
    state_dir = args.state_dir.resolve()
    state_path = state_dir / "state.json"
    output_dir.mkdir(parents=True, exist_ok=True)

    stop_requested = False

    def request_stop(_signum: int, _frame: Any) -> None:
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    try:
        with exclusive_lock(state_dir):
            if not args.daemon:
                return run_once(config, state_path, output_dir, force=args.force)
            state = read_json(state_path, {})
            if not isinstance(state, dict):
                state = {}
            if not args.no_initial_sync:
                results = run_due_jobs(config, state, output_dir, force=True)
                atomic_write_json(state_path, state)
                public_status(state, results, output_dir)
            while not stop_requested:
                wait_seconds = next_wait_seconds(config, state)
                deadline = time.monotonic() + wait_seconds
                while not stop_requested and time.monotonic() < deadline:
                    time.sleep(max(0.01, min(1.0, deadline - time.monotonic())))
                if stop_requested:
                    break
                results = run_due_jobs(config, state, output_dir, force=False)
                atomic_write_json(state_path, state)
                public_status(state, results, output_dir)
    except SyncError as error:
        logging.error("%s", error)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
