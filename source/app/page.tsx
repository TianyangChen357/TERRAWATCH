"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type ChannelId = "satellite" | "cloud" | "rain" | "heat" | "wind" | "currents" | "events";

type Channel = {
  id: ChannelId;
  code: string;
  name: string;
  subtitle: string;
  source: string;
  latency: string;
  color: string;
  layer?: {
    id: string;
    matrix: string;
    format: "jpg" | "png";
    opacity: number;
  };
};

type SelectedEvent = {
  id: string;
  title: string;
  meta: string;
  detail: string;
  source: string;
  kindLabel: string;
};

type EffectMode = "rain" | "heat" | "events";

type EventKind =
  | "earthquake"
  | "storm"
  | "wildfire"
  | "volcano"
  | "flood"
  | "ice"
  | "landslide"
  | "drought"
  | "dust"
  | "other";

type SignalAnchor = {
  id: string;
  lng: number;
  lat: number;
  intensity: number;
  phase: number;
  kind?: EventKind;
};

type RegionView = {
  label: string;
  code: string;
  center: [number, number];
  zoom: number;
  world?: boolean;
  cells: Array<[number, number]>;
};

type MapContainerElement = HTMLDivElement & {
  __terrawatchMap?: MapLibreMap;
};

type TerraWatchRuntimeConfig = {
  selfHostedData?: boolean;
  selfHostedTiles?: boolean;
  dataOrigin?: string;
};

function runtimeConfig(): TerraWatchRuntimeConfig {
  if (typeof window === "undefined") return {};
  const config = (window as Window & { TERRAWATCH_CONFIG?: unknown }).TERRAWATCH_CONFIG;
  return config && typeof config === "object" ? (config as TerraWatchRuntimeConfig) : {};
}

function dataOriginPath(path: string) {
  const origin = runtimeConfig().dataOrigin?.trim().replace(/\/$/, "");
  return origin ? `${origin}${path}` : path;
}

function selfHostedDataEnabled() {
  return runtimeConfig().selfHostedData === true;
}

function selfHostedTilesEnabled() {
  return runtimeConfig().selfHostedTiles === true;
}

function localDataFile(filename: string) {
  return dataOriginPath(`/data/${filename}`);
}

const CHANNELS: Channel[] = [
  {
    id: "events",
    code: "01",
    name: "地球事件",
    subtitle: "EARTH EVENTS",
    source: "USGS + NASA EONET",
    latency: "实时流 / 人工整理源并存",
    color: "#ffcf5c",
  },
  {
    id: "cloud",
    code: "02",
    name: "实时云层",
    subtitle: "LIVE CLOUDS",
    source: "NASA GIBS · VIIRS",
    latency: "近实时 · 每日更新",
    color: "#d5e8ee",
    layer: {
      id: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
      matrix: "GoogleMapsCompatible_Level9",
      format: "jpg",
      opacity: 1,
    },
  },
  {
    id: "rain",
    code: "03",
    name: "全球降水",
    subtitle: "GLOBAL PRECIPITATION",
    source: "NASA GIBS · IMERG",
    latency: "近实时 · 约半小时级产品",
    color: "#78a8ff",
    layer: {
      id: "IMERG_Precipitation_Rate",
      matrix: "GoogleMapsCompatible_Level6",
      format: "png",
      opacity: 0.86,
    },
  },
  {
    id: "heat",
    code: "04",
    name: "地表温度",
    subtitle: "LAND SURFACE TEMPERATURE",
    source: "NASA GIBS · MODIS TERRA",
    latency: "近实时 · 日间过境",
    color: "#ff9b68",
    layer: {
      id: "MODIS_Terra_Land_Surface_Temp_Day",
      matrix: "GoogleMapsCompatible_Level7",
      format: "png",
      opacity: 0.82,
    },
  },
  {
    id: "wind",
    code: "05",
    name: "全球风场",
    subtitle: "NOAA GLOBAL WIND",
    source: "NOAA GFS · 10 M WIND",
    latency: "模式分析 · 每日四次更新",
    color: "#70f0ca",
  },
  {
    id: "currents",
    code: "06",
    name: "表层洋流",
    subtitle: "OCEAN SURFACE CURRENTS",
    source: "NASA/JPL · OSCAR NRT",
    latency: "近实时分析 · 约两天延迟",
    color: "#55c9ff",
  },
];

type GridSpan = readonly [row: number, startColumn: number, endColumn: number];

function expandGridSpans(spans: readonly GridSpan[]) {
  const cells: Array<[number, number]> = [];
  spans.forEach(([row, startColumn, endColumn]) => {
    for (let column = startColumn; column <= endColumn; column += 1) {
      cells.push([column, row]);
    }
  });
  return cells;
}

const REGION_VIEWS: RegionView[] = [
  {
    label: "全球",
    code: "WORLD",
    center: [180, 8] as [number, number],
    zoom: 1.52,
    world: true,
    cells: [],
  },
  {
    label: "亚洲",
    code: "ASIA",
    center: [93, 34] as [number, number],
    zoom: 2.45,
    cells: expandGridSpans([
      [1, 23, 29],
      [2, 20, 31],
      [3, 22, 34],
      [4, 22, 34],
      [5, 21, 33],
      [6, 21, 32],
      [7, 22, 31],
      [8, 23, 29],
      [9, 25, 28],
    ]),
  },
  {
    label: "欧洲",
    code: "EUROPE",
    center: [16, 51] as [number, number],
    zoom: 3.05,
    cells: expandGridSpans([
      [2, 16, 19],
      [3, 16, 21],
      [4, 17, 21],
      [5, 17, 20],
      [6, 18, 20],
    ]),
  },
  {
    label: "非洲",
    code: "AFRICA",
    center: [20, 3] as [number, number],
    zoom: 2.55,
    cells: expandGridSpans([
      [6, 16, 17],
      [7, 15, 21],
      [8, 15, 22],
      [9, 16, 22],
      [10, 17, 22],
      [11, 18, 21],
      [12, 18, 20],
      [13, 19, 19],
    ]),
  },
  {
    label: "北美",
    code: "N. AMERICA",
    center: [-104, 43] as [number, number],
    zoom: 2.45,
    cells: expandGridSpans([
      [1, 10, 13],
      [2, 2, 8],
      [2, 10, 13],
      [3, 1, 12],
      [4, 1, 11],
      [5, 2, 11],
      [6, 3, 10],
      [7, 5, 9],
      [8, 7, 9],
    ]),
  },
  {
    label: "南美",
    code: "S. AMERICA",
    center: [-60, -17] as [number, number],
    zoom: 2.55,
    cells: expandGridSpans([
      [8, 10, 11],
      [9, 10, 14],
      [10, 11, 15],
      [11, 12, 15],
      [12, 12, 14],
      [13, 13, 14],
      [14, 13, 13],
      [15, 13, 13],
    ]),
  },
  {
    label: "大洋洲",
    code: "OCEANIA",
    center: [140, -25] as [number, number],
    zoom: 2.75,
    cells: expandGridSpans([
      [9, 29, 30],
      [10, 28, 30],
      [11, 28, 32],
      [12, 28, 33],
      [13, 29, 34],
      [14, 30, 33],
      [15, 34, 34],
    ]),
  },
  {
    label: "南极",
    code: "ANTARCTICA",
    center: [15, -72] as [number, number],
    zoom: 2.1,
    cells: expandGridSpans([
      [16, 0, 35],
      [17, 2, 33],
    ]),
  },
];

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const ANALYSIS_WIDTH = 720;
const ANALYSIS_HEIGHT = 340;
const SIGNAL_CACHE_LIMIT = 24;
const rasterSignalCache = new Map<string, SignalAnchor[]>();
const CHANNEL_COUNT = CHANNELS.length;
const PACIFIC_GRID_SHIFT = 20;

const EVENT_VISUALS: Record<
  EventKind,
  { color: string; rgb: [number, number, number]; label: string }
> = {
  earthquake: {
    color: "#ff765f",
    rgb: [255, 118, 95],
    label: "地震",
  },
  storm: {
    color: "#77e4ff",
    rgb: [119, 228, 255],
    label: "飓风 / 强风暴",
  },
  wildfire: {
    color: "#ff914d",
    rgb: [255, 145, 77],
    label: "野火",
  },
  volcano: {
    color: "#d893ff",
    rgb: [216, 147, 255],
    label: "火山",
  },
  flood: {
    color: "#6fa8ff",
    rgb: [111, 168, 255],
    label: "洪水",
  },
  ice: {
    color: "#c9f4ff",
    rgb: [201, 244, 255],
    label: "冰雪",
  },
  landslide: {
    color: "#d6b178",
    rgb: [214, 177, 120],
    label: "滑坡",
  },
  drought: {
    color: "#e9c66e",
    rgb: [233, 198, 110],
    label: "干旱",
  },
  dust: {
    color: "#d7a776",
    rgb: [215, 167, 118],
    label: "沙尘",
  },
  other: {
    color: "#ffcf5c",
    rgb: [255, 207, 92],
    label: "自然事件",
  },
};

let liveMap: MapLibreMap | null = null;

function modulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function classifyEventKind(categoryTitles: string[], title: string): EventKind {
  const fingerprint = [...categoryTitles, title].join(" ").toLowerCase();

  if (/wildfire|wild fire|forest fire|\bfire\b/.test(fingerprint)) {
    return "wildfire";
  }
  if (
    /hurricane|typhoon|cyclone|tropical storm|severe storm|\bstorm\b/.test(
      fingerprint,
    )
  ) {
    return "storm";
  }
  if (/volcano|volcanic|eruption/.test(fingerprint)) return "volcano";
  if (/flood|inundation/.test(fingerprint)) return "flood";
  if (/sea.*ice|lake.*ice|snow|iceberg|glacier/.test(fingerprint)) return "ice";
  if (/landslide|mudslide/.test(fingerprint)) return "landslide";
  if (/drought/.test(fingerprint)) return "drought";
  if (/dust|haze|sandstorm/.test(fingerprint)) return "dust";
  if (/earthquake|seismic/.test(fingerprint)) return "earthquake";
  return "other";
}

function normalizeEventKind(value: unknown): EventKind {
  return typeof value === "string" && value in EVENT_VISUALS
    ? (value as EventKind)
    : "other";
}

function utcDate(daysAgo = 2) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function gibsTiles(layer: NonNullable<Channel["layer"]>, date: string) {
  const path = `wmts/epsg3857/best/${layer.id}/default/${date}/${layer.matrix}/{z}/{y}/{x}.${layer.format}`;
  if (selfHostedTilesEnabled()) {
    return [dataOriginPath(`/tiles/gibs/${path}`)];
  }
  return ["a", "b", "c"].map(
    (server) => `https://gibs-${server}.earthdata.nasa.gov/${path}`,
  );
}

function blueMarbleTiles() {
  const path =
    "wmts/epsg3857/best/BlueMarble_NextGeneration/default/500m/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg";
  if (selfHostedTilesEnabled()) {
    return [dataOriginPath(`/tiles/gibs/${path}`)];
  }
  return ["a", "b", "c"].map(
    (server) => `https://gibs-${server}.earthdata.nasa.gov/${path}`,
  );
}

function cartoLabelTiles() {
  if (selfHostedTilesEnabled()) {
    return [dataOriginPath("/tiles/carto/{z}/{x}/{y}@2x.png")];
  }
  return [
    "https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png",
    "https://b.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png",
    "https://c.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png",
  ];
}

function gibsWmsUrl(params: URLSearchParams) {
  const path = `/wms/epsg4326/best/wms.cgi?${params.toString()}`;
  return selfHostedTilesEnabled()
    ? dataOriginPath(`/tiles/gibs${path}`)
    : `https://gibs.earthdata.nasa.gov${path}`;
}

function gibsAnalysisImage(
  layer: NonNullable<Channel["layer"]>,
  date: string,
) {
  const params = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.1.1",
    LAYERS: layer.id,
    STYLES: "",
    FORMAT: "image/png",
    TRANSPARENT: "true",
    WIDTH: String(ANALYSIS_WIDTH),
    HEIGHT: String(ANALYSIS_HEIGHT),
    SRS: "EPSG:4326",
    BBOX: "-180,-85,180,85",
    TIME: date,
  });
  return gibsWmsUrl(params);
}

function hashUnit(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function rgbToHsv(red: number, green: number, blue: number) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;

  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;

  return {
    hue,
    saturation: max === 0 ? 0 : delta / max,
    value: max,
  };
}

function rasterSignalIntensity(
  mode: Extract<EffectMode, "rain" | "heat">,
  red: number,
  green: number,
  blue: number,
  alpha: number,
) {
  if (alpha < 50) return 0;
  const { hue, saturation, value } = rgbToHsv(red, green, blue);
  if (saturation < 0.18 || value < 0.12) return 0;

  if (mode === "heat") {
    const warmHue =
      hue <= 72 ? 1 - hue / 150 : hue >= 338 ? 0.92 : 0;
    return warmHue * saturation * Math.min(1, value * 1.12);
  }

  // IMERG's visible color ramp progresses through saturated cool and warm
  // colors. Warm/magenta bins receive the strongest visual emphasis, while
  // cool bins remain present but deliberately quieter.
  const paletteWeight =
    hue <= 68
      ? 1
      : hue <= 165
        ? 0.72
        : hue <= 235
          ? 0.42
          : hue <= 315
            ? 0.68
            : 0.94;
  return paletteWeight * saturation * Math.min(1, value * 1.08);
}

function analyzeRasterSignals(
  image: ImageBitmap,
  mode: Extract<EffectMode, "rain" | "heat">,
) {
  const canvas = document.createElement("canvas");
  canvas.width = ANALYSIS_WIDTH;
  canvas.height = ANALYSIS_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(image, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  const pixels = context.getImageData(
    0,
    0,
    ANALYSIS_WIDTH,
    ANALYSIS_HEIGHT,
  ).data;
  const candidates: SignalAnchor[] = [];
  const sampleStep = mode === "rain" ? 2 : 3;
  const threshold = mode === "heat" ? 0.33 : 0.42;

  for (let y = 1; y < ANALYSIS_HEIGHT; y += sampleStep) {
    for (let x = 1; x < ANALYSIS_WIDTH; x += sampleStep) {
      const offset = (y * ANALYSIS_WIDTH + x) * 4;
      const intensity = rasterSignalIntensity(
        mode,
        pixels[offset],
        pixels[offset + 1],
        pixels[offset + 2],
        pixels[offset + 3],
      );
      if (intensity < threshold) continue;

      const lng = -180 + ((x + 0.5) / ANALYSIS_WIDTH) * 360;
      const lat = 85 - ((y + 0.5) / ANALYSIS_HEIGHT) * 170;
      const id = `${mode}-${x}-${y}`;
      candidates.push({
        id,
        lng,
        lat,
        intensity,
        phase: hashUnit(id),
      });
    }
  }

  candidates.sort((first, second) => second.intensity - first.intensity);
  const anchors: SignalAnchor[] = [];
  const separation = mode === "heat" ? 2.5 : 1.55;
  const maxAnchors = mode === "heat" ? 200 : 280;

  for (const candidate of candidates) {
    const separated = anchors.every((anchor) => {
      const longitudeDistance =
        Math.abs(wrapLongitude(candidate.lng - anchor.lng)) *
        Math.cos((candidate.lat * Math.PI) / 180);
      return (
        Math.hypot(longitudeDistance, candidate.lat - anchor.lat) >= separation
      );
    });
    if (!separated) continue;
    anchors.push(candidate);
    if (anchors.length >= maxAnchors) break;
  }

  return anchors;
}

function WorldRegionNavigator({
  onFocus,
}: {
  onFocus: (region: RegionView) => void;
}) {
  const [hoveredRegion, setHoveredRegion] = useState<RegionView | null>(null);
  const worldView = REGION_VIEWS[0];
  const continents = REGION_VIEWS.slice(1);

  const activateWithKeyboard = (
    event: React.KeyboardEvent<SVGGElement>,
    region: RegionView,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onFocus(region);
  };

  return (
    <div className="world-navigator-shell">
      <svg
        className="world-navigator-map"
        viewBox="0 0 360 180"
        role="group"
        aria-label="太平洋居中的世界方格导航图；悬停高亮洲，点击缩放"
      >
        <defs>
          <pattern
            id="world-grid-pattern"
            width="10"
            height="10"
            patternUnits="userSpaceOnUse"
          >
            <rect className="world-grid-cell" x="1.2" y="1.2" width="7.6" height="7.6" rx="0.8" />
          </pattern>
        </defs>
        <rect className="world-grid-field" x="0" y="0" width="360" height="180" />
        <path className="world-grid-axis" d="M0 90H360M180 0V180" />
        <rect className="world-frame" x="0.5" y="0.5" width="359" height="179" rx="3" />
        {continents.map((region) => (
          <g
            key={region.code}
            className={`world-region${
              hoveredRegion?.code === region.code ? " active" : ""
            }`}
            role="button"
            tabIndex={0}
            aria-label={`缩放至${region.label}`}
            onMouseEnter={() => setHoveredRegion(region)}
            onMouseLeave={() => setHoveredRegion(null)}
            onFocus={() => setHoveredRegion(region)}
            onBlur={() => setHoveredRegion(null)}
            onClick={() => {
              setHoveredRegion(region);
              onFocus(region);
            }}
            onKeyDown={(event) => activateWithKeyboard(event, region)}
          >
            <title>{region.label}</title>
            {region.cells.map(([column, row], index) => (
              <rect
                key={`${column}-${row}`}
                x={
                  modulo(
                    column +
                      PACIFIC_GRID_SHIFT +
                      (region.code === "AFRICA" ? 1 : 0),
                    36,
                  ) *
                    10 +
                  1.2
                }
                y={row * 10 + 1.2}
                width="7.6"
                height="7.6"
                rx="0.8"
                style={
                  {
                    "--cell-delay": `${((column + row + index) % 7) * 22}ms`,
                  } as React.CSSProperties
                }
              />
            ))}
          </g>
        ))}
      </svg>
      <div className="world-navigator-status" aria-live="polite">
        <span className="world-navigator-copy">
          <b>{hoveredRegion ? `洲际目标 · ${hoveredRegion.label}` : "悬停选择洲际目标"}</b>
          <small>
            {hoveredRegion
              ? `${hoveredRegion.code} · CLICK TO ZOOM`
              : "HOVER TO SELECT · PACIFIC CENTER"}
          </small>
        </span>
        <button
          className="world-reset"
          type="button"
          onClick={() => {
            setHoveredRegion(null);
            onFocus(worldView);
          }}
          aria-label="返回太平洋居中的全球视角"
          title="全球视角 / Global view"
        >
          <i aria-hidden="true">◎</i>
          <span>全球</span>
        </button>
      </div>
    </div>
  );
}

function ChannelSignalIcon({ channel }: { channel: ChannelId }) {
  return (
    <span
      className={`channel-signal-icon signal-icon-${channel}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 40 40" focusable="false">
        {channel === "satellite" && (
          <>
            <g className="signal-orbit">
              <ellipse
                className="signal-stroke"
                cx="20"
                cy="20"
                rx="15"
                ry="6"
                transform="rotate(-28 20 20)"
              />
              <circle
                className="signal-fill signal-orbit-node"
                cx="33"
                cy="12"
                r="2.1"
              />
            </g>
            <circle className="signal-stroke" cx="20" cy="20" r="8" />
            <path
              className="signal-stroke signal-satellite-scan"
              d="M12 20h16M20 12c-3 3.2-4.2 6-4.2 8s1.2 4.8 4.2 8M20 12c3 3.2 4.2 6 4.2 8s-1.2 4.8-4.2 8"
            />
          </>
        )}
        {channel === "cloud" && (
          <>
            <path
              className="signal-stroke signal-cloud-body"
              d="M9 24.5h21.5c2.6 0 4.5-1.7 4.5-4.1 0-2.2-1.8-4-4.2-4.1-.8-4.1-4.1-6.7-8-6.2-3.1.4-5.3 2.3-6.1 5.1-3.7-.8-6.9 1.5-7.7 4.6-.4 1.6-.1 3.2 0 4.7Z"
            />
            <path
              className="signal-stroke signal-cloud-wisp signal-cloud-wisp-a"
              d="M7 29h17"
            />
            <path
              className="signal-stroke signal-cloud-wisp signal-cloud-wisp-b"
              d="M15 33h18"
            />
          </>
        )}
        {channel === "rain" && (
          <>
            <path className="signal-stroke signal-rain-cloud" d="M8 14h24" />
            <g className="signal-rain-drops">
              <path className="signal-stroke" d="M13 18 9 28" />
              <path className="signal-stroke" d="m22 17-4 12" />
              <path className="signal-stroke" d="m31 18-4 10" />
              <circle className="signal-fill" cx="9" cy="29.5" r="1.5" />
              <circle className="signal-fill" cx="18" cy="30.5" r="1.5" />
              <circle className="signal-fill" cx="27" cy="29.5" r="1.5" />
            </g>
            <ellipse
              className="signal-stroke signal-rain-ripple"
              cx="18"
              cy="34"
              rx="10"
              ry="2.5"
            />
          </>
        )}
        {channel === "heat" && (
          <>
            <circle
              className="signal-fill signal-heat-core"
              cx="20"
              cy="30"
              r="3.2"
            />
            <path
              className="signal-stroke signal-heat-wave signal-heat-wave-a"
              d="M11 30c-4-5 5-7 1-13s3-8 2-11"
            />
            <path
              className="signal-stroke signal-heat-wave signal-heat-wave-b"
              d="M20 30c-4-5 5-8 1-14s3-7 2-11"
            />
            <path
              className="signal-stroke signal-heat-wave signal-heat-wave-c"
              d="M29 30c-4-5 5-7 1-13s3-8 2-11"
            />
          </>
        )}
        {(channel === "wind" || channel === "currents") && (
          <>
            <path
              className="signal-stroke signal-wind-line signal-wind-line-a"
              d="M5 14c8-7 15 4 23-1 4-2 6-1 7 1"
            />
            <path
              className="signal-stroke signal-wind-line signal-wind-line-b"
              d="M4 22c7-5 13 4 21 0 6-3 9-2 11 1"
            />
            <path
              className="signal-stroke signal-wind-line signal-wind-line-c"
              d="M8 30c7-4 11 2 17 0 4-2 7-1 8 0"
            />
          </>
        )}
        {channel === "events" && (
          <>
            <circle
              className="signal-stroke signal-event-ring signal-event-ring-a"
              cx="20"
              cy="20"
              r="7"
            />
            <circle
              className="signal-stroke signal-event-ring signal-event-ring-b"
              cx="20"
              cy="20"
              r="13"
            />
            <path
              className="signal-stroke signal-event-cross"
              d="M20 3v7M20 30v7M3 20h7M30 20h7"
            />
            <circle
              className="signal-fill signal-event-core"
              cx="20"
              cy="20"
              r="3"
            />
          </>
        )}
      </svg>
    </span>
  );
}

type WindParticle = {
  x: number;
  y: number;
  age: number;
  life: number;
  pace: number;
};

function wrapLongitude(value: number) {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

type VectorGridPayload = {
  schema: "terrawatch-vector-grid-v1";
  source: string;
  sourceUrl: string;
  generatedAt: string;
  validTime: string;
  latency: string;
  units: string;
  width: number;
  height: number;
  longitudeStart: number;
  latitudeStart: number;
  longitudeStep: number;
  latitudeStep: number;
  scale: number;
  missing: number;
  u: string;
  v: string;
};

type VectorGrid = Omit<VectorGridPayload, "u" | "v"> & {
  u: Int16Array;
  v: Int16Array;
};

function decodeComponent(encoded: string) {
  const binary = window.atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(bytes.buffer);
}

function decodeVectorGrid(payload: VectorGridPayload): VectorGrid {
  if (payload.schema !== "terrawatch-vector-grid-v1") {
    throw new Error("unsupported vector grid schema");
  }
  const u = decodeComponent(payload.u);
  const v = decodeComponent(payload.v);
  if (u.length !== payload.width * payload.height || v.length !== u.length) {
    throw new Error("invalid vector grid dimensions");
  }
  return { ...payload, u, v };
}

function sampleVector(grid: VectorGrid, lng: number, lat: number) {
  const longitudeSpan = grid.width * grid.longitudeStep;
  const normalizedLongitude =
    ((((lng - grid.longitudeStart) % longitudeSpan) + longitudeSpan) % longitudeSpan) /
    grid.longitudeStep;
  const latitudePosition = (lat - grid.latitudeStart) / grid.latitudeStep;
  if (latitudePosition < 0 || latitudePosition > grid.height - 1) return null;

  const x0 = Math.floor(normalizedLongitude) % grid.width;
  const x1 = (x0 + 1) % grid.width;
  const y0 = Math.min(grid.height - 1, Math.floor(latitudePosition));
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const tx = normalizedLongitude - Math.floor(normalizedLongitude);
  const ty = latitudePosition - y0;
  const indexes = [
    y0 * grid.width + x0,
    y0 * grid.width + x1,
    y1 * grid.width + x0,
    y1 * grid.width + x1,
  ];
  if (indexes.some((index) => grid.u[index] === grid.missing || grid.v[index] === grid.missing)) {
    return null;
  }
  const interpolate = (values: Int16Array) => {
    const top = values[indexes[0]] * (1 - tx) + values[indexes[1]] * tx;
    const bottom = values[indexes[2]] * (1 - tx) + values[indexes[3]] * tx;
    return (top * (1 - ty) + bottom * ty) * grid.scale;
  };
  const u = interpolate(grid.u);
  const v = interpolate(grid.v);
  return { u, v, strength: Math.hypot(u, v) };
}

function VectorFieldCanvas({
  map,
  view,
  reduceMotion,
  grid,
  mode,
}: {
  map: MapLibreMap | null;
  view: { zoom: number; lng: number; lat: number };
  reduceMotion: boolean;
  grid: VectorGrid;
  mode: "wind" | "currents";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const particles: WindParticle[] = [];
    let frame = 0;
    let previousFrame = 0;
    let viewChanged = true;

    const reset = (particle: WindParticle, scatter = false) => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      particle.x = Math.random() * width;
      particle.y = Math.random() * height;
      particle.age = scatter ? Math.random() * 100 : 0;
      particle.life = 90 + Math.random() * 150;
      particle.pace = 0.72 + Math.random() * 0.72;
    };

    const screenToGeo = (x: number, y: number) => {
      if (map) {
        const coordinate = map.unproject([x, y]);
        return { lng: coordinate.lng, lat: coordinate.lat };
      }

      const degreesPerPixel = 360 / (512 * Math.pow(2, view.zoom));
      return {
        lng: view.lng + (x - canvas.clientWidth / 2) * degreesPerPixel,
        lat: Math.max(
          -82,
          Math.min(82, view.lat - (y - canvas.clientHeight / 2) * degreesPerPixel),
        ),
      };
    };

    const fieldDirection = (x: number, y: number) => {
      const coordinate = screenToGeo(x, y);
      const vector = sampleVector(grid, coordinate.lng, coordinate.lat);
      if (!vector || vector.strength < 0.001) return null;

      if (!map) {
        const length = Math.max(0.001, Math.hypot(vector.u, vector.v));
        return {
          x: vector.u / length,
          y: -vector.v / length,
          strength: vector.strength,
        };
      }

      const origin = map.project([coordinate.lng, coordinate.lat]);
      const target = map.project([
        coordinate.lng + vector.u * 0.35,
        Math.max(-84, Math.min(84, coordinate.lat + vector.v * 0.35)),
      ]);
      const dx = target.x - origin.x;
      const dy = target.y - origin.y;
      const length = Math.max(0.001, Math.hypot(dx, dy));
      return {
        x: dx / length,
        y: dy / length,
        strength: vector.strength,
      };
    };

    const drawStaticField = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = "screen";
      context.lineCap = "round";

      for (let y = 28; y < height; y += 48) {
        for (let x = 24 + ((y / 48) % 2) * 20; x < width; x += 52) {
          const direction = fieldDirection(x, y);
          if (!direction) continue;
          const strength = Math.min(1, direction.strength / (mode === "wind" ? 30 : 1.5));
          const length = 7 + strength * 10;
          context.strokeStyle = `rgba(174, 255, 234, ${0.25 + strength * 0.24})`;
          context.lineWidth = 0.85 + strength * 0.45;
          context.beginPath();
          context.moveTo(
            x - direction.x * length * 0.5,
            y - direction.y * length * 0.5,
          );
          context.lineTo(
            x + direction.x * length * 0.5,
            y + direction.y * length * 0.5,
          );
          context.stroke();
        }
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      const targetCount = reduceMotion
        ? 0
        : Math.max(
            650,
            Math.min(1600, Math.round((rect.width * rect.height) / 900)),
          );
      while (particles.length < targetCount) {
        const particle: WindParticle = {
          x: 0,
          y: 0,
          age: 0,
          life: 90,
          pace: 1,
        };
        reset(particle, true);
        particles.push(particle);
      }
      if (particles.length > targetCount) particles.length = targetCount;
      viewChanged = true;
      if (reduceMotion) drawStaticField();
    };

    const markViewChanged = () => {
      viewChanged = true;
    };

    const draw = (time: number) => {
      if (reduceMotion) {
        drawStaticField();
        return;
      }
      if (time - previousFrame < 1000 / 48) {
        frame = window.requestAnimationFrame(draw);
        return;
      }
      previousFrame = time;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      if (viewChanged) {
        context.clearRect(0, 0, width, height);
        particles.forEach((particle) => reset(particle, true));
        viewChanged = false;
      }

      context.globalCompositeOperation = "destination-in";
      context.fillStyle = "rgba(0, 0, 0, 0.968)";
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = "lighter";
      context.lineCap = "round";

      particles.forEach((particle, index) => {
        const px = particle.x;
        const py = particle.y;
        const direction = fieldDirection(particle.x, particle.y);
        if (!direction) {
          reset(particle);
          return;
        }
        const visualMaximum = mode === "wind" ? 30 : 1.5;
        const visualStrength = Math.min(1, direction.strength / visualMaximum);
        const speed =
          (0.32 + visualStrength * 1.35) * particle.pace;

        particle.x += direction.x * speed;
        particle.y += direction.y * speed;
        particle.age += 1;

        const normalizedStrength = visualStrength;
        const alpha =
          0.4 + normalizedStrength * 0.36 + (index % 9 === 0 ? 0.1 : 0);
        const red = mode === "wind" ? Math.round(142 + normalizedStrength * 52) : 85;
        const green = mode === "wind" ? 255 : Math.round(190 + normalizedStrength * 45);
        const blue = mode === "wind" ? Math.round(218 + normalizedStrength * 27) : 255;
        context.lineWidth = 0.9 + normalizedStrength * 0.58;
        context.strokeStyle = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
        context.beginPath();
        context.moveTo(px, py);
        context.lineTo(particle.x, particle.y);
        context.stroke();

        if (
          particle.x < -12 ||
          particle.x > width + 12 ||
          particle.y < -12 ||
          particle.y > height + 12 ||
          particle.age > particle.life
        ) {
          reset(particle);
        }
      });

      frame = window.requestAnimationFrame(draw);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    if (reduceMotion) map?.on("moveend", drawStaticField);
    else map?.on("move", markViewChanged);
    if (!reduceMotion) frame = window.requestAnimationFrame(draw);

    return () => {
      observer.disconnect();
      if (reduceMotion) map?.off("moveend", drawStaticField);
      else map?.off("move", markViewChanged);
      window.cancelAnimationFrame(frame);
    };
  }, [grid, map, mode, reduceMotion, view.lat, view.lng, view.zoom]);

  return <canvas className={`wind-field vector-${mode}`} ref={canvasRef} aria-hidden="true" />;
}

function drawEventGlyph(
  context: CanvasRenderingContext2D,
  anchor: SignalAnchor & { x: number; y: number },
  time: number,
  staticOnly: boolean,
  selectedBoost: number,
) {
  const kind = anchor.kind ?? "other";
  const visual = EVENT_VISUALS[kind];
  const [red, green, blue] = visual.rgb;
  const shimmer = staticOnly
    ? 0.88
    : 0.76 +
      Math.sin(time * 0.0023 + anchor.phase * Math.PI * 2) * 0.12;
  const size = (7.2 + anchor.intensity * 3.6) * selectedBoost;

  context.save();
  context.translate(anchor.x, anchor.y);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = 1.25 + anchor.intensity * 0.55;
  context.strokeStyle = `rgba(${red}, ${green}, ${blue}, ${shimmer})`;
  context.fillStyle = `rgba(${red}, ${green}, ${blue}, ${shimmer * 0.8})`;
  context.shadowColor = `rgba(${red}, ${green}, ${blue}, 0.7)`;
  context.shadowBlur = 6 + anchor.intensity * 4;

  if (kind === "storm") {
    context.beginPath();
    context.arc(-size * 0.08, 0, size * 0.72, -0.72, Math.PI * 0.92);
    context.stroke();
    context.beginPath();
    context.arc(size * 0.08, 0, size * 0.46, Math.PI * 0.25, Math.PI * 1.78);
    context.stroke();
    context.beginPath();
    context.arc(0, 0, size * 0.16, 0, Math.PI * 1.7);
    context.stroke();
  } else if (kind === "wildfire") {
    context.beginPath();
    context.moveTo(0, size);
    context.bezierCurveTo(
      -size * 0.86,
      size * 0.48,
      -size * 0.5,
      -size * 0.24,
      -size * 0.08,
      -size,
    );
    context.bezierCurveTo(
      size * 0.02,
      -size * 0.38,
      size * 0.9,
      -size * 0.08,
      size * 0.55,
      size * 0.58,
    );
    context.bezierCurveTo(
      size * 0.38,
      size * 0.9,
      size * 0.13,
      size,
      0,
      size,
    );
    context.fill();
    context.fillStyle = `rgba(255, 240, 185, ${shimmer * 0.92})`;
    context.beginPath();
    context.moveTo(0, size * 0.68);
    context.bezierCurveTo(
      -size * 0.3,
      size * 0.35,
      0,
      size * 0.02,
      size * 0.08,
      -size * 0.34,
    );
    context.bezierCurveTo(
      size * 0.46,
      size * 0.15,
      size * 0.3,
      size * 0.58,
      0,
      size * 0.68,
    );
    context.fill();
  } else if (kind === "earthquake") {
    context.beginPath();
    context.moveTo(0, -size);
    context.lineTo(size * 0.78, 0);
    context.lineTo(0, size);
    context.lineTo(-size * 0.78, 0);
    context.closePath();
    context.stroke();
    context.beginPath();
    context.moveTo(-size * 0.2, -size * 0.72);
    context.lineTo(size * 0.12, -size * 0.18);
    context.lineTo(-size * 0.12, size * 0.04);
    context.lineTo(size * 0.26, size * 0.7);
    context.stroke();
  } else if (kind === "volcano") {
    context.beginPath();
    context.moveTo(-size, size * 0.82);
    context.lineTo(-size * 0.28, -size * 0.26);
    context.lineTo(size * 0.18, -size * 0.26);
    context.lineTo(size, size * 0.82);
    context.closePath();
    context.stroke();
    context.beginPath();
    context.arc(-size * 0.03, -size * 0.66, size * 0.28, 0.2, 2.7);
    context.stroke();
    context.beginPath();
    context.arc(size * 0.2, -size * 0.98, size * 0.2, 0.35, 2.9);
    context.stroke();
  } else if (kind === "flood") {
    for (let row = -1; row <= 1; row += 1) {
      context.beginPath();
      for (let segment = 0; segment <= 16; segment += 1) {
        const progress = segment / 16;
        const x = -size + progress * size * 2;
        const y =
          row * size * 0.45 +
          Math.sin(progress * Math.PI * 2) * size * 0.16;
        if (segment === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }
  } else if (kind === "ice") {
    for (let spoke = 0; spoke < 3; spoke += 1) {
      context.save();
      context.rotate((spoke * Math.PI) / 3);
      context.beginPath();
      context.moveTo(-size, 0);
      context.lineTo(size, 0);
      context.moveTo(size * 0.52, 0);
      context.lineTo(size * 0.74, -size * 0.22);
      context.moveTo(size * 0.52, 0);
      context.lineTo(size * 0.74, size * 0.22);
      context.stroke();
      context.restore();
    }
  } else if (kind === "landslide") {
    context.beginPath();
    context.moveTo(-size, size * 0.8);
    context.lineTo(-size * 0.2, -size * 0.82);
    context.lineTo(size, size * 0.8);
    context.stroke();
    [-0.2, 0.32, 0.68].forEach((offset, index) => {
      context.beginPath();
      context.arc(
        size * offset,
        size * (0.12 + index * 0.25),
        1.1 + index * 0.45,
        0,
        Math.PI * 2,
      );
      context.fill();
    });
  } else if (kind === "drought") {
    context.beginPath();
    context.arc(0, 0, size * 0.42, 0, Math.PI * 2);
    context.stroke();
    for (let ray = 0; ray < 8; ray += 1) {
      const angle = (ray * Math.PI) / 4;
      context.beginPath();
      context.moveTo(
        Math.cos(angle) * size * 0.62,
        Math.sin(angle) * size * 0.62,
      );
      context.lineTo(
        Math.cos(angle) * size,
        Math.sin(angle) * size,
      );
      context.stroke();
    }
  } else if (kind === "dust") {
    [-0.48, 0, 0.48].forEach((offset, index) => {
      context.beginPath();
      context.moveTo(-size * (index === 1 ? 1 : 0.82), size * offset);
      context.bezierCurveTo(
        -size * 0.25,
        size * (offset - 0.22),
        size * 0.25,
        size * (offset + 0.22),
        size * (index === 1 ? 1 : 0.82),
        size * offset,
      );
      context.stroke();
    });
  } else {
    context.beginPath();
    context.moveTo(0, -size);
    context.lineTo(size, 0);
    context.lineTo(0, size);
    context.lineTo(-size, 0);
    context.closePath();
    context.stroke();
    context.beginPath();
    context.arc(0, 0, size * 0.2, 0, Math.PI * 2);
    context.fill();
  }

  context.restore();
}

function PhenomenaCanvas({
  mode,
  map,
  view,
  anchors,
  selectedSignalId,
  reduceMotion,
}: {
  mode: EffectMode;
  map: MapLibreMap | null;
  view: { zoom: number; lng: number; lat: number };
  anchors: SignalAnchor[];
  selectedSignalId?: string;
  reduceMotion: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let frame = 0;
    let previousFrame = 0;
    let isVisible = !document.hidden;
    const targetFps = mode === "rain" ? 30 : 24;
    const frameInterval = 1000 / targetFps;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(performance.now(), true, false);
    };

    const project = (anchor: SignalAnchor) => {
      if (map) {
        const centerLongitude = map.getCenter().lng;
        const nearestLongitude =
          anchor.lng + Math.round((centerLongitude - anchor.lng) / 360) * 360;
        const point = map.project([nearestLongitude, anchor.lat]);
        return { x: point.x, y: point.y };
      }

      const degreesPerPixel = 360 / (512 * Math.pow(2, view.zoom));
      return {
        x:
          canvas.clientWidth / 2 +
          wrapLongitude(anchor.lng - view.lng) / degreesPerPixel,
        y:
          canvas.clientHeight / 2 -
          (anchor.lat - view.lat) / degreesPerPixel,
      };
    };

    const visibleAnchors = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const projected = anchors
        .map((anchor) => ({ ...anchor, ...project(anchor) }))
        .filter(
          (anchor) =>
            anchor.x > -55 &&
            anchor.x < width + 55 &&
            anchor.y > -55 &&
            anchor.y < height + 55,
        )
        .sort((first, second) => {
          const firstSelected = first.id === selectedSignalId ? 1 : 0;
          const secondSelected = second.id === selectedSignalId ? 1 : 0;
          return (
            secondSelected - firstSelected ||
            second.intensity - first.intensity
          );
        });

      const zoom = map?.getZoom() ?? view.zoom;
      const cap =
        mode === "events"
          ? zoom < 2.2
            ? 24
            : zoom < 3.6
              ? 40
              : 60
          : mode === "rain"
            ? zoom < 2.2
              ? 135
              : zoom < 4
                ? 200
                : 260
            : zoom < 2.2
              ? 80
              : zoom < 4
                ? 125
                : 170;
      return projected.slice(0, cap);
    };

    const drawHeat = (
      points: Array<SignalAnchor & { x: number; y: number }>,
      time: number,
      staticOnly: boolean,
    ) => {
      context.globalCompositeOperation = "screen";
      points.forEach((anchor) => {
        const radius = 23 + anchor.intensity * 37;
        const glow = context.createRadialGradient(
          anchor.x,
          anchor.y,
          0,
          anchor.x,
          anchor.y,
          radius,
        );
        glow.addColorStop(0, `rgba(255, 119, 50, ${0.2 * anchor.intensity})`);
        glow.addColorStop(
          0.5,
          `rgba(255, 181, 118, ${0.085 * anchor.intensity})`,
        );
        glow.addColorStop(1, "rgba(255, 155, 104, 0)");
        context.fillStyle = glow;
        context.beginPath();
        context.arc(anchor.x, anchor.y, radius, 0, Math.PI * 2);
        context.fill();

        if (staticOnly) {
          context.strokeStyle = `rgba(255, 202, 158, ${0.12 * anchor.intensity})`;
          context.lineWidth = 0.8;
          context.beginPath();
          context.arc(anchor.x, anchor.y, radius * 0.52, 0, Math.PI * 2);
          context.stroke();
          return;
        }

        const bandCount = 3 + Math.floor(anchor.intensity * 3);
        for (let band = 0; band < bandCount; band += 1) {
          const bandPhase =
            (time * 0.00013 + anchor.phase + band / bandCount) % 1;
          const bandY =
            anchor.y + radius * 0.55 - bandPhase * (radius * 1.62);
          const bandWidth = radius * (0.34 + bandPhase * 0.28);
          const bandAlpha =
            Math.sin(bandPhase * Math.PI) *
            (0.14 + anchor.intensity * 0.18);
          context.strokeStyle = `rgba(255, 169, 100, ${Math.max(
            0,
            bandAlpha,
          )})`;
          context.lineWidth = 1.8 + anchor.intensity;
          context.beginPath();
          for (let segment = 0; segment <= 12; segment += 1) {
            const progress = segment / 12;
            const x = anchor.x - bandWidth + progress * bandWidth * 2;
            const y =
              bandY +
              Math.sin(
                progress * Math.PI * 3 +
                  bandPhase * Math.PI * 2 +
                  anchor.phase * 5,
              ) *
                (1.8 + anchor.intensity * 2.2);
            if (segment === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          }
          context.stroke();
        }

        const strandCount = 5 + Math.floor(anchor.intensity * 6);
        for (let strand = 0; strand < strandCount; strand += 1) {
          const strandPhase =
            (time * 0.0002 + anchor.phase + strand / strandCount) % 1;
          const rise = strandPhase * (58 + anchor.intensity * 52);
          const offset =
            (strand - (strandCount - 1) / 2) * 5.5 +
            Math.sin(strandPhase * Math.PI * 2 + anchor.phase * 5) *
              (3 + anchor.intensity * 3.5);
          const x = anchor.x + offset;
          const y = anchor.y + radius * 0.35 - rise;
          const alpha =
            Math.sin(strandPhase * Math.PI) * (0.2 + anchor.intensity * 0.25);

          context.strokeStyle = `rgba(157, 65, 28, ${Math.max(
            0,
            alpha * 0.62,
          )})`;
          context.lineWidth = 2.2 + anchor.intensity * 0.9;
          context.beginPath();
          context.moveTo(x - 2, y + 15);
          context.bezierCurveTo(
            x + 6,
            y + 8,
            x - 6,
            y - 7,
            x + 1,
            y - 18,
          );
          context.stroke();

          context.strokeStyle = `rgba(255, 235, 207, ${Math.max(0, alpha)})`;
          context.lineWidth = 0.9 + anchor.intensity * 0.65;
          context.beginPath();
          context.moveTo(x - 2, y + 15);
          context.bezierCurveTo(
            x + 6,
            y + 8,
            x - 6,
            y - 7,
            x + 1,
            y - 18,
          );
          context.stroke();
        }
      });
    };

    const drawRain = (
      points: Array<SignalAnchor & { x: number; y: number }>,
      time: number,
      staticOnly: boolean,
    ) => {
      context.globalCompositeOperation = "screen";
      points.forEach((anchor) => {
        const radius = 20 + anchor.intensity * 36;
        const pulse = (time * 0.00031 + anchor.phase) % 1;
        const glow = context.createRadialGradient(
          anchor.x,
          anchor.y,
          0,
          anchor.x,
          anchor.y,
          radius,
        );
        glow.addColorStop(0, `rgba(76, 137, 255, ${0.16 * anchor.intensity})`);
        glow.addColorStop(
          0.48,
          `rgba(105, 176, 255, ${0.065 * anchor.intensity})`,
        );
        glow.addColorStop(1, "rgba(76, 137, 255, 0)");
        context.fillStyle = glow;
        context.beginPath();
        context.arc(anchor.x, anchor.y, radius, 0, Math.PI * 2);
        context.fill();

        context.strokeStyle = `rgba(123, 176, 255, ${
          (staticOnly ? 0.14 : (1 - pulse) * 0.17) * anchor.intensity
        })`;
        context.lineWidth = 0.7;
        context.beginPath();
        context.arc(
          anchor.x,
          anchor.y,
          staticOnly ? radius * 0.46 : 6 + pulse * radius,
          0,
          Math.PI * 2,
        );
        context.stroke();

        if (staticOnly) {
          for (let streak = 0; streak < 3; streak += 1) {
            const x = anchor.x + (streak - 1) * radius * 0.34;
            const y = anchor.y - radius * 0.2 + streak * 3;
            context.strokeStyle = `rgba(176, 218, 255, ${
              0.25 + anchor.intensity * 0.24
            })`;
            context.lineWidth = 0.9 + anchor.intensity * 0.42;
            context.beginPath();
            context.moveTo(x - 4, y - 12);
            context.lineTo(x + 3, y + 13);
            context.stroke();
            context.fillStyle = `rgba(214, 237, 255, ${
              0.32 + anchor.intensity * 0.3
            })`;
            context.beginPath();
            context.ellipse(x + 3, y + 13, 1.2, 1.8, -0.25, 0, Math.PI * 2);
            context.fill();
          }
          return;
        }
        const streakCount = 8 + Math.floor(anchor.intensity * 12);
        for (let streak = 0; streak < streakCount; streak += 1) {
          const seed = hashUnit(`${anchor.id}-${streak}`);
          const secondSeed = hashUnit(`${streak}-${anchor.id}`);
          const x = anchor.x + (seed - 0.5) * radius * 1.65;
          const travel =
            (time * (0.04 + anchor.intensity * 0.025) +
              secondSeed * radius * 2) %
            (radius * 2);
          const y = anchor.y - radius + travel;
          const distance = Math.hypot(x - anchor.x, y - anchor.y);
          if (distance > radius) continue;
          const trailLength = 24 + anchor.intensity * 28;
          context.strokeStyle = `rgba(156, 204, 255, ${
            0.2 + anchor.intensity * 0.32
          })`;
          context.lineWidth = 0.85 + anchor.intensity * 0.5;
          context.beginPath();
          context.moveTo(x - trailLength * 0.22, y - trailLength * 0.55);
          context.lineTo(x + trailLength * 0.18, y + trailLength * 0.55);
          context.stroke();

          if (streak % 3 === 0) {
            const dropX = x + trailLength * 0.18;
            const dropY = y + trailLength * 0.55;
            context.fillStyle = `rgba(222, 241, 255, ${
              0.3 + anchor.intensity * 0.38
            })`;
            context.beginPath();
            context.ellipse(
              dropX,
              dropY,
              1.05 + anchor.intensity * 0.45,
              1.8 + anchor.intensity * 0.8,
              -0.34,
              0,
              Math.PI * 2,
            );
            context.fill();
          }
        }
      });
    };

    const drawEvents = (
      points: Array<SignalAnchor & { x: number; y: number }>,
      time: number,
      staticOnly: boolean,
    ) => {
      context.globalCompositeOperation = "screen";
      points.forEach((anchor) => {
        const visual = EVENT_VISUALS[anchor.kind ?? "other"];
        const color = visual.rgb;
        const selectedBoost = anchor.id === selectedSignalId ? 1.22 : 1;
        const maxRadius = (18 + anchor.intensity * 15) * selectedBoost;
        const duration = 2700 + anchor.phase * 700;

        if (staticOnly) {
          [0.42, 0.72].forEach((scale, index) => {
            context.strokeStyle = `rgba(${color.join(",")}, ${
              (0.28 - index * 0.1) * selectedBoost
            })`;
            context.lineWidth = index === 0 ? 1.1 : 0.75;
            context.beginPath();
            context.arc(
              anchor.x,
              anchor.y,
              maxRadius * scale,
              0,
              Math.PI * 2,
            );
            context.stroke();
          });
        } else {
          for (let ring = 0; ring < 2; ring += 1) {
            const progress =
              ((time / duration + anchor.phase + ring * 0.5) % 1 + 1) % 1;
            const radius = 7 + progress * maxRadius;
            const alpha =
              Math.pow(1 - progress, 1.6) *
              (0.32 + anchor.intensity * 0.26) *
              selectedBoost;
            context.strokeStyle = `rgba(${color.join(",")}, ${alpha})`;
            context.lineWidth = 0.75 + (1 - progress) * 0.7;
            context.beginPath();
            context.arc(anchor.x, anchor.y, radius, 0, Math.PI * 2);
            context.stroke();
          }
        }

        const flash =
          staticOnly
            ? 0.58
            : 0.38 +
              0.62 *
                Math.pow(
                  Math.max(0, Math.sin(time * 0.004 + anchor.phase * 8)),
                  8,
                );
        context.fillStyle = `rgba(${color.join(",")}, ${flash * selectedBoost})`;
        context.beginPath();
        context.arc(
          anchor.x,
          anchor.y,
          (2.5 + anchor.intensity * 1.8) * selectedBoost,
          0,
          Math.PI * 2,
        );
        context.fill();

        drawEventGlyph(
          context,
          anchor,
          time,
          staticOnly,
          selectedBoost,
        );
      });
    };

    const draw = (time: number, force = false, scheduleNext = true) => {
      if (!force && time - previousFrame < frameInterval) {
        if (scheduleNext) frame = window.requestAnimationFrame(draw);
        return;
      }
      previousFrame = time;
      context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      const points = visibleAnchors();

      if (mode === "heat") drawHeat(points, time, reduceMotion);
      else if (mode === "rain") drawRain(points, time, reduceMotion);
      else drawEvents(points, time, reduceMotion);

      if (scheduleNext && !reduceMotion && isVisible) {
        frame = window.requestAnimationFrame(draw);
      }
    };

    const onVisibilityChange = () => {
      isVisible = !document.hidden;
      if (isVisible && !reduceMotion) {
        window.cancelAnimationFrame(frame);
        previousFrame = 0;
        frame = window.requestAnimationFrame(draw);
      } else {
        window.cancelAnimationFrame(frame);
      }
    };
    const redraw = () => {
      if (reduceMotion) draw(performance.now(), true);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    map?.on("move", redraw);
    document.addEventListener("visibilitychange", onVisibilityChange);
    resize();
    if (!reduceMotion && isVisible) frame = window.requestAnimationFrame(draw);

    return () => {
      observer.disconnect();
      map?.off("move", redraw);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.cancelAnimationFrame(frame);
      context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    };
  }, [
    anchors,
    map,
    mode,
    reduceMotion,
    selectedSignalId,
    view.lat,
    view.lng,
    view.zoom,
  ]);

  return (
    <canvas
      className={`phenomena-field phenomena-${mode}`}
      ref={canvasRef}
      aria-hidden="true"
    />
  );
}

export default function Home() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [wheelPosition, setWheelPosition] = useState(0);
  const [wheelDragging, setWheelDragging] = useState(false);
  const [earthTime, setEarthTime] = useState<Date | null>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);
  const [eventCount, setEventCount] = useState<number | null>(null);
  const [eventStatus, setEventStatus] = useState("等待事件频道");
  const [eventSignals, setEventSignals] = useState<SignalAnchor[]>([]);
  const [rasterSignals, setRasterSignals] = useState<SignalAnchor[]>([]);
  const [rasterEffectStatus, setRasterEffectStatus] = useState<
    "idle" | "loading" | "ready" | "unavailable"
  >("idle");
  const [selectedEvent, setSelectedEvent] = useState<SelectedEvent | null>(null);
  const [vectorGrids, setVectorGrids] = useState<Partial<Record<"wind" | "currents", VectorGrid>>>({});
  const [vectorStatus, setVectorStatus] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const [mapView, setMapView] = useState({ zoom: 1.52, lng: 180, lat: 8 });
  const mapContainerRef = useRef<MapContainerElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const wheelLockRef = useRef(false);
  const dragStartRef = useRef<number | null>(null);
  const dragDirectionRef = useRef(1);
  const dragStepRef = useRef(0);
  const dragTargetRef = useRef(0);
  const dragMovedRef = useRef(false);
  const wheelStepRef = useRef(0);
  const wheelPositionRef = useRef(0);
  const activeIndexRef = useRef(0);
  const observationDate = useMemo(() => utcDate(2), []);
  const activeChannel = CHANNELS[activeIndex];
  const showsLatestObservation = Boolean(activeChannel.layer);
  const activeVectorMode =
    activeChannel.id === "wind" || activeChannel.id === "currents"
      ? activeChannel.id
      : null;
  const activeVectorGrid = activeVectorMode ? vectorGrids[activeVectorMode] : undefined;
  const activeEffectMode: EffectMode | null =
    activeChannel.id === "rain" ||
    activeChannel.id === "heat" ||
    activeChannel.id === "events"
      ? activeChannel.id
      : null;
  const fallbackImages = useMemo(() => {
    const baseLayer = "BlueMarble_NextGeneration";
    const layers = activeChannel.layer
      ? activeChannel.id === "cloud"
        ? activeChannel.layer.id
        : `${baseLayer},${activeChannel.layer.id}`
      : baseLayer;
    const hemisphere = (west: number, east: number) => {
      const params = new URLSearchParams({
        SERVICE: "WMS",
        REQUEST: "GetMap",
        VERSION: "1.3.0",
        LAYERS: layers,
        STYLES: "",
        FORMAT: "image/jpeg",
        TRANSPARENT: "false",
        WIDTH: "1024",
        HEIGHT: "1024",
        CRS: "EPSG:4326",
        BBOX: `-90,${west},90,${east}`,
      });
      if (activeChannel.layer) params.set("TIME", observationDate);
      return gibsWmsUrl(params);
    };
    return [hemisphere(0, 180), hemisphere(-180, 0)];
  }, [activeChannel, observationDate]);

  useEffect(() => {
    const initialSync = window.setTimeout(() => setEarthTime(new Date()), 0);
    const clock = window.setInterval(() => setEarthTime(new Date()), 1000);
    return () => {
      window.clearTimeout(initialSync);
      window.clearInterval(clock);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => {
      setPrefersReducedMotion(media.matches);
    };
    syncPreference();
    media.addEventListener("change", syncPreference);
    return () => media.removeEventListener("change", syncPreference);
  }, []);

  useEffect(() => {
    if (!activeVectorMode || vectorGrids[activeVectorMode]) return;
    const controller = new AbortController();
    const markLoading = window.setTimeout(() => setVectorStatus("loading"), 0);
    const filename = activeVectorMode === "wind" ? "wind-latest.json" : "currents-latest.json";
    fetch(localDataFile(filename), { signal: controller.signal, cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`vector data unavailable: ${response.status}`);
        return response.json() as Promise<VectorGridPayload>;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const grid = decodeVectorGrid(payload);
        setVectorGrids((current) => ({ ...current, [activeVectorMode]: grid }));
        setVectorStatus("ready");
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setVectorStatus("unavailable");
      });
    return () => {
      window.clearTimeout(markLoading);
      controller.abort();
    };
  }, [activeVectorMode, vectorGrids]);

  useEffect(() => {
    if (
      (activeChannel.id !== "rain" && activeChannel.id !== "heat") ||
      !activeChannel.layer
    ) {
      const clearState = window.setTimeout(() => {
        setRasterSignals([]);
        setRasterEffectStatus("idle");
      }, 0);
      return () => window.clearTimeout(clearState);
    }

    const mode = activeChannel.id;
    const key = `${mode}-${activeChannel.layer.id}-${observationDate}`;
    const cached = rasterSignalCache.get(key);
    if (cached) {
      const restoreCached = window.setTimeout(() => {
        setRasterSignals(cached);
        setRasterEffectStatus(cached.length ? "ready" : "unavailable");
      }, 0);
      return () => window.clearTimeout(restoreCached);
    }

    const controller = new AbortController();
    const markLoading = window.setTimeout(() => {
      setRasterSignals([]);
      setRasterEffectStatus("loading");
    }, 0);

    const loadSignals = async () => {
      try {
        const response = await fetch(
          gibsAnalysisImage(activeChannel.layer!, observationDate),
          { signal: controller.signal, cache: "force-cache" },
        );
        if (!response.ok) throw new Error("signal mask unavailable");
        const bitmap = await createImageBitmap(await response.blob());
        const signals = analyzeRasterSignals(bitmap, mode);
        bitmap.close();
        if (controller.signal.aborted) return;

        rasterSignalCache.set(key, signals);
        if (rasterSignalCache.size > SIGNAL_CACHE_LIMIT) {
          const oldestKey = rasterSignalCache.keys().next().value;
          if (oldestKey) rasterSignalCache.delete(oldestKey);
        }
        setRasterSignals(signals);
        setRasterEffectStatus(signals.length ? "ready" : "unavailable");
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setRasterSignals([]);
        setRasterEffectStatus("unavailable");
      }
    };

    void loadSignals();
    return () => {
      window.clearTimeout(markLoading);
      controller.abort();
    };
  }, [activeChannel, observationDate]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const activateWheelStep = useCallback((step: number) => {
    const nextStep = Math.trunc(step);
    const next = modulo(nextStep, CHANNEL_COUNT);
    wheelStepRef.current = nextStep;
    wheelPositionRef.current = nextStep;
    setWheelPosition(nextStep);
    setActiveIndex(next);
    setSelectedEvent(null);
    setEventSignals([]);
  }, []);

  const moveChannel = useCallback(
    (delta: number) => {
      activateWheelStep(wheelStepRef.current + Math.trunc(delta));
    },
    [activateWheelStep],
  );

  const selectChannel = useCallback(
    (index: number) => {
      const target = modulo(index, CHANNEL_COUNT);
      const current = modulo(wheelStepRef.current, CHANNEL_COUNT);
      let distance = target - current;
      if (distance > CHANNEL_COUNT / 2) distance -= CHANNEL_COUNT;
      if (distance < -CHANNEL_COUNT / 2) distance += CHANNEL_COUNT;
      activateWheelStep(wheelStepRef.current + distance);
    },
    [activateWheelStep],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowDown", "PageDown"].includes(event.key)) {
        event.preventDefault();
        moveChannel(1);
      }
      if (["ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();
        moveChannel(-1);
      }
      if (event.key >= "1" && Number(event.key) <= CHANNEL_COUNT) {
        selectChannel(Number(event.key) - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moveChannel, selectChannel]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
      container: mapContainerRef.current,
      center: [180, 8],
      zoom: 1.52,
      minZoom: 1.15,
      maxZoom: 5.75,
      bearing: 0,
      pitch: 0,
      maxPitch: 0,
      dragRotate: false,
      touchPitch: false,
      scrollZoom: true,
      dragPan: true,
      boxZoom: true,
      doubleClickZoom: true,
      renderWorldCopies: true,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          earth: {
            type: "raster",
            tiles: blueMarbleTiles(),
            tileSize: 256,
            attribution: "NASA EOSDIS GIBS",
          },
          labels: {
            type: "raster",
            tiles: cartoLabelTiles(),
            tileSize: 256,
            attribution: "© OpenStreetMap contributors © CARTO",
          },
        },
        layers: [
          {
            id: "space",
            type: "background",
            paint: { "background-color": "#02090d" },
          },
          {
            id: "earth",
            type: "raster",
            source: "earth",
            paint: { "raster-opacity": 1, "raster-fade-duration": 700 },
          },
          {
            id: "labels",
            type: "raster",
            source: "labels",
            paint: { "raster-opacity": 0.72 },
          },
        ],
      },
      });
      map.touchZoomRotate?.disableRotation?.();
      map.dragPan.enable();
      mapContainerRef.current!.__terrawatchMap = map;
    } catch {
      return;
    }

    const updateMapView = () => {
      const center = map.getCenter();
      setMapView({ zoom: map.getZoom(), lng: center.lng, lat: center.lat });
    };

    const syncSingleWorldViewport = () => {
      const viewportWidth = map.getContainer().clientWidth;
      const singleWorldWidth = Math.max(512, viewportWidth + 96);
      const singleWorldMinZoom = Math.max(
        1.15,
        Math.log2(singleWorldWidth / 512),
      );
      map.setMinZoom(singleWorldMinZoom);
      if (map.getZoom() < singleWorldMinZoom) {
        map.jumpTo({
          center: [180, 8],
          zoom: singleWorldMinZoom,
          bearing: 0,
          pitch: 0,
        });
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      map.resize();
      syncSingleWorldViewport();
      updateMapView();
    });

    liveMap = map;
    map.on("load", () => {
      map.resize();
      syncSingleWorldViewport();
      updateMapView();
      setMapReady(true);
    });
    map.on("moveend", updateMapView);
    resizeObserver.observe(map.getContainer());
    mapRef.current = map;
    setMapInstance(map);
    const mapContainer = mapContainerRef.current;
    return () => {
      resizeObserver.disconnect();
      map.remove();
      if (mapRef.current === map) mapRef.current = null;
      setMapInstance(null);
      if (liveMap === map) liveMap = null;
      if (mapContainer?.__terrawatchMap === map) {
        delete mapContainer.__terrawatchMap;
      }
    };
  }, [observationDate]);

  useEffect(() => {
    const map = mapContainerRef.current?.__terrawatchMap ?? liveMap ?? mapRef.current;
    if (!map || !mapReady) return;

    const removeObservationLayers = () => {
      if (map.getLayer("observation")) map.removeLayer("observation");
      if (map.getSource("observation")) map.removeSource("observation");
    };

    removeObservationLayers();

    const layer = activeChannel.layer;
    map.setPaintProperty(
      "earth",
      "raster-opacity",
      activeChannel.id === "satellite"
        ? 1
        : activeChannel.id === "wind" || activeChannel.id === "currents"
          ? 0.4
          : activeChannel.id === "events"
            ? 0.48
          : 0.68,
    );

    if (layer) {
      map.addSource("observation", {
        type: "raster",
        tiles: gibsTiles(layer, observationDate),
        tileSize: 256,
        attribution: "NASA EOSDIS GIBS",
      });
      map.addLayer(
        {
          id: "observation",
          type: "raster",
          source: "observation",
          paint: {
            "raster-opacity": layer.opacity,
            "raster-fade-duration": 700,
          },
        },
        "labels",
      );
    }

    return removeObservationLayers;
  }, [activeChannel, mapReady, observationDate]);

  useEffect(() => {
    const map = mapContainerRef.current?.__terrawatchMap ?? liveMap ?? mapRef.current;

    const clearEventLayers = () => {
      if (!map || !map.getStyle()) return;
      ["event-core", "event-ring"].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      if (map.getSource("earth-events")) map.removeSource("earth-events");
      map.getCanvas().style.cursor = "grab";
    };

    clearEventLayers();
    if (activeChannel.id !== "events") return;

    const controller = new AbortController();

    const loadEvents = async () => {
      setEventStatus("连接全球事件流…");
      setEventCount(null);
      try {
        let collection: GeoJSON.FeatureCollection;
        let synchronizationLabel: string;
        if (selfHostedDataEnabled()) {
          const response = await fetch(localDataFile("events-latest.geojson"), {
            signal: controller.signal,
            cache: "no-store",
          });
          if (!response.ok) throw new Error("self-hosted event stream unavailable");
          const localCollection = (await response.json()) as GeoJSON.FeatureCollection & {
            metadata?: { generatedAt?: string; sourceErrors?: string[] };
          };
          if (localCollection.type !== "FeatureCollection" || !Array.isArray(localCollection.features)) {
            throw new Error("self-hosted event stream is invalid");
          }
          collection = localCollection;
          synchronizationLabel = localCollection.metadata?.sourceErrors?.length
            ? "本地事件流已同步（部分源使用缓存）"
            : "本地事件流已同步";
        } else {
          const [usgsResponse, eonetResponse] = await Promise.all([
            fetch(
              "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
              { signal: controller.signal },
            ),
            fetch("https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=60", {
              signal: controller.signal,
            }),
          ]);
          if (!usgsResponse.ok || !eonetResponse.ok) throw new Error("event stream unavailable");
          const usgs = (await usgsResponse.json()) as GeoJSON.FeatureCollection;
          const eonet = (await eonetResponse.json()) as {
            events?: Array<{
              id: string;
              title: string;
              categories?: Array<{ id?: string; title?: string }>;
              geometry?: Array<{
                date?: string;
                type?: string;
                coordinates?: [number, number];
              }>;
            }>;
          };

          const usgsFeatures = (usgs.features || []).map((feature) => {
            const coordinates =
              feature.geometry?.type === "Point" ? feature.geometry.coordinates : [];
            const signalId = String(
              feature.id ?? `usgs-${coordinates[0]}-${coordinates[1]}`,
            );
            const magnitude = Number(feature.properties?.mag);
            const effectIntensity = Number.isFinite(magnitude)
              ? Math.max(0.36, Math.min(1, (magnitude - 3.5) / 4))
              : 0.5;
            return {
              ...feature,
              properties: {
                ...feature.properties,
                kind: "earthquake",
                signalId,
                effectIntensity,
                sourceLabel: "USGS",
                eventColor: EVENT_VISUALS.earthquake.color,
                eventTypeLabel: EVENT_VISUALS.earthquake.label,
                detail: `M${feature.properties?.mag ?? "?"} · 深度 ${coordinates[2] ?? "待核实"} km`,
              },
            };
          });
          const eonetFeatures: GeoJSON.Feature[] = (eonet.events || []).flatMap((event) => {
            const latest = event.geometry?.at(-1);
            if (latest?.type !== "Point" || !Array.isArray(latest.coordinates)) return [];
            const categoryTitles = (event.categories || [])
              .map((category) => category.title?.trim())
              .filter((title): title is string => Boolean(title));
            const eventKind = classifyEventKind(categoryTitles, event.title);
            const visual = EVENT_VISUALS[eventKind];
            const intensityByKind: Partial<Record<EventKind, number>> = {
              storm: 0.78,
              wildfire: 0.72,
              volcano: 0.7,
              flood: 0.66,
            };
            return [
              {
                type: "Feature",
                id: event.id,
                geometry: { type: "Point", coordinates: latest.coordinates },
                properties: {
                  title: event.title,
                  kind: eventKind,
                  signalId: event.id,
                  effectIntensity: intensityByKind[eventKind] ?? 0.58,
                  sourceLabel: "NASA EONET",
                  eventColor: visual.color,
                  eventTypeLabel: visual.label,
                  time: latest.date ?? "",
                  detail: categoryTitles.join(" · ") || visual.label,
                },
              },
            ];
          });
          collection = {
            type: "FeatureCollection",
            features: [...usgsFeatures, ...eonetFeatures],
          };
          synchronizationLabel = "事件流已同步";
        }
        const signals: SignalAnchor[] = collection.features.flatMap(
          (feature, index) => {
            if (feature.geometry?.type !== "Point") return [];
            const [lng, lat] = feature.geometry.coordinates;
            if (typeof lng !== "number" || typeof lat !== "number") return [];
            const properties = feature.properties || {};
            const id = String(
              properties.signalId ??
                feature.id ??
                `event-${index}-${lng}-${lat}`,
            );
            return [
              {
                id,
                lng,
                lat,
                intensity: Math.max(
                  0.3,
                  Math.min(1, Number(properties.effectIntensity) || 0.55),
                ),
                phase: hashUnit(id),
                kind: normalizeEventKind(properties.kind),
              } satisfies SignalAnchor,
            ];
          },
        );

        if (controller.signal.aborted) return;
        setEventSignals(signals);
        if (map && mapReady && map.getStyle()) {
          map.addSource("earth-events", { type: "geojson", data: collection || EMPTY_GEOJSON });
          map.addLayer({
          id: "event-ring",
          type: "circle",
          source: "earth-events",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 7, 4, 16],
            "circle-color": [
              "coalesce",
              ["get", "eventColor"],
              EVENT_VISUALS.other.color,
            ],
            "circle-opacity": 0.1,
            "circle-stroke-color": [
              "coalesce",
              ["get", "eventColor"],
              EVENT_VISUALS.other.color,
            ],
            "circle-stroke-opacity": 0.62,
            "circle-stroke-width": 1,
          },
          });
          map.addLayer({
          id: "event-core",
          type: "circle",
          source: "earth-events",
          paint: {
            "circle-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              1,
              5.5,
              4,
              8,
            ],
            "circle-color": [
              "coalesce",
              ["get", "eventColor"],
              EVENT_VISUALS.other.color,
            ],
            "circle-opacity": 0.62,
            "circle-stroke-color": "#fff3cf",
            "circle-stroke-width": 0.7,
          },
          });
        }
        setEventCount(collection.features.length);
        setEventStatus(synchronizationLabel);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setEventStatus("事件流暂时不可用");
          setEventCount(0);
          setEventSignals([]);
        }
      }
    };

    void loadEvents();
    return () => {
      controller.abort();
      clearEventLayers();
    };
  }, [activeChannel.id, mapReady]);

  useEffect(() => {
    const map = mapContainerRef.current?.__terrawatchMap ?? liveMap ?? mapRef.current;
    if (!map || !mapReady) return;
    const onEventClick = (event: MapMouseEvent) => {
      if (CHANNELS[activeIndexRef.current]?.id !== "events" || !map.getLayer("event-core")) return;
      const hitRadius = 18;
      const hitBox: [[number, number], [number, number]] = [
        [event.point.x - hitRadius, event.point.y - hitRadius],
        [event.point.x + hitRadius, event.point.y + hitRadius],
      ];
      const feature = map.queryRenderedFeatures(
        hitBox,
        { layers: ["event-core"] },
      )[0];
      if (!feature) return;
      const properties = feature.properties || {};
      const rawTime = properties.time;
      const parsedTime = rawTime ? new Date(rawTime) : null;
      const time =
        parsedTime && !Number.isNaN(parsedTime.getTime())
          ? parsedTime.toISOString().replace("T", " ").slice(0, 16) + " UTC"
          : "时间更新中";
      setSelectedEvent({
        id: String(properties.signalId || feature.id || "selected-event"),
        title: properties.title || properties.place || "地球事件",
        meta: time,
        detail: properties.detail || "等待更多已核实信息",
        source: properties.sourceLabel || "官方数据源",
        kindLabel:
          properties.eventTypeLabel ||
          EVENT_VISUALS[normalizeEventKind(properties.kind)].label,
      });
      if (feature.geometry.type === "Point") {
        const [rawLongitude, latitude] = feature.geometry.coordinates;
        if (
          typeof rawLongitude === "number" &&
          typeof latitude === "number" &&
          Number.isFinite(rawLongitude) &&
          Number.isFinite(latitude)
        ) {
          const targetLongitude =
            rawLongitude +
            Math.round((map.getCenter().lng - rawLongitude) / 360) * 360;
          const targetZoom = Math.min(
            map.getMaxZoom(),
            Math.max(map.getZoom(), 3.7),
          );
          setMapView({
            zoom: targetZoom,
            lng: targetLongitude,
            lat: latitude,
          });
          map.easeTo({
            center: [targetLongitude, latitude],
            zoom: targetZoom,
            bearing: 0,
            pitch: 0,
            duration: prefersReducedMotion ? 0 : 950,
            essential: false,
          });
        }
      }
    };
    const onMove = (event: MapMouseEvent) => {
      if (!map.getLayer("event-core")) return;
      const hitRadius = 12;
      const hitBox: [[number, number], [number, number]] = [
        [event.point.x - hitRadius, event.point.y - hitRadius],
        [event.point.x + hitRadius, event.point.y + hitRadius],
      ];
      map.getCanvas().style.cursor = map.queryRenderedFeatures(
        hitBox,
        { layers: ["event-core"] },
      ).length
        ? "pointer"
        : "grab";
    };
    map.on("click", onEventClick);
    map.on("mousemove", onMove);
    return () => {
      map.off("click", onEventClick);
      map.off("mousemove", onMove);
    };
  }, [mapReady, prefersReducedMotion]);

  const onChannelWheel = (event: React.WheelEvent<HTMLElement>) => {
    event.stopPropagation();
    if (Math.abs(event.deltaY) < 12 || wheelLockRef.current) return;
    wheelLockRef.current = true;
    moveChannel(event.deltaY > 0 ? 1 : -1);
    window.setTimeout(() => {
      wheelLockRef.current = false;
    }, 460);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    dragStartRef.current = event.clientY;
    dragDirectionRef.current = event.pointerType === "touch" ? -1 : 1;
    dragStepRef.current = wheelPositionRef.current;
    dragTargetRef.current = wheelStepRef.current;
    dragMovedRef.current = false;
    setWheelDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (dragStartRef.current === null) return;
    const distance =
      (dragStartRef.current - event.clientY) * dragDirectionRef.current;
    if (Math.abs(distance) > 7) dragMovedRef.current = true;
    const position = dragStepRef.current + distance / 54;
    wheelPositionRef.current = position;
    setWheelPosition(position);
    const target = Math.round(position);
    if (target === dragTargetRef.current) return;
    dragTargetRef.current = target;
    wheelStepRef.current = target;
    setActiveIndex(modulo(target, CHANNEL_COUNT));
    setSelectedEvent(null);
    setEventSignals([]);
  };

  const endDrag = () => {
    if (dragStartRef.current === null) return;
    dragStartRef.current = null;
    setWheelDragging(false);
    activateWheelStep(Math.round(wheelPositionRef.current));
  };

  const focusRegion = (region: (typeof REGION_VIEWS)[number]) => {
    const map = mapContainerRef.current?.__terrawatchMap ?? liveMap ?? mapRef.current;
    const targetZoom = map ? Math.max(region.zoom, map.getMinZoom()) : region.zoom;
    const targetLongitude = map
      ? region.center[0] +
        Math.round((map.getCenter().lng - region.center[0]) / 360) * 360
      : region.center[0];
    const targetCenter: [number, number] = [targetLongitude, region.center[1]];
    setMapView({
      zoom: targetZoom,
      lng: targetLongitude,
      lat: region.center[1],
    });
    if (!map) return;
    map.easeTo({
      center: targetCenter,
      zoom: targetZoom,
      bearing: 0,
      pitch: 0,
      duration: prefersReducedMotion ? 0 : 900,
      essential: false,
    });
  };
  const displayLongitude = wrapLongitude(mapView.lng);

  return (
    <main className={`console channel-${activeChannel.id}`}>
      {/* The WMS image keeps the observatory useful when WebGL is unavailable. */}
      {!mapReady && (
        <div className="map-fallback" aria-hidden="true">
          <div className="map-fallback-track">
            {fallbackImages.map((image, index) => (
              // These are dynamic NASA WMS responses, not optimizable assets.
              // eslint-disable-next-line @next/next/no-img-element
              <img key={image} src={image} alt="" data-hemisphere={index} />
            ))}
          </div>
        </div>
      )}
      <div className="map-stage" ref={mapContainerRef} aria-label="全球地球观测地图" />
      {activeVectorMode && activeVectorGrid && (
        <VectorFieldCanvas
          map={mapInstance}
          view={mapView}
          reduceMotion={prefersReducedMotion}
          grid={activeVectorGrid}
          mode={activeVectorMode}
        />
      )}
      {activeEffectMode && (
        <PhenomenaCanvas
          mode={activeEffectMode}
          map={mapInstance}
          view={mapView}
          anchors={
            activeEffectMode === "events" ? eventSignals : rasterSignals
          }
          selectedSignalId={selectedEvent?.id}
          reduceMotion={prefersReducedMotion}
        />
      )}
      <div className="map-vignette" aria-hidden="true" />
      <div className="scanlines" aria-hidden="true" />

      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <h1>TERRAWATCH</h1>
            <p>AI EARTH OBSERVATORY · PROTOTYPE 01</p>
          </div>
        </div>
        <div className="utc-clock">
          <span className="earth-time-orbit" aria-hidden="true">
            <i />
            <span />
          </span>
          <div>
            <b>EARTH TIME · UTC</b>
            <time dateTime={earthTime?.toISOString()}>
              {earthTime
                ? earthTime.toISOString().replace("T", " ").slice(0, 19)
                : `${observationDate} · SYNC`}
            </time>
          </div>
        </div>
      </header>

      <section className="channel-readout">
        <span className="channel-number">CH / {activeChannel.code}</span>
        <h2>{activeChannel.name}</h2>
        <p>{activeChannel.subtitle}</p>
        <div className="readout-signal-row">
          <ChannelSignalIcon key={activeChannel.id} channel={activeChannel.id} />
          <div
            className="readout-line"
            style={{ backgroundColor: activeChannel.color }}
          />
        </div>
        {showsLatestObservation && (
          <div className="latest-readout">
            <span>LATEST AVAILABLE OBSERVATION</span>
            <time>{observationDate} · UTC</time>
            <small>FIXED CURRENT SNAPSHOT · NO TIME PLAYBACK</small>
          </div>
        )}
        {activeVectorGrid && (
          <div className="latest-readout">
            <span>LATEST VECTOR ANALYSIS</span>
            <time>{activeVectorGrid.validTime.replace("T", " ").replace("Z", " UTC")}</time>
            <small>{activeVectorGrid.units} · {activeVectorGrid.latency}</small>
          </div>
        )}
      </section>

      <div className="reticle" aria-hidden="true">
        <span className="reticle-x" />
        <span className="reticle-y" />
        <i>+</i>
      </div>

      <aside className="telemetry-panel">
        <p className="eyebrow">ACTIVE FEED</p>
        <div className="signal-chart" aria-hidden="true">
          {Array.from({ length: 24 }, (_, index) => (
            <i
              key={index}
              style={{
                height: `${18 + ((index * 17 + activeIndex * 23) % 62)}%`,
                backgroundColor: activeChannel.color,
              }}
            />
          ))}
        </div>
        <dl>
          <div>
            <dt>数据源</dt>
            <dd>{activeVectorGrid?.source ?? activeChannel.source}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>
              {activeChannel.id === "events"
                ? eventStatus
                : activeVectorMode
                  ? vectorStatus === "loading"
                    ? "正在读取最新矢量网格…"
                    : vectorStatus === "unavailable"
                      ? "真实数据暂不可用"
                      : activeVectorGrid?.latency ?? activeChannel.latency
                : showsLatestObservation
                  ? `${activeChannel.latency} · 仅显示最近可用观测`
                  : activeChannel.latency}
            </dd>
          </div>
          {activeChannel.id === "events" && (
            <div>
              <dt>当前信号</dt>
              <dd>{eventCount === null ? "—" : eventCount}</dd>
            </div>
          )}
          {(activeChannel.id === "rain" || activeChannel.id === "heat") && (
            <div>
              <dt>动态增强</dt>
              <dd>
                {rasterEffectStatus === "loading"
                  ? "读取当前影像色阶…"
                  : rasterEffectStatus === "unavailable"
                    ? "当前帧暂无增强信号"
                    : activeChannel.id === "heat"
                      ? "暖区蒸腾 · 非温度读数"
                      : "降水信号 · 非雨滴轨迹"}
              </dd>
            </div>
          )}
          {activeChannel.id === "events" && (
            <div>
              <dt>事件特效</dt>
              <dd>类别图标 · 坐标水波纹</dd>
            </div>
          )}
        </dl>
      </aside>

      {selectedEvent && (
        <article className="event-card">
          <button onClick={() => setSelectedEvent(null)} aria-label="关闭事件卡片">
            ×
          </button>
          <p>SELECTED SIGNAL · {selectedEvent.kindLabel}</p>
          <h3>{selectedEvent.title}</h3>
          <time>{selectedEvent.meta}</time>
          <strong>{selectedEvent.detail}</strong>
          <span>{selectedEvent.source} · 信息可能继续更新</span>
        </article>
      )}

      <aside
        className={`channel-wheel${wheelDragging ? " dragging" : ""}`}
        onWheel={onChannelWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="listbox"
        aria-label="观测频道选择轮；可滚动或上下拖动"
        aria-activedescendant={`channel-${activeChannel.id}`}
        tabIndex={0}
      >
        <div className="wheel-drum" aria-hidden="true">
          <i />
          <i />
        </div>
        <div className="wheel-rail" aria-hidden="true">
          <span />
        </div>
        <div className="wheel-window" aria-hidden="true" />
        <div
          className="wheel-list"
          style={
            {
              "--reel-angle": `${-wheelPosition * (360 / CHANNEL_COUNT)}deg`,
            } as React.CSSProperties
          }
        >
          {CHANNELS.map((channel, index) => {
            const rawDistance = modulo(index - activeIndex, CHANNEL_COUNT);
            const signedDistance =
              rawDistance > CHANNEL_COUNT / 2
                ? rawDistance - CHANNEL_COUNT
                : rawDistance;
            const distance = Math.abs(signedDistance);
            return (
              <button
                id={`channel-${channel.id}`}
                key={channel.id}
                role="option"
                tabIndex={-1}
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "active" : ""}
                style={
                  {
                    "--item-angle": `${index * (360 / CHANNEL_COUNT)}deg`,
                    "--slot-opacity":
                      index === activeIndex
                        ? 1
                        : Math.max(0.28, 1.06 - distance * 0.2),
                    "--slot-blur":
                      distance === 0
                        ? "0px"
                        : `${Math.min(1.1, distance * 0.28)}px`,
                    pointerEvents: distance <= 2 ? "auto" : "none",
                  } as React.CSSProperties
                }
                onClick={() => {
                  if (dragMovedRef.current) {
                    dragMovedRef.current = false;
                    return;
                  }
                  selectChannel(index);
                }}
              >
                <span className="wheel-code">{channel.code}</span>
                <span className="wheel-copy">
                  <b>{channel.name}</b>
                  <small>{channel.subtitle}</small>
                </span>
              </button>
            );
          })}
        </div>
        <p>INFINITE REEL · SCROLL / DRAG</p>
      </aside>

      <nav className="region-controls" aria-label="洲级观测视角">
        <WorldRegionNavigator onFocus={focusRegion} />
      </nav>

      <footer className="bottombar">
        <p>
          鼠标滚轮缩放 · 东西向拖动 · 单一世界边界 · 洲际方格定位 · 始终北向 ·
          地图标注 © OpenStreetMap contributors © CARTO
        </p>
        <p>
          ZOOM {mapView.zoom.toFixed(1)} · {Math.abs(mapView.lat).toFixed(1)}°
          {mapView.lat >= 0 ? "N" : "S"} · {Math.abs(displayLongitude).toFixed(1)}°
          {displayLongitude >= 0 ? "E" : "W"} · NORTH 0°
        </p>
      </footer>
    </main>
  );
}
