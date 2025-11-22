// Davisboro Hunt Console
// Map + waypoints + deer odds + moon phase + sunrise/sunset + 7-day planner + stand wind matching

const defaultLat = 32.97904;
const defaultLon = -82.60791;
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

// ✅ Your MapTiler key (satellite layer)
const MAPTILER_KEY = "dKj67SEDLftsSLKxGfjB";

// 🌙 Moon phase API (ViewBits – no key needed, light rate limits)
// Docs: https://viewbits.com/docs/moon-phase-api-documentation
const MOON_PHASE_API_URL = "https://api.viewbits.com/v1/moonphase";

// Simple in-memory cache for moon results keyed by date ("YYYY-MM-DD")
const moonCache = new Map();

function $(id) {
  return document.getElementById(id);
}

function clamp(x, a, b) {
  return Math.min(b, Math.max(a, x));
}

function toF(c) {
  return (c * 9) / 5 + 32;
}

function formatDateISO(date) {
  return date.toISOString().slice(0, 10);
}

function classifyScore(score) {
  if (score >= 76) return "great";
  if (score >= 61) return "good";
  if (score >= 41) return "ok";
  return "bad";
}

function scoreLabel(score) {
  const cls = classifyScore(score);
  if (cls === "great") return "🔥 Great – if you can hunt, go.";
  if (cls === "good") return "👍 Good – solid odds.";
  if (cls === "ok") return "🤔 Okay – not prime, but could produce.";
  return "😬 Tough – low odds unless you’re after a specific buck.";
}

function scoreHeadline(score) {
  const cls = classifyScore(score);
  if (cls === "great") return "Prime window";
  if (cls === "good") return "Worth hunting";
  if (cls === "ok") return "Borderline";
  return "Tough conditions";
}

function degreeToCompass(deg) {
  if (deg == null || isNaN(deg)) return "";
  const dirs = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW"
  ];
  const idx = Math.round(((deg % 360) / 22.5)) % 16;
  return dirs[idx];
}

function shortClock(date) {
  if (!date) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
}

// --- Rut + factors ---

function dayOfYear(year, month, day) {
  return Math.floor(
    (Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / 86400000
  );
}

// Rough Washington Co. GA rut model
function rutPhaseForDate(date) {
  const year = date.getUTCFullYear();
  const doy = dayOfYear(year, date.getUTCMonth() + 1, date.getUTCDate());

  const oct20 = dayOfYear(year, 10, 20);
  const oct27 = dayOfYear(year, 10, 27);
  const nov2 = dayOfYear(year, 11, 2);
  const nov3 = dayOfYear(year, 11, 3);
  const nov10 = dayOfYear(year, 11, 10);
  const nov11 = dayOfYear(year, 11, 11);
  const nov25 = dayOfYear(year, 11, 25);
  const nov26 = dayOfYear(year, 11, 26);
  const dec5 = dayOfYear(year, 12, 5);

  let phase = "Early season";
  let factor = 0.5;

  if (doy >= oct20 && doy <= oct26) {
    phase = "Pre-rut";
    factor = 0.75;
  } else if (doy >= oct27 && doy <= nov2) {
    phase = "Peak rut";
    factor = 1.0;
  } else if (doy >= nov3 && doy <= nov10) {
    phase = "Lockdown";
    factor = 0.65;
  } else if (doy >= nov11 && doy <= nov25) {
    phase = "Post-rut";
    factor = 0.8;
  } else if (doy >= nov26 && doy <= dec5) {
    phase = "Second rut";
    factor = 0.9;
  } else if (doy > dec5) {
    phase = "Late season";
    factor = 0.55;
  }

  return { phase, factor };
}

function timeOfDayFactor(key) {
  switch (key) {
    case "morning":
    case "evening":
      return 1.0;
    case "allday":
      return 0.85;
    case "midday":
    default:
      return 0.65;
  }
}

function tempFactorF(tempF) {
  if (tempF >= 30 && tempF <= 55) return 1.0;
  if ((tempF >= 20 && tempF < 30) || (tempF > 55 && tempF <= 65)) return 0.85;
  return 0.6;
}

function windFactor(windMph) {
  if (windMph <= 5) return 1.0;
  if (windMph <= 10) return 0.9;
  if (windMph <= 15) return 0.7;
  if (windMph <= 20) return 0.5;
  return 0.35;
}

function precipFactor(mm) {
  if (mm == null) return 1.0;
  if (mm < 0.1) return 1.0;
  if (mm < 1) return 0.8;
  return 0.6;
}

function pressureFactor(hpa) {
  if (!hpa) return 1.0;
  if (hpa >= 1015) return 1.0;
  if (hpa >= 1005) return 0.9;
  if (hpa >= 995) return 0.75;
  return 0.6;
}

function prettyTerrain(t) {
  if (t === "pines") return "pines / clear-cut";
  if (t === "hardwoods") return "hardwoods / draws";
  if (t === "ag") return "ag / edges";
  return "mixed habitat";
}

function prettyTime(key) {
  if (key === "morning") return "morning";
  if (key === "midday") return "mid-day";
  if (key === "evening") return "evening";
  if (key === "allday") return "all-day sit";
  return key;
}

function prettyPressureLevel(p) {
  if (p === "low") return "low pressure";
  if (p === "high") return "high pressure";
  return "medium pressure";
}

// --- Weather helpers (Open-Meteo) ---

async function fetchWeather(lat, lon, date) {
  const dateStr = formatDateISO(date);
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "temperature_2m,wind_speed_10m,precipitation,pressure_msl",
    daily:
      "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,sunrise,sunset",
    timezone: "auto",
    start_date: dateStr,
    end_date: dateStr
  });
  const res = await fetch(OPEN_METEO_URL + "?" + params.toString());
  if (!res.ok) throw new Error("Weather request failed: " + res.status);
  return res.json();
}

function pickHourlyForTime(data, date, timeKey) {
  const times = data.hourly?.time || [];
  let targetHour = 8; // morning
  if (timeKey === "midday") targetHour = 13;
  else if (timeKey === "evening") targetHour = 17;
  else if (timeKey === "allday") targetHour = 15;

  let bestIndex = 0;
  let bestDiff = Infinity;

  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]);
    if (
      t.getFullYear() === date.getFullYear() &&
      t.getMonth() === date.getMonth() &&
      t.getDate() === date.getDate()
    ) {
      const diff = Math.abs(t.getHours() - targetHour);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIndex = i;
      }
    }
  }

  return {
    index: bestIndex,
    tempC: data.hourly.temperature_2m[bestIndex],
    windMs: data.hourly.wind_speed_10m[bestIndex],
    precipMm: data.hourly.precipitation[bestIndex],
    pressureHpa: data.hourly.pressure_msl[bestIndex]
  };
}

// --- Moon helpers (ViewBits Moon Phase API) ---

function describeMoonForHunting(phase, illumNum) {
  if (illumNum == null || isNaN(illumNum)) {
    return "Moon factor is minor vs wind, pressure, and rut – focus more on those.";
  }

  if (illumNum >= 85) {
    return "Very bright nights can pull feeding into the night; watch for mid-morning or mid-day movement near cover and bedding edges.";
  }
  if (illumNum <= 15) {
    return "Dark moon nights keep deer tight to cover but often on their feet closer to dawn and last light.";
  }
  if (illumNum >= 45 && illumNum <= 70) {
    return "Balanced moonlight – expect classic morning/evening movement with some bonus mid-session activity on good weather days.";
  }
  return "Moderate moonlight – not usually a game-changer by itself, but it can nudge activity toward the edges of daylight.";
}

// Get moon data for a specific calendar date
async function fetchMoonPhaseForDate(date) {
  const dateStr = formatDateISO(date);
  if (moonCache.has(dateStr)) {
    return moonCache.get(dateStr);
  }

  const url = MOON_PHASE_API_URL + "?startdate=" + dateStr;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Moon phase request failed: " + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  const exact = arr.find((x) => x.date === dateStr) || arr[3] || arr[0];
  moonCache.set(dateStr, exact);
  return exact;
}

// Get a window of moon data around a start date for planner (7 days)
async function fetchMoonPhaseForPlanner(startDate, days) {
  const center = new Date(startDate);
  center.setDate(center.getDate() + Math.floor(days / 2)); // start+3 for 7 days
  const centerStr = formatDateISO(center);
  const url = MOON_PHASE_API_URL + "?startdate=" + centerStr;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Moon phase planner request failed: " + res.status);
  const arr = await res.json();
  const map = {};
  if (Array.isArray(arr)) {
    for (const item of arr) {
      if (item && item.date) {
        map[item.date] = item;
        moonCache.set(item.date, item);
      }
    }
  }
  return map;
}

// Build composite score (rut + time + weather + pressure)
function buildLiveScorePieces(params) {
  const {
    date,
    timeKey,
    tempF,
    windMph,
    precipMm,
    pressureHpa,
    terrain,
    pressureLevel
  } = params;

  const { phase, factor: rutF } = rutPhaseForDate(date);
  const timeF = timeOfDayFactor(timeKey);
  const tempFScore = tempFactorF(tempF);
  const windF = windFactor(windMph);
  const precipF = precipFactor(precipMm);
  const pressF = pressureFactor(pressureHpa);

  const terrainF =
    terrain === "pines" ? 1.0 : terrain === "mixed" ? 0.95 : 0.9;

  const pressurePenalty =
    pressureLevel === "high" ? 0.9 : pressureLevel === "low" ? 1.05 : 1.0;

  let score =
    (rutF * 0.35 +
      timeF * 0.2 +
      tempFScore * 0.18 +
      windF * 0.14 +
      precipF * 0.08 +
      pressF * 0.05 -
      (1 - terrainF) * 0.05) *
    100 *
    pressurePenalty;

  score = clamp(Math.round(score), 0, 100);

  return {
    score,
    phase,
    rutF,
    timeF,
    tempFScore,
    windF,
    precipF,
    pressF,
    pressureHpa
  };
}

// --- Map + waypoints ---

const waypointTypeStyles = {
  Feeder: { color: "#f97316" },
  Stand: { color: "#22c55e" },
  "Ground Blind": { color: "#a16207" },
  TrailCam: { color: "#a855f7" }, // internal convenience key
  "Trail Cam": { color: "#a855f7" },
  Other: { color: "#38bdf8" }
};

let map;
let centerMarker;
let addingWaypoint = false;
const waypointMarkers = new Map();
let waypointData = [];
let editingWaypointId = null;

// Planner wind / date used for stand matching
let currentPlannerWindDeg = null;
let currentPlannerDateText = "";

// --- Map init ---

function initMap() {
  map = L.map("map").setView([defaultLat, defaultLon], 14);

  const streets = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }
  ).addTo(map);

  const terrain = L.tileLayer(
    "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 17,
      attribution:
        'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>'
    }
  );

  const baseLayers = {
    Streets: streets,
    Terrain: terrain
  };

  if (MAPTILER_KEY && MAPTILER_KEY.trim() !== "") {
    const satellite = L.tileLayer(
      "https://api.maptiler.com/maps/hybrid/{z}/{x}/{y}.jpg?key=" +
        MAPTILER_KEY,
      {
        maxZoom: 20,
        attribution:
          '&copy; <a href="https://www.maptiler.com/">MapTiler</a> &copy; OpenStreetMap contributors'
      }
    );
    baseLayers["Satellite"] = satellite;
  }

  L.control.layers(baseLayers, null, { position: "topright" }).addTo(map);
  L.control.scale().addTo(map);

  centerMarker = L.marker([defaultLat, defaultLon], { draggable: true })
    .addTo(map)
    .bindPopup("Hunt center");

  centerMarker.on("dragend", (e) => {
    const latlng = e.target.getLatLng();
    syncCoordInputs(latlng.lat, latlng.lng, true);
  });

  map.on("click", (e) => {
    if (addingWaypoint) {
      syncWaypointCoordInputs(e.latlng.lat, e.latlng.lng);
      addingWaypoint = false;
      const btn = $("btn-add-waypoint");
      if (btn) btn.classList.remove("map-mode-active");
      window.location.hash = "#map-waypoints";
      const nameInput = $("wp-name");
      if (nameInput) nameInput.focus();
    } else {
      centerMarker.setLatLng(e.latlng);
      syncCoordInputs(e.latlng.lat, e.latlng.lng, true);
    }
  });

  buildLegend();
  loadWaypointsFromStorage();
}

function buildLegend() {
  const legend = $("map-legend");
  if (!legend) return;
  legend.innerHTML = "";
  ["Stand", "Ground Blind", "Feeder", "Trail Cam", "Other"].forEach(
    (type) => {
      const style = waypointTypeStyles[type] || waypointTypeStyles.Other;
      const div = document.createElement("div");
      div.className = "legend-item";
      const swatch = document.createElement("div");
      swatch.className = "legend-swatch";
      swatch.style.backgroundColor = style.color;
      const label = document.createElement("span");
      label.textContent = type;
      div.appendChild(swatch);
      div.appendChild(label);
      legend.appendChild(div);
    }
  );
}

function syncCoordInputs(lat, lon, alsoPlanner) {
  const latStr = lat.toFixed(6);
  const lonStr = lon.toFixed(6);
  const liveLat = $("live-lat");
  const liveLon = $("live-lon");
  if (liveLat) liveLat.value = latStr;
  if (liveLon) liveLon.value = lonStr;
  if (alsoPlanner) {
    const planLat = $("plan-lat");
    const planLon = $("plan-lon");
    if (planLat) planLat.value = latStr;
    if (planLon) planLon.value = lonStr;
  }
}

function syncWaypointCoordInputs(lat, lon) {
  const latStr = lat.toFixed(6);
  const lonStr = lon.toFixed(6);
  const wpLat = $("wp-lat");
  const wpLon = $("wp-lon");
  if (wpLat) wpLat.value = latStr;
  if (wpLon) wpLon.value = lonStr;
}

function getCoordsFromInputs(latId, lonId) {
  const latEl = $(latId);
  const lonEl = $(lonId);
  let lat = parseFloat(latEl?.value);
  let lon = parseFloat(lonEl?.value);
  if (isNaN(lat) || isNaN(lon)) {
    lat = defaultLat;
    lon = defaultLon;
  }
  return { lat, lon };
}

// --- Live odds UI ---

function getLiveFormValues() {
  const dateStr = $("live-date").value;
  if (!dateStr) return null;
  const date = new Date(dateStr + "T12:00:00");

  const timeKey =
    document.querySelector('input[name="live-time"]:checked')?.value ||
    "morning";
  const terrain =
    document.querySelector('input[name="live-terrain"]:checked')?.value ||
    "pines";
  const pressureLevel =
    document.querySelector('input[name="live-pressure"]:checked')?.value ||
    "medium";

  const { lat, lon } = getCoordsFromInputs("live-lat", "live-lon");

  return { date, timeKey, terrain, pressureLevel, lat, lon };
}

function setLiveLoading(isLoading) {
  const btn = $("btn-live-run");
  if (!btn) return;
  btn.disabled = isLoading;
  btn.textContent = isLoading ? "Loading weather…" : "⚡ Get live odds";
}

async function runLiveOdds() {
  const vals = getLiveFormValues();
  if (!vals) return;

  setLiveLoading(true);

  try {
    const { date, timeKey, terrain, pressureLevel, lat, lon } = vals;
    const data = await fetchWeather(lat, lon, date);
    const h = pickHourlyForTime(data, date, timeKey);

    const tempF = toF(h.tempC);
    const windMph = h.windMs * 2.23694;

    const pieces = buildLiveScorePieces({
      date,
      timeKey,
      tempF,
      windMph,
      precipMm: h.precipMm,
      pressureHpa: h.pressureHpa,
      terrain,
      pressureLevel
    });

    let moonInfo = null;
    try {
      moonInfo = await fetchMoonPhaseForDate(date);
    } catch (moonErr) {
      console.warn("Moon phase fetch failed:", moonErr);
    }

    renderLiveResults(pieces, vals, h, moonInfo);
  } catch (err) {
    console.error(err);
    renderLiveError(err);
  } finally {
    setLiveLoading(false);
  }
}

function renderLiveResults(pieces, vals, hourly, moonInfo) {
  const badge = $("score-badge");
  const bar = $("score-bar");
  const label = $("score-label");
  const factorGrid = $("factor-grid");
  const analysisNote = $("analysis-note");

  const {
    score,
    phase,
    rutF,
    timeF,
    tempFScore,
    windF,
    precipF,
    pressF,
    pressureHpa
  } = pieces;

  const cls = classifyScore(score);
  badge.className = "score-badge " + cls;
  badge.textContent = "Score " + score;

  bar.style.width = score + "%";
  label.textContent = scoreLabel(score);

  factorGrid.innerHTML = "";

  const tempF = toF(hourly.tempC);
  const windMph = hourly.windMs * 2.23694;
  const precipMm = hourly.precipMm ?? 0;

  // Parse moon info (if available)
  let moonPhaseText = null;
  let moonIllumNum = null;
  if (moonInfo && moonInfo.phase) {
    const illumRaw = moonInfo.illumination;
    if (typeof illumRaw === "number") {
      moonIllumNum = illumRaw * (illumRaw <= 1 ? 100 : 1); // handle 0.4 vs 40
    } else if (typeof illumRaw === "string") {
      moonIllumNum = parseFloat(illumRaw);
    }
    const illumLabel =
      moonIllumNum != null && !isNaN(moonIllumNum)
        ? `${moonIllumNum.toFixed(1)}%`
        : moonInfo.illumination || "";
    moonPhaseText = `${moonInfo.phase} (${illumLabel})`;
  }

  const factors = [
    {
      title: "Rut phase",
      value: phase,
      detail: "Rut factor " + Math.round(rutF * 100) + "%"
    },
    {
      title: "Time of day",
      value: prettyTime(vals.timeKey),
      detail: "Time factor " + Math.round(timeF * 100) + "%"
    },
    {
      title: "Temperature",
      value: Math.round(tempF) + "°F",
      detail: "Temp factor " + Math.round(tempFScore * 100) + "%"
    },
    {
      title: "Wind",
      value: Math.round(windMph) + " mph",
      detail: "Wind factor " + Math.round(windF * 100) + "%"
    },
    {
      title: "Precip",
      value:
        precipMm.toFixed(2) +
        " mm/hr" +
        (precipMm >= 0.1 ? " (wet)" : " (dry)"),
      detail: "Precip factor " + Math.round(precipF * 100) + "%"
    },
    {
      title: "Pressure",
      value: pressureHpa ? Math.round(pressureHpa) + " hPa" : "Unknown",
      detail: "Pressure factor " + Math.round(pressF * 100) + "%"
    }
  ];

  if (moonPhaseText) {
    factors.push({
      title: "Moon",
      value: moonPhaseText,
      detail: describeMoonForHunting(moonInfo.phase, moonIllumNum)
    });
  }

  for (const f of factors) {
    const div = document.createElement("div");
    div.className = "factor";
    const strong = document.createElement("strong");
    strong.textContent = f.title;
    const span1 = document.createElement("span");
    span1.textContent = f.value;
    const br = document.createElement("br");
    const span2 = document.createElement("span");
    span2.textContent = f.detail;
    div.appendChild(strong);
    div.appendChild(span1);
    div.appendChild(br);
    div.appendChild(span2);
    factorGrid.appendChild(div);
  }

  const terrainLabel = prettyTerrain(vals.terrain);
  const pressureText = prettyPressureLevel(vals.pressureLevel);

  const notes = [];

  notes.push(
    `For this ${terrainLabel} setup with ${pressureText}, we’re in the ${phase.toLowerCase()} window.`
  );

  if (tempF < 30) {
    notes.push(
      "Cold: deer may move a bit later in the morning but will still use obvious food sources."
    );
  } else if (tempF > 65) {
    notes.push(
      "Warm: expect movement closer to first and last light, especially in shade or near water."
    );
  } else {
    notes.push("Comfortable temps for movement, especially on travel routes.");
  }

  if (windMph <= 5) {
    notes.push(
      "Light wind: thermals and subtle shifts matter. Be strict on entry and exit."
    );
  } else if (windMph <= 12) {
    notes.push(
      "Good, huntable wind: you can get away with more aggressive sits if access is clean."
    );
  } else {
    notes.push(
      "Windy: focus on leeward cover, bottoms, and areas where deer tuck out of the wind."
    );
  }

  if (precipMm >= 0.1) {
    notes.push(
      "Rain in the mix: watch right before or after the rain for a possible movement spike."
    );
  }

  if (moonPhaseText && moonIllumNum != null && !isNaN(moonIllumNum)) {
    notes.push(describeMoonForHunting(moonInfo.phase, moonIllumNum));
  }

  analysisNote.textContent = notes.join(" ");
}

function renderLiveError(err) {
  const badge = $("score-badge");
  const bar = $("score-bar");
  const label = $("score-label");
  const factorGrid = $("factor-grid");
  const analysisNote = $("analysis-note");

  badge.className = "score-badge bad";
  badge.textContent = "Error";
  bar.style.width = "0%";
  label.textContent =
    "Could not load weather. Check your connection / coordinates and try again.";
  factorGrid.innerHTML = "";
  analysisNote.textContent = err?.message || "";
}

// --- Waypoints storage + UI ---

function loadWaypointsFromStorage() {
  try {
    const raw = localStorage.getItem("hunt_waypoints_v1");
    waypointData = raw ? JSON.parse(raw) || [] : [];
  } catch {
    waypointData = [];
  }

  waypointMarkers.forEach((m) => {
    if (map) map.removeLayer(m);
  });
  waypointMarkers.clear();

  waypointData.forEach(addWaypointMarker);
  renderWaypointTable();
}

function saveWaypointsToStorage() {
  try {
    localStorage.setItem("hunt_waypoints_v1", JSON.stringify(waypointData));
  } catch {
    // ignore storage errors
  }
}

function createWaypoint(fields) {
  return {
    id:
      fields.id ||
      "wp_" +
        Date.now().toString(36) +
        "_" +
        Math.random().toString(36).slice(2, 8),
    name: fields.name || "",
    type: fields.type || "Stand",
    lat: fields.lat,
    lon: fields.lon,
    notes: fields.notes || "",
    bestWind: fields.bestWind || "",
    terrainTag: fields.terrainTag || ""
  };
}

function addWaypointMarker(wp) {
  if (!map) return;
  const style = waypointTypeStyles[wp.type] || waypointTypeStyles.Other;
  const marker = L.circleMarker([wp.lat, wp.lon], {
    radius: 7,
    weight: 2,
    color: style.color,
    fillColor: style.color,
    fillOpacity: 0.9
  }).addTo(map);

  marker.on("click", () => {
    map.setView([wp.lat, wp.lon], Math.max(map.getZoom(), 17));
  });

  waypointMarkers.set(wp.id, marker);
}

function removeWaypointMarker(id) {
  const marker = waypointMarkers.get(id);
  if (marker && map) map.removeLayer(marker);
  waypointMarkers.delete(id);
}

function windStringToDeg(dir) {
  switch (dir) {
    case "N":
      return 0;
    case "NE":
      return 45;
    case "E":
      return 90;
    case "SE":
      return 135;
    case "S":
      return 180;
    case "SW":
      return 225;
    case "W":
      return 270;
    case "NW":
      return 315;
    default:
      return null;
  }
}

function computeStandMatch(bestWind, actualDeg) {
  const idealDeg = windStringToDeg(bestWind);
  if (idealDeg == null || actualDeg == null || isNaN(actualDeg)) return null;

  let diff = Math.abs(actualDeg - idealDeg);
  if (diff > 180) diff = 360 - diff;

  let label = "Poor";
  let cls = "bad";
  let score = 0;
  let text = "Wind is not ideal; only hunt if access is bulletproof.";

  if (diff <= 30) {
    label = "Great";
    cls = "great";
    score = 3;
    text = "Wind almost perfect for this stand – great choice if other factors line up.";
  } else if (diff <= 60) {
    label = "Good";
    cls = "good";
    score = 2;
    text = "Wind is workable – solid option if you manage entry/exit carefully.";
  } else if (diff <= 90) {
    label = "Okay";
    cls = "ok";
    score = 1;
    text = "Borderline wind – might work if pressure is low and deer aren’t edgy.";
  }

  return { label, cls, score, text, diff };
}

function renderWaypointTable() {
  const tbody = $("waypoint-list");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!waypointData.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.textContent =
      "No waypoints yet. Turn on “Add waypoint”, click the map, then save details here.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  waypointData.forEach((wp) => {
    const tr = document.createElement("tr");
    tr.dataset.id = wp.id;

    const tdName = document.createElement("td");
    const pillType = document.createElement("span");
    pillType.className = "pill";
    pillType.textContent = wp.type;
    tdName.appendChild(document.createTextNode((wp.name || "(unnamed)") + " "));
    tdName.appendChild(pillType);

    const tdCoords = document.createElement("td");
    tdCoords.textContent = wp.lat.toFixed(5) + ", " + wp.lon.toFixed(5);

    const tdSetup = document.createElement("td");
    const terrainLabel = wp.terrainTag
      ? prettyTerrain(wp.terrainTag)
      : "No terrain tag";
    const bestWindLabel = wp.bestWind
      ? `Best wind: ${wp.bestWind}`
      : "Best wind: any";
    tdSetup.textContent = terrainLabel + " • " + bestWindLabel;

    const tdMatch = document.createElement("td");
    if (
      currentPlannerWindDeg != null &&
      wp.bestWind &&
      windStringToDeg(wp.bestWind) != null
    ) {
      const match = computeStandMatch(wp.bestWind, currentPlannerWindDeg);
      if (match) {
        const pill = document.createElement("span");
        pill.className = "pill " + match.cls;
        pill.textContent = `${match.label} wind`;
        tdMatch.appendChild(pill);
      } else {
        tdMatch.textContent = "—";
      }
    } else {
      tdMatch.textContent = "Set best wind + run plan";
    }

    const tdActions = document.createElement("td");
    const zoomBtn = document.createElement("button");
    zoomBtn.type = "button";
    zoomBtn.className = "secondary small";
    zoomBtn.textContent = "Zoom";
    zoomBtn.dataset.action = "zoom";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "secondary small";
    editBtn.style.marginLeft = "0.25rem";
    editBtn.textContent = "Edit";
    editBtn.dataset.action = "edit";

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "danger small";
    delBtn.style.marginLeft = "0.25rem";
    delBtn.textContent = "Delete";
    delBtn.dataset.action = "delete";

    tdActions.appendChild(zoomBtn);
    tdActions.appendChild(editBtn);
    tdActions.appendChild(delBtn);

    tr.appendChild(tdName);
    tr.appendChild(tdCoords);
    tr.appendChild(tdSetup);
    tr.appendChild(tdMatch);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  });
}

function onWaypointFormSubmit(e) {
  e.preventDefault();
  const name = $("wp-name").value.trim();
  const type = $("wp-type").value || "Stand";
  const latVal = parseFloat($("wp-lat").value);
  const lonVal = parseFloat($("wp-lon").value);
  const notes = $("wp-notes").value.trim();
  const bestWind = $("wp-best-wind").value || "";
  const terrainTag = $("wp-terrain").value || "";

  if (isNaN(latVal) || isNaN(lonVal)) {
    alert("Please click the map or enter lat/lon for the waypoint.");
    return;
  }

  if (editingWaypointId) {
    const idx = waypointData.findIndex((w) => w.id === editingWaypointId);
    if (idx !== -1) {
      waypointData[idx].name = name;
      waypointData[idx].type = type;
      waypointData[idx].lat = latVal;
      waypointData[idx].lon = lonVal;
      waypointData[idx].notes = notes;
      waypointData[idx].bestWind = bestWind;
      waypointData[idx].terrainTag = terrainTag;
      removeWaypointMarker(editingWaypointId);
      addWaypointMarker(waypointData[idx]);
    }
  } else {
    const wp = createWaypoint({
      name,
      type,
      lat: latVal,
      lon: lonVal,
      notes,
      bestWind,
      terrainTag
    });
    waypointData.push(wp);
    addWaypointMarker(wp);
  }

  saveWaypointsToStorage();
  renderWaypointTable();
  resetWaypointForm();
}

function resetWaypointForm() {
  $("wp-name").value = "";
  $("wp-type").value = "Stand";
  $("wp-best-wind").value = "";
  $("wp-terrain").value = "";
  $("wp-lat").value = "";
  $("wp-lon").value = "";
  $("wp-notes").value = "";
  editingWaypointId = null;
  $("wp-submit").textContent = "💾 Save waypoint";
}

function attachWaypointTableHandlers() {
  const tbody = $("waypoint-list");
  if (!tbody) return;
  tbody.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    const action = btn.dataset.action;
    const tr = btn.closest("tr");
    if (!tr) return;
    const id = tr.dataset.id;
    const wp = waypointData.find((w) => w.id === id);
    if (!wp) return;

    if (action === "zoom") {
      map.setView([wp.lat, wp.lon], Math.max(map.getZoom(), 17));
    } else if (action === "edit") {
      $("wp-name").value = wp.name || "";
      $("wp-type").value = wp.type || "Stand";
      $("wp-best-wind").value = wp.bestWind || "";
      $("wp-terrain").value = wp.terrainTag || "";
      $("wp-lat").value = wp.lat;
      $("wp-lon").value = wp.lon;
      $("wp-notes").value = wp.notes || "";
      editingWaypointId = id;
      $("wp-submit").textContent = "✅ Update waypoint";
      window.location.hash = "#map-waypoints";
    } else if (action === "delete") {
      if (confirm("Delete this waypoint?")) {
        waypointData = waypointData.filter((w) => w.id !== id);
        removeWaypointMarker(id);
        saveWaypointsToStorage();
        renderWaypointTable();
      }
    }
  });
}

// --- Planner & stand recommendations ---

function plannerWeatherDesc(hiF, loF, windMph, precip) {
  const pieces = [];
  pieces.push(`${Math.round(loF)}–${Math.round(hiF)}°F`);
  if (precip >= 0.1) pieces.push("wet / showers");
  else pieces.push("mostly dry");
  if (windMph <= 6) pieces.push("light wind");
  else if (windMph <= 12) pieces.push("huntable wind");
  else pieces.push("windy");
  return pieces.join(", ");
}

function plannerFocusSuggestion(hiF, loF, windMph, precip) {
  const avg = (hiF + loF) / 2;
  if (precip >= 0.1) {
    return "Edges / movement right before or after rain.";
  }
  if (avg <= 40) {
    return "Colder day – late morning & evenings near food.";
  }
  if (avg >= 65) {
    return "Warm – shade, water, and last light.";
  }
  if (windMph >= 15) {
    return "Windy – leeward cover and protected routes.";
  }
  return "Balanced – classic morning/evening travel routes.";
}

async function runPlanner() {
  const startStr = $("plan-start").value;
  if (!startStr) return;

  const terrain = $("plan-terrain").value || "mixed";
  const pressureLevel = $("plan-pressure").value || "medium";
  const { lat, lon } = getCoordsFromInputs("plan-lat", "plan-lon");

  const btn = $("btn-plan-run");
  btn.disabled = true;
  btn.textContent = "Loading…";

  try {
    const startDate = new Date(startStr + "T12:00:00");
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);

    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      daily:
        "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,sunrise,sunset",
      timezone: "auto",
      start_date: startStr,
      end_date: endDate.toISOString().slice(0, 10)
    });

    const res = await fetch(OPEN_METEO_URL + "?" + params.toString());
    if (!res.ok) throw new Error("Planner weather request failed");
    const data = await res.json();

    let moonMap = null;
    try {
      const times = data.daily?.time || [];
      moonMap = await fetchMoonPhaseForPlanner(startDate, times.length || 7);
    } catch (moonErr) {
      console.warn("Planner moon phase fetch failed:", moonErr);
    }

    renderPlannerRows(data, terrain, pressureLevel, moonMap);
  } catch (err) {
    console.error(err);
    currentPlannerWindDeg = null;
    currentPlannerDateText = "";
    const tbody = $("planner-rows");
    tbody.innerHTML = "";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.textContent = "Could not load planner weather.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    updateStandRecommendations();
  } finally {
    btn.disabled = false;
    btn.textContent = "📆 Generate 7-day plan";
  }
}

function renderPlannerRows(data, terrain, pressureLevel, moonMap) {
  const tbody = $("planner-rows");
  tbody.innerHTML = "";

  const times = data.daily.time || [];
  const sunriseArr = data.daily.sunrise || [];
  const sunsetArr = data.daily.sunset || [];
  const windDirArr = data.daily.wind_direction_10m_dominant || [];

  currentPlannerWindDeg = null;
  currentPlannerDateText = "";

  for (let i = 0; i < times.length; i++) {
    const date = new Date(times[i]);
    const dateKey = formatDateISO(date);
    const hiF = toF(data.daily.temperature_2m_max[i]);
    const loF = toF(data.daily.temperature_2m_min[i]);
    const windMph = data.daily.wind_speed_10m_max[i] * 2.23694;
    const precip = data.daily.precipitation_sum[i];

    const sunrise = sunriseArr[i] ? new Date(sunriseArr[i]) : null;
    const sunset = sunsetArr[i] ? new Date(sunsetArr[i]) : null;
    const windDirDeg = windDirArr[i];
    const windDirCard = degreeToCompass(windDirDeg);

    const { phase, factor: rutF } = rutPhaseForDate(date);
    const tempFScore = tempFactorF((hiF + loF) / 2);
    const windF = windFactor(windMph);
    const precipF = precipFactor(precip);
    const pressF = 1.0; // no daily pressure here
    const timeF = 0.95; // assume prime morning/evening focus
    const terrainF =
      terrain === "pines" ? 1.0 : terrain === "mixed" ? 0.95 : 0.9;
    const pressurePenalty =
      pressureLevel === "high" ? 0.9 : pressureLevel === "low" ? 1.05 : 1.0;

    let score =
      (rutF * 0.35 +
        timeF * 0.2 +
        tempFScore * 0.18 +
        windF * 0.14 +
        precipF * 0.08 +
        pressF * 0.05 -
        (1 - terrainF) * 0.05) *
      100 *
      pressurePenalty;

    score = clamp(Math.round(score), 0, 100);

    // capture wind for stand matching on first row
    if (i === 0) {
      currentPlannerWindDeg = windDirDeg;
      currentPlannerDateText = date.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric"
      });
    }

    // Moon data for this date (if available)
    let moonItem = null;
    if (moonMap && moonMap[dateKey]) {
      moonItem = moonMap[dateKey];
    }

    const tr = document.createElement("tr");

    const dateTd = document.createElement("td");
    dateTd.textContent = date.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric"
    });

    const rutTd = document.createElement("td");
    rutTd.textContent = phase;

    const tempTd = document.createElement("td");
    tempTd.textContent = `${Math.round(hiF)} / ${Math.round(loF)}°`;

    const windTd = document.createElement("td");
    let windText = `${Math.round(windMph)} mph`;
    if (windDirCard) {
      windText += ` (${windDirCard})`;
    }
    windTd.textContent = windText;

    const weatherTd = document.createElement("td");
    let weatherText = plannerWeatherDesc(hiF, loF, windMph, precip);
    if (sunrise && sunset) {
      weatherText += ` • SR ${shortClock(sunrise)} / SS ${shortClock(sunset)}`;
    }
    if (moonItem && moonItem.phase) {
      const illumRaw = moonItem.illumination;
      let illumNum = null;
      if (typeof illumRaw === "number") {
        illumNum = illumRaw * (illumRaw <= 1 ? 100 : 1);
      } else if (typeof illumRaw === "string") {
        illumNum = parseFloat(illumRaw);
      }
      const illumLabel =
        illumNum != null && !isNaN(illumNum)
          ? `${illumNum.toFixed(1)}%`
          : moonItem.illumination || "";
      weatherText += ` • Moon: ${moonItem.phase} (${illumLabel})`;
    }
    weatherTd.textContent = weatherText;

    const focusTd = document.createElement("td");
    focusTd.textContent = plannerFocusSuggestion(hiF, loF, windMph, precip);

    const scoreTd = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "pill " + classifyScore(score);
    pill.textContent = score + " / 100";
    scoreTd.appendChild(pill);

    tr.appendChild(dateTd);
    tr.appendChild(rutTd);
    tr.appendChild(tempTd);
    tr.appendChild(windTd);
    tr.appendChild(weatherTd);
    tr.appendChild(focusTd);
    tr.appendChild(scoreTd);

    tbody.appendChild(tr);
  }

  renderWaypointTable();
  updateStandRecommendations();
}

function updateStandRecommendations() {
  const container = $("stand-recos");
  if (!container) return;
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "stand-recos-header";

  if (!waypointData.length) {
    header.textContent =
      "Add stands, blinds, feeders, and trail cams with best wind tags to see recommendations here.";
    container.appendChild(header);
    return;
  }

  if (currentPlannerWindDeg == null || isNaN(currentPlannerWindDeg)) {
    header.textContent =
      "Run the 7-day planner to see which stands line up best with the dominant wind.";
    container.appendChild(header);
    return;
  }

  header.textContent = `Stand recommendations for ${currentPlannerDateText} (dominant wind ${degreeToCompass(
    currentPlannerWindDeg
  )}).`;
  container.appendChild(header);

  const recs = [];

  waypointData.forEach((wp) => {
    if (!wp.bestWind || !windStringToDeg(wp.bestWind)) return;
    const match = computeStandMatch(wp.bestWind, currentPlannerWindDeg);
    if (!match) return;
    recs.push({ wp, match });
  });

  if (!recs.length) {
    const p = document.createElement("div");
    p.className = "stand-recos-header";
    p.textContent =
      "Set a best wind for each stand to get personalized recommendations.";
    container.appendChild(p);
    return;
  }

  recs.sort((a, b) => b.match.score - a.match.score || a.match.diff - b.match.diff);
  const top = recs.slice(0, 3);

  const grid = document.createElement("div");
  grid.className = "stand-recos-grid";

  top.forEach(({ wp, match }) => {
    const card = document.createElement("div");
    card.className = "stand-card";

    const headerRow = document.createElement("div");
    headerRow.className = "stand-card-header";

    const title = document.createElement("div");
    title.className = "stand-card-title";
    title.textContent = wp.name || "(unnamed)";

    const right = document.createElement("div");
    const typeSpan = document.createElement("div");
    typeSpan.className = "stand-card-type";
    typeSpan.textContent = wp.type;
    const pill = document.createElement("span");
    pill.className = "pill " + match.cls;
    pill.textContent = `${match.label} wind`;
    right.appendChild(typeSpan);
    right.appendChild(pill);

    headerRow.appendChild(title);
    headerRow.appendChild(right);

    const body = document.createElement("div");
    body.className = "stand-card-body";
    const coordsText = `${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}`;
    const terrainLabel = wp.terrainTag ? prettyTerrain(wp.terrainTag) : "no terrain tag";
    body.textContent =
      `${coordsText} • ${terrainLabel} • best wind ${wp.bestWind || "any"}. ` +
      match.text;

    card.appendChild(headerRow);
    card.appendChild(body);
    grid.appendChild(card);
  });

  container.appendChild(grid);
}

// --- Today at a Glance ---

async function updateTodaySummary() {
  const rutMain = $("today-rut-main");
  const rutSub = $("today-rut-sub");
  const weatherMain = $("today-weather-main");
  const weatherSub = $("today-weather-sub");
  const windMain = $("today-wind-main");
  const windSub = $("today-wind-sub");
  const moonMain = $("today-moon-main");
  const moonSub = $("today-moon-sub");
  const scorePill = $("today-score-pill");
  const todayComment = $("today-comment");

  const { lat, lon } = getCoordsFromInputs("live-lat", "live-lon");
  const today = new Date();

  try {
    const data = await fetchWeather(lat, lon, today);
    const hiC = data.daily.temperature_2m_max[0];
    const loC = data.daily.temperature_2m_min[0];
    const hiF = toF(hiC);
    const loF = toF(loC);
    const windMph = data.daily.wind_speed_10m_max[0] * 2.23694;
    const windDirDeg = data.daily.wind_direction_10m_dominant[0];
    const windDirCard = degreeToCompass(windDirDeg);
    const precip = data.daily.precipitation_sum[0];

    const sunrise = data.daily.sunrise?.[0]
      ? new Date(data.daily.sunrise[0])
      : null;
    const sunset = data.daily.sunset?.[0]
      ? new Date(data.daily.sunset[0])
      : null;

    const { phase } = rutPhaseForDate(today);

    // approximate score using daily averages
    const avgTempF = (hiF + loF) / 2;
    const pieces = buildLiveScorePieces({
      date: today,
      timeKey: "evening",
      tempF: avgTempF,
      windMph,
      precipMm: precip,
      pressureHpa: null,
      terrain: "mixed",
      pressureLevel: "medium"
    });

    let moonInfo = null;
    try {
      moonInfo = await fetchMoonPhaseForDate(today);
    } catch (moonErr) {
      console.warn("Today moon fetch failed:", moonErr);
    }

    rutMain.textContent = phase;
    rutSub.textContent = "GA coastal plain rut model";

    weatherMain.textContent = `${Math.round(hiF)}° / ${Math.round(loF)}°F`;
    let weatherExtra = `Rain ${precip.toFixed(1)} mm`;
    if (sunrise && sunset) {
      weatherExtra += ` • SR ${shortClock(sunrise)} / SS ${shortClock(sunset)}`;
    }
    weatherSub.textContent = weatherExtra;

    windMain.textContent = `${Math.round(windMph)} mph${
      windDirCard ? " " + windDirCard : ""
    }`;
    windSub.textContent = "Dominant daily wind";

    if (moonInfo && moonInfo.phase) {
      const illumRaw = moonInfo.illumination;
      let illumNum = null;
      if (typeof illumRaw === "number") {
        illumNum = illumRaw * (illumRaw <= 1 ? 100 : 1);
      } else if (typeof illumRaw === "string") {
        illumNum = parseFloat(illumRaw);
      }
      const illumLabel =
        illumNum != null && !isNaN(illumNum)
          ? `${illumNum.toFixed(1)}% lit`
          : moonInfo.illumination || "";
      moonMain.textContent = moonInfo.phase;
      moonSub.textContent = illumLabel;
    } else {
      moonMain.textContent = "Unknown";
      moonSub.textContent = "Moon API error";
    }

    const cls = classifyScore(pieces.score);
    scorePill.className = "pill " + (cls === "great" ? "good" : cls); // pill colors
    scorePill.textContent = `${pieces.score} / 100 • ${scoreHeadline(
      pieces.score
    )}`;

    todayComment.textContent =
      "Score combines rut phase, temp, wind, rain and moon for today at your hunt center.";
  } catch (err) {
    console.error(err);
    scorePill.className = "pill bad";
    scorePill.textContent = "Error";
    todayComment.textContent =
      "Could not load today’s weather – check connection or coordinates.";
  }
}

// --- Geolocation ---

function useMyLocation() {
  if (!navigator.geolocation) {
    alert("Geolocation not supported in this browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      syncCoordInputs(lat, lon, true);
      if (centerMarker && map) {
        centerMarker.setLatLng([lat, lon]);
        map.setView([lat, lon], 15);
      }
      // Refresh today summary with new coords
      updateTodaySummary();
    },
    (err) => {
      console.warn(err);
      alert("Could not get your location (permissions / signal).");
    }
  );
}

// --- Init ---

document.addEventListener("DOMContentLoaded", () => {
  // default dates
  const today = new Date();
  const iso = formatDateISO(today);
  const liveDate = $("live-date");
  const planStart = $("plan-start");
  if (liveDate) liveDate.value = iso;
  if (planStart) planStart.value = iso;

  // default coords
  syncCoordInputs(defaultLat, defaultLon, true);

  // map + waypoints
  initMap();
  attachWaypointTableHandlers();

  // listeners
  const liveForm = $("live-form");
  if (liveForm) {
    liveForm.addEventListener("submit", (e) => {
      e.preventDefault();
      runLiveOdds();
    });
  }

  const btnLoc = $("btn-my-location");
  if (btnLoc) btnLoc.addEventListener("click", useMyLocation);

  const btnAddWp = $("btn-add-waypoint");
  if (btnAddWp) {
    btnAddWp.addEventListener("click", () => {
      addingWaypoint = !addingWaypoint;
      btnAddWp.classList.toggle("map-mode-active", addingWaypoint);
    });
  }

  const wpForm = $("waypoint-form");
  if (wpForm) wpForm.addEventListener("submit", onWaypointFormSubmit);

  const btnWpUseCenter = $("wp-use-center");
  if (btnWpUseCenter) {
    btnWpUseCenter.addEventListener("click", () => {
      const { lat, lon } = getCoordsFromInputs("live-lat", "live-lon");
      syncWaypointCoordInputs(lat, lon);
    });
  }

  const btnWpClear = $("wp-clear-all");
  if (btnWpClear) {
    btnWpClear.addEventListener("click", () => {
      if (confirm("Clear ALL waypoints saved on this device?")) {
        waypointData = [];
        saveWaypointsToStorage();
        waypointMarkers.forEach((m) => map.removeLayer(m));
        waypointMarkers.clear();
        renderWaypointTable();
        updateStandRecommendations();
      }
    });
  }

  const planForm = $("planner-form");
  if (planForm) {
    planForm.addEventListener("submit", (e) => {
      e.preventDefault();
      runPlanner();
    });
  }

  // initial data
  loadWaypointsFromStorage();
  runLiveOdds();
  runPlanner();
  updateTodaySummary();
});
