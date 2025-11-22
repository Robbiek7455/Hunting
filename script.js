// Davisboro Hunt App
// Map + waypoints + deer odds + 7-day planner

const defaultLat = 32.97904;
const defaultLon = -82.60791;
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

// ✅ Your MapTiler key (satellite layer)
const MAPTILER_KEY = "dKj67SEDLftsSLKxGfjB";

function $(id) {
  return document.getElementById(id);
}

function clamp(x, a, b) {
  return Math.min(b, Math.max(a, x));
}

function toF(c) {
  return (c * 9) / 5 + 32;
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

// --- Weather helpers ---

async function fetchWeather(lat, lon, date) {
  const dateStr = date.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "temperature_2m,wind_speed_10m,precipitation,pressure_msl",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
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
  "Trail Cam": { color: "#a855f7" },
  Other: { color: "#38bdf8" }
};

let map;
let centerMarker;
let addingWaypoint = false;
const waypointMarkers = new Map();
let waypointData = [];
let editingWaypointId = null;

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
  Object.keys(waypointTypeStyles).forEach((type) => {
    const style = waypointTypeStyles[type];
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
  });
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

    renderLiveResults(pieces, vals, h);
  } catch (err) {
    console.error(err);
    renderLiveError(err);
  } finally {
    setLiveLoading(false);
  }
}

function renderLiveResults(pieces, vals, hourly) {
  const badge = $("score-badge");
  const bar = $("score-bar");
  const label = $("score-label");
  const factorGrid = $("factor-grid");
  const analysisNote = $("analysis-note");

  const { score, phase, rutF, timeF, tempFScore, windF, precipF, pressF, pressureHpa } =
    pieces;

  const cls = classifyScore(score);
  badge.className = "score-badge " + cls;
  badge.textContent = "Score " + score;

  bar.style.width = score + "%";
  label.textContent = scoreLabel(score);

  factorGrid.innerHTML = "";

  const tempF = toF(hourly.tempC);
  const windMph = hourly.windMs * 2.23694;
  const precipMm = hourly.precipMm ?? 0;

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
  } catch {}
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
    notes: fields.notes || ""
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

function renderWaypointTable() {
  const tbody = $("waypoint-list");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!waypointData.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.textContent =
      "No waypoints yet. Turn on “Add waypoint” and tap the map, then save here.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  waypointData.forEach((wp) => {
    const tr = document.createElement("tr");
    tr.dataset.id = wp.id;

    const tdName = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = wp.type;
    tdName.appendChild(document.createTextNode((wp.name || "(unnamed)") + " "));
    tdName.appendChild(pill);

    const tdCoords = document.createElement("td");
    tdCoords.textContent =
      wp.lat.toFixed(5) + ", " + wp.lon.toFixed(5);

    const tdNotes = document.createElement("td");
    tdNotes.textContent = wp.notes || "";

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
    tr.appendChild(tdNotes);
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
      removeWaypointMarker(editingWaypointId);
      addWaypointMarker(waypointData[idx]);
    }
  } else {
    const wp = createWaypoint({ name, type, lat: latVal, lon: lonVal, notes });
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

// --- Planner ---

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
        "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
      timezone: "auto",
      start_date: startStr,
      end_date: endDate.toISOString().slice(0, 10)
    });

    const res = await fetch(OPEN_METEO_URL + "?" + params.toString());
    if (!res.ok) throw new Error("Planner weather request failed");
    const data = await res.json();

    renderPlannerRows(data, terrain, pressureLevel);
  } catch (err) {
    console.error(err);
    const tbody = $("planner-rows");
    tbody.innerHTML = "";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.textContent = "Could not load planner weather.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } finally {
    btn.disabled = false;
    btn.textContent = "📆 Generate 7-day plan";
  }
}

function renderPlannerRows(data, terrain, pressureLevel) {
  const tbody = $("planner-rows");
  tbody.innerHTML = "";

  const times = data.daily.time || [];
  for (let i = 0; i < times.length; i++) {
    const date = new Date(times[i]);
    const hiF = toF(data.daily.temperature_2m_max[i]);
    const loF = toF(data.daily.temperature_2m_min[i]);
    const windMph = data.daily.wind_speed_10m_max[i] * 2.23694;
    const precip = data.daily.precipitation_sum[i];

    const { phase, factor: rutF } = rutPhaseForDate(date);
    const tempFScore = tempFactorF((hiF + loF) / 2);
    const windF = windFactor(windMph);
    const precipF = precipFactor(precip);
    const pressF = 1.0; // we don't have daily pressure here
    const timeF = 0.95; // assume focusing on morning/evening
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
    windTd.textContent = `${Math.round(windMph)} mph`;

    const weatherTd = document.createElement("td");
    weatherTd.textContent = plannerWeatherDesc(hiF, loF, windMph, precip);

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
  const iso = today.toISOString().slice(0, 10);
  const liveDate = $("live-date");
  const planStart = $("plan-start");
  if (liveDate) liveDate.value = iso;
  if (planStart) planStart.value = iso;

  // default coords
  syncCoordInputs(defaultLat, defaultLon, true);

  // map + way
