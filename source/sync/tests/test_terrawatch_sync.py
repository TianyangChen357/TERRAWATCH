from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SYNC_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SYNC_DIR))

import terrawatch_sync as sync  # noqa: E402


class EventNormalizationTests(unittest.TestCase):
    def test_usgs_event_is_localized_and_keeps_source_fields(self) -> None:
        payload = {
            "features": [
                {
                    "id": "us7000test",
                    "geometry": {"type": "Point", "coordinates": [142.2, 36.1, 12.4]},
                    "properties": {
                        "mag": 5.3,
                        "place": "124 km E of Sendai, Japan",
                        "title": "M 5.3 - 124 km E of Sendai, Japan",
                        "time": 1780000000000,
                        "updated": 1780000010000,
                        "url": "https://earthquake.usgs.gov/example",
                    },
                }
            ]
        }

        event = sync.normalize_usgs(payload)[0]

        self.assertEqual(event["properties"]["kind"], "earthquake")
        self.assertEqual(event["properties"]["eventTypeLabel"], "地震")
        self.assertIn("M5.3 地震", event["properties"]["title"])
        self.assertEqual(event["properties"]["titleEn"], "M 5.3 - 124 km E of Sendai, Japan")
        self.assertEqual(event["properties"]["sourceLabel"], "USGS")

    def test_eonet_geojson_uses_chinese_display_title(self) -> None:
        payload = {
            "features": [
                {
                    "id": "EONET_123",
                    "geometry": {"type": "Point", "coordinates": [-121.5, 38.5]},
                    "properties": {
                        "title": "Wildfire in California",
                        "date": "2026-08-04T12:00:00Z",
                        "categories": [{"title": "Wildfires"}],
                        "sources": [{"url": "https://example.org/fire"}],
                    },
                }
            ]
        }

        event = sync.normalize_eonet(payload)[0]

        self.assertEqual(event["properties"]["kind"], "wildfire")
        self.assertEqual(event["properties"]["title"], "野火事件")
        self.assertEqual(event["properties"]["titleEn"], "Wildfire in California")
        self.assertEqual(event["properties"]["sourceUrl"], "https://example.org/fire")

    def test_non_point_events_are_left_out_of_map_output(self) -> None:
        payload = {
            "features": [
                {
                    "id": "polygon",
                    "geometry": {"type": "Polygon", "coordinates": []},
                    "properties": {"title": "Wildfire", "categories": [{"title": "Wildfires"}]},
                }
            ]
        }
        self.assertEqual(sync.normalize_eonet(payload), [])


class SchedulerTests(unittest.TestCase):
    def test_job_is_due_after_its_configured_interval(self) -> None:
        now = datetime(2026, 8, 4, 12, tzinfo=timezone.utc)
        job = {"id": "events", "interval_seconds": 4 * 60 * 60}
        state = {"jobs": {"events": {"last_success_at": sync.iso_time(now - timedelta(hours=4, minutes=1))}}}
        self.assertTrue(sync.job_due(job, state, now))

    def test_job_waits_until_its_configured_interval(self) -> None:
        now = datetime(2026, 8, 4, 12, tzinfo=timezone.utc)
        job = {"id": "currents", "interval_seconds": 24 * 60 * 60}
        state = {"jobs": {"currents": {"last_success_at": sync.iso_time(now - timedelta(hours=6))}}}
        self.assertFalse(sync.job_due(job, state, now))

    def test_public_status_redacts_internal_failure_text(self) -> None:
        state = {
            "jobs": {"currents": {"last_error": "token=secret-value", "last_success_at": "2026-08-04T00:00:00Z"}},
            "feeds": {"usgs": {"last_error": "internal URL detail", "etag": "abc"}},
        }
        with tempfile.TemporaryDirectory() as temporary:
            output_dir = Path(temporary)
            sync.public_status(state, {"currents": {"ok": False, "error": "token=secret-value"}}, output_dir)
            public = (output_dir / "status.json").read_text(encoding="utf-8")

        self.assertNotIn("secret-value", public)
        self.assertNotIn("internal URL detail", public)
        self.assertIn("latest update failed", public)


if __name__ == "__main__":
    unittest.main()
