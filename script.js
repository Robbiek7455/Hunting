// ---------- helpers ----------

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}

function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTimeShort(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  const hrs = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, "0");
  const ampm = hrs >= 12 ? "PM" : "AM";
  const h12 = hrs % 12 || 12;
  return `${h12}:${mins} ${ampm}`;
}

// Rut model for Washington County, GA.
// Peak: Oct 27 – Nov 2. Second rut ≈ Nov 24 – Nov 30.
function getRutPhaseForWashingtonGA(date) {
  const year = date.getFullYear();
  const peakStart = new Date(year, 9, 27); // Oct index 9
  const peakEnd = new Date(year, 10, 2); // Nov 2
  const secondStart = new Date(year, 10, 24);
  const secondEnd = new Date(year, 10, 30);

  if (date >= peakStart && date <= peakEnd) {
    return { id: "rut", label: "Peak rut (Washington County, GA)" };
  }
  if (date >= secondStart && date <= secondEnd) {
    return { id: "secondRut", label: "Second rut (late November, Washington County, GA)" };
  }
  if (date < peakStart) {
    const diffDays = Math.round((peakStart - date) / DAY_MS);
    if (diffDays <= 14) {
      return { id: "pre", label: "Pre-rut (within ~2 weeks of peak)" };
    }
    return { id: "early", label: "Early season relative to peak rut" };
  }
  if (date > peakEnd && date < secondStart) {
    return { id: "post", label: "Post-peak rut trending toward second rut" };
  }
  if (date > secondEnd) {
    return { id: "late", label: "Late season after second rut" };
  }
  return { id: "early", label: "General season" };
}

// ---------- scoring model ----------

function getBaseFromRut(rutPhase) {
  switch (rutPhase) {
    case "early": return 45;
    case "pre": return 55;
    case "rut": return 65;
    case "secondRut": return 68;
    case "post": return 50;
    case "late": return 45;
    default: return 50;
  }
}

function getTimeOfDayModifier(timeOfDay, rutPhase) {
  if (timeOfDay === "morning") return 8;
  if (timeOfDay === "evening") return 6;
  if (timeOfDay === "allDay") return 10;
  // midday
  if (rutPhase === "rut" || rutPhase === "secondRut") return 5;
  return 0;
}

function getWeatherModifier(flags) {
  let mod = 0;
  if (flags.coldFront) mod += 8;
  if (flags.recentRain) mod += 4;
  if (flags.highWind) mod -= 6;
  if (flags.veryWarm) mod -= 5;
  return mod;
}

function getPressureModifier(pressure) {
  switch (pressure) {
    case "low": return 5;
    case "medium": return 0;
    case "high": return -8;
    default: return 0;
  }
}

function getTerrainTips(terrain) {
  switch (terrain) {
    case "pinesClearcuts":
      return "Focus on edges where thick pines meet clearcuts. Hunt downwind of bedding, especially in corners and funnels, and sneak in through cover.";
    case "hardwoods":
      return "Key in on ridges, saddles, and downwind sides of oak flats. Set up along travel routes from bedding to feed in the morning.";
    case "agEdges":
      return "Evenings on the downwind edge of fields are prime. Look for cover fingers, ditches, or fence gaps that channel deer into the open.";
    case "mixed":
    default:
      return "Hunt hard transitions between cover types and places where several trails converge while still keeping the wind safe.";
  }
}

function getRatingText(score) {
  if (score >= 75) return "🔥 High odds – this is a sit you don’t want to miss. Stay as long as you can.";
  if (score >= 60) return "👍 Solid odds – definitely worth hunting hard in your best spot.";
  if (score >= 50) return "⚖️ Fair odds – a good deer could still show with the right wind and stealth.";
  return "😬 Low odds – maybe treat this as an observation sit or scouting mission.";
}

function getBadge(score) {
  if (score >= 75) return { text: "Excellent", className: "great" };
  if (score >= 60) return { text: "Good", className: "good" };
  if (score >= 50) return { text: "Fair", className: "ok" };
  return { text: "Tough", className: "poor" };
}

function buildExtraTips(timeOfDay, rutPhase, flags, allDay) {
  const tips = [];

  if ((rutPhase === "rut" || rutPhase === "secondRut") &&
      (timeOfDay === "midday" || allDay)) {
    tips.push("During the rut or second rut, don’t sleep on 10 AM – 2 PM. Cruising bucks can appear out of nowhere.");
  }

  if (flags.coldFront) {
    tips.push("You’re hunting behind a front – be set up early, as deer may move earlier in the evening and later into the morning.");
  }

  if (flags.highWind) {
    tips.push("With higher winds, cheat down into leeward sides of hills or thicker cover where deer feel more comfortable.");
  }

  if (!tips.length) {
    tips.push("Play the wind perfectly, keep your entry quiet, and let your best spots rest when the wind is wrong.");
  }

  return tips.join(" ");
}

// ---------- weather (Open-Meteo) ----------

async function fetchWeather(lat, lon, dateStr) {
  const targetDate = new Date(dateStr);
  const prevDate = new Date(targetDate.getTime() - DAY_MS);
  const startStr = formatDate(prevDate);
  const endStr = formatDate(targetDate);

  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,sunrise,sunset" +
    "&timezone=auto&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch" +
    `&start_date=${startStr}&end_date=${endStr}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("Weather request failed");
  const data = await res.json();

  const daily = data.daily;
  if (!daily || !daily.time || !daily.time.length) {
    throw new Error("No daily weather data");
  }

  const times = daily.time;
  const idxToday = times.indexOf(endStr);
  const idxPrev = times.indexOf(startStr);

  if (idxToday === -1) throw new Error("Selected date not in weather range");

  const today = {
    date: endStr,
    tMax: daily.temperature_2m_max[idxToday],
    tMin: daily.temperature_2m_min[idxToday],
    precip: daily.precipitation_sum[idxToday],
    windMax: daily.windspeed_10m_max[idxToday],
    sunrise: daily.sunrise[idxToday],
    sunset: daily.sunset[idxToday]
  };

  let prev = null;
  if (idxPrev !== -1) {
    prev = {
      date: startStr,
      tMax: daily.temperature_2m_max[idxPrev],
      tMin: daily.temperature_2m_min[idxPrev],
      precip: daily.precipitation_sum[idxPrev],
      windMax: daily.windspeed_10m_max[idxPrev],
      sunrise: daily.sunrise[idxPrev],
      sunset: daily.sunset[idxPrev]
    };
  }

  return { today, prev };
}

// For planner: fetch continuous range
async function fetchWeatherRange(lat, lon, startDateStr, days) {
  const startDate = new Date(startDateStr);
  const prevDate = new Date(startDate.getTime() - DAY_MS);
  const endDate = new Date(startDate.getTime() + (days - 1) * DAY_MS);

  const startStr = formatDate(prevDate);
  const endStr = formatDate(endDate);

  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,sunrise,sunset" +
    "&timezone=auto&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch" +
    `&start_date=${startStr}&end_date=${endStr}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("Weather range request failed");
  const data = await res.json();
  return data.daily;
}

function deriveWeatherFlags(today, prev, targetDate) {
  const month = new Date(targetDate).getMonth() + 1;

  const recentRain =
    (prev && prev.precip > 0.05) || (today && today.precip > 0.05);

  let coldFront = false;
  if (prev) {
    const drop = prev.tMax - today.tMax;
    if (drop >= 10 && prev.precip > 0.05) coldFront = true;
  }

  const highWind = today.windMax >= 15;
  const veryWarm = month >= 9 && month <= 12 && today.tMax >= 75;

  return { recentRain, coldFront, highWind, veryWarm };
}

// ---------- hunt log (localStorage) ----------

const LOG_STORAGE_KEY = "deerHuntLog";
const CHECKLIST_STORAGE_KEY = "deerChecklist";

function loadLog() {
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function saveLog(entries) {
  localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(entries));
}

function renderLog(entries) {
  const logListCard = document.getElementById("logListCard");
  const logList = document.getElementById("logList");
  const logStatsCard = document.getElementById("logStatsCard");
  const logStats = document.getElementById("logStats");

  if (!entries.length) {
    logListCard.style.display = "none";
    logStatsCard.style.display = "none";
    return;
  }

  // Stats
  const total = entries.length;
  const successCount = entries.filter(e => e.success === "yes").length;
  const totalDeer = entries.reduce((sum, e) => sum + (e.deerSeen || 0), 0);

  const timeCounts = entries.reduce((acc, e) => {
    acc[e.timeOfDay] = (acc[e.timeOfDay] || 0) + 1;
    return acc;
  }, {});
  let bestTime = null;
  let bestTimeCount = 0;
  Object.entries(timeCounts).forEach(([t, c]) => {
    if (c > bestTimeCount) {
      bestTime = t;
      bestTimeCount = c;
    }
  });

  const successRate = total ? Math.round((successCount / total) * 100) : 0;
  const avgDeer = total ? (totalDeer / total).toFixed(1) : "0.0";

  const timeLabels = {
    morning: "Morning",
    midday: "Midday",
    evening: "Evening",
    allDay: "All-day"
  };

  logStats.innerHTML =
    `Total hunts: <strong>${total}</strong><br>` +
    `Tags filled: <strong>${successCount}</strong> (${successRate}% success rate)<br>` +
    `Average deer seen per hunt: <strong>${avgDeer}</strong><br>` +
    (bestTime
      ? `Most frequently hunted time: <strong>${timeLabels[bestTime]}</strong>`
      : "");

  logStatsCard.style.display = "block";

  // List
  logList.innerHTML = "";
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1));

  sorted.forEach(entry => {
    const div = document.createElement("div");
    div.className = "log-entry";

    const header = document.createElement("div");
    header.className = "log-entry-header";
    header.innerHTML =
      `<span>${entry.date} – ${timeLabels[entry.timeOfDay] || entry.timeOfDay}</span>` +
      `<span>${entry.deerSeen} deer • ${
        entry.success === "yes" ? "✅ Tag filled" : "No tag"
      }</span>`;

    const notes = document.createElement("div");
    notes.style.fontSize = "0.8rem";
    notes.style.opacity = "0.9";
    notes.textContent = entry.notes || "No notes";

    div.appendChild(header);
    div.appendChild(notes);
    logList.appendChild(div);
  });

  logListCard.style.display = "block";
}

// ---------- checklist ----------

function loadChecklist() {
  try {
    const raw = localStorage.getItem(CHECKLIST_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function saveChecklist(state) {
  localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(state));
}

function initChecklist() {
  const container = document.getElementById("checklist");
  const clearBtn = document.getElementById("checklistClearBtn");
  const saved = loadChecklist();

  if (container) {
    const inputs = container.querySelectorAll('input[type="checkbox"]');
    inputs.forEach(input => {
      if (saved[input.id]) {
        input.checked = true;
      }
      input.addEventListener("change", () => {
        const current = loadChecklist();
        current[input.id] = input.checked;
        saveChecklist(current);
      });
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      localStorage.removeItem(CHECKLIST_STORAGE_KEY);
      const inputs = container.querySelectorAll('input[type="checkbox"]');
      inputs.forEach(i => (i.checked = false));
    });
  }
}

// ---------- tabs ----------

function initTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");

  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      buttons.forEach(b => b.classList.toggle("active", b === btn));
      panels.forEach(panel => {
        panel.classList.toggle(
          "hidden",
          panel.getAttribute("data-tab-panel") !== tab
        );
      });
    });
  });
}

// ---------- map (Leaflet) ----------

let mapInstance = null;
let mapMarker = null;

function initMap(latInput, lonInput) {
  const mapEl = document.getElementById("map");
  if (!mapEl || !window.L) return;

  const lat = parseFloat(latInput.value) || 32.9533;
  const lon = parseFloat(lonInput.value) || -82.6182;

  mapInstance = L.map(mapEl).setView([lat, lon], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19
  }).addTo(mapInstance);

  mapMarker = L.marker([lat, lon], { draggable: true }).addTo(mapInstance);

  function updateInputsFromMarker(e) {
    const { lat, lng } = e.target.getLatLng();
    latInput.value = lat.toFixed(4);
    lonInput.value = lng.toFixed(4);
  }

  mapMarker.on("moveend", updateInputsFromMarker);

  mapInstance.on("click", e => {
    const { lat, lng } = e.latlng;
    mapMarker.setLatLng(e.latlng);
    latInput.value = lat.toFixed(4);
    lonInput.value = lng.toFixed(4);
  });
}

function centerMapOnInputs(latInput, lonInput) {
  if (!mapInstance || !mapMarker) return;
  const lat = parseFloat(latInput.value) || 32.9533;
  const lon = parseFloat(lonInput.value) || -82.6182;
  mapInstance.setView([lat, lon], 13);
  mapMarker.setLatLng([lat, lon]);
}

// ---------- main DOM wiring ----------

document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initChecklist();

  // Pre-fill today's date for convenience
  const todayInput = document.getElementById("date");
  const plannerStartInput = document.getElementById("plannerStartDate");
  const logDateInput = document.getElementById("logDate");
  const todayStr = formatDate(new Date());
  if (todayInput) todayInput.value = todayStr;
  if (plannerStartInput) plannerStartInput.value = todayStr;
  if (logDateInput) logDateInput.value = todayStr;

  // Init map
  const latInput = document.getElementById("lat");
  const lonInput = document.getElementById("lon");
  if (latInput && lonInput && window.L) {
    initMap(latInput, lonInput);
  }

  // Map helper buttons
  const centerBtn = document.getElementById("centerOnInputsBtn");
  if (centerBtn && latInput && lonInput) {
    centerBtn.addEventListener("click", () => {
      centerMapOnInputs(latInput, lonInput);
    });
  }

  const copyToPlannerBtn = document.getElementById("copyToPlannerBtn");
  const plannerLatInput = document.getElementById("plannerLat");
  const plannerLonInput = document.getElementById("plannerLon");
  if (copyToPlannerBtn && plannerLatInput && plannerLonInput) {
    copyToPlannerBtn.addEventListener("click", () => {
      plannerLatInput.value = latInput.value;
      plannerLonInput.value = lonInput.value;
    });
  }

  // Keep planner coords roughly in sync when main coords change
  ["change", "blur"].forEach(evtName => {
    latInput?.addEventListener(evtName, () => {
      if (plannerLatInput) plannerLatInput.value = latInput.value;
    });
    lonInput?.addEventListener(evtName, () => {
      if (plannerLonInput) plannerLonInput.value = lonInput.value;
    });
  });

  // ----- Live Odds tab -----
  const calculateBtn = document.getElementById("calculateBtn");
  const errorText = document.getElementById("errorText");
  const weatherCard = document.getElementById("weatherCard");
  const rutPhaseAuto = document.getElementById("rutPhaseAuto");
  const weatherSummary = document.getElementById("weatherSummary");
  const weatherDetails = document.getElementById("weatherDetails");
  const weatherFlagsP = document.getElementById("weatherFlags");
  const weatherSun = document.getElementById("weatherSun");

  const resultsCard = document.getElementById("resultsCard");
  const scoreText = document.getElementById("scoreText");
  const chanceText = document.getElementById("chanceText");
  const badgeText = document.getElementById("badgeText");
  const ratingText = document.getElementById("ratingText");
  const tipsText = document.getElementById("tipsText");
  const gaugeFill = document.getElementById("gaugeFill");

  if (calculateBtn) {
    calculateBtn.addEventListener("click", async () => {
      errorText.style.display = "none";
      resultsCard.style.display = "none";
      weatherCard.style.display = "none";

      const dateStr = document.getElementById("date").value;
      const timeOfDay = document.getElementById("timeOfDay").value;
      const terrain = document.getElementById("terrain").value;
      const huntingPressure = document.getElementById("huntingPressure").value;
      const lat = parseFloat(latInput.value);
      const lon = parseFloat(lonInput.value);

      if (!dateStr) {
        errorText.textContent = "Please pick a hunt date.";
        errorText.style.display = "block";
        return;
      }
      if (Number.isNaN(lat) || Number.isNaN(lon)) {
        errorText.textContent = "Please enter a valid latitude and longitude.";
        errorText.style.display = "block";
        return;
      }

      const targetDate = new Date(dateStr);
      const rutInfo = getRutPhaseForWashingtonGA(targetDate);
      const rutPhase = rutInfo.id;

      try {
        calculateBtn.disabled = true;
        calculateBtn.textContent = "Loading live weather...";

        const { today, prev } = await fetchWeather(lat, lon, dateStr);
        const flags = deriveWeatherFlags(today, prev, targetDate);

        rutPhaseAuto.textContent = `Rut phase (auto): ${rutInfo.label}`;

        const rainTextToday =
          today.precip > 0.05 ? `${today.precip.toFixed(2)}" precip` : "little/no precip";
        const windTextToday = `${today.windMax.toFixed(0)} mph max wind`;

        weatherSummary.textContent =
          `For ${today.date}: High ${today.tMax.toFixed(0)}°F, ` +
          `Low ${today.tMin.toFixed(0)}°F, ${rainTextToday}, ${windTextToday}.`;

        let details = "";
        if (prev) {
          const drop = prev.tMax - today.tMax;
          details += `Prev day high: ${prev.tMax.toFixed(0)}°F `;
          details += `(change of ${drop >= 0 ? "-" : "+"}${Math.abs(drop).toFixed(0)}°F). `;
          if (prev.precip > 0.05) {
            details += `Prev day precip: ${prev.precip.toFixed(2)}". `;
          }
        } else {
          details += "No prior-day weather available. ";
        }
        weatherDetails.textContent = details;

        if (today.sunrise && today.sunset) {
          weatherSun.textContent =
            `Sunrise: ${formatTimeShort(today.sunrise)} • Sunset: ${formatTimeShort(today.sunset)}`;
        } else {
          weatherSun.textContent = "";
        }

        const flagDescriptions = [];
        if (flags.coldFront) flagDescriptions.push("Cold front detected");
        if (flags.recentRain) flagDescriptions.push("Recent rain");
        if (flags.highWind) flagDescriptions.push("High wind at some point");
        if (flags.veryWarm) flagDescriptions.push("Very warm for this time of year");

        weatherFlagsP.textContent = flagDescriptions.length
          ? `Signals: ${flagDescriptions.join(", ")}.`
          : "Weather signals are fairly neutral.";

        weatherCard.style.display = "block";

        // scoring
        let score = getBaseFromRut(rutPhase);
        score += getTimeOfDayModifier(timeOfDay, rutPhase);
        score += getWeatherModifier(flags);
        score += getPressureModifier(huntingPressure);

        if ((rutPhase === "rut" || rutPhase === "secondRut") &&
            terrain === "pinesClearcuts") {
          score += 3;
        }

        score = clamp(score, 20, 90);
        const chancePercent = clamp(Math.round(score), 10, 95);

        scoreText.textContent = `Activity Score: ${score.toFixed(0)} / 100`;
        chanceText.textContent =
          `Estimated chance of seeing deer in daylight: ${chancePercent}%`;

        if (gaugeFill) {
          gaugeFill.style.width = `${chancePercent}%`;
        }

        const badge = getBadge(score);
        badgeText.textContent = badge.text;
        badgeText.className = `badge ${badge.className}`;

        ratingText.textContent = getRatingText(score);

        const terrainTip = getTerrainTips(terrain);
        const extraTips = buildExtraTips(
          timeOfDay,
          rutPhase,
          flags,
          timeOfDay === "allDay"
        );
        tipsText.textContent = `${terrainTip} ${extraTips}`;

        resultsCard.style.display = "block";
        resultsCard.scrollIntoView({ behavior: "smooth" });
      } catch (err) {
        console.error(err);
        errorText.textContent =
          "Could not load weather or calculate odds. Try a date within the next ~16 days and check your connection.";
        errorText.style.display = "block";
      } finally {
        calculateBtn.disabled = false;
        calculateBtn.textContent = "Fetch Live Weather & Calculate Odds";
      }
    });
  }

  // ----- 7-Day Planner tab -----
  const plannerBtn = document.getElementById("plannerBtn");
  const plannerError = document.getElementById("plannerError");
  const plannerResultsCard = document.getElementById("plannerResultsCard");
  const plannerSummary = document.getElementById("plannerSummary");
  const plannerTableBody = document.querySelector("#plannerTable tbody");

  if (plannerBtn) {
    plannerBtn.addEventListener("click", async () => {
      plannerError.style.display = "none";
      plannerResultsCard.style.display = "none";
      plannerTableBody.innerHTML = "";

      const lat = parseFloat(plannerLatInput.value);
      const lon = parseFloat(plannerLonInput.value);
      const startDateStr = document.getElementById("plannerStartDate").value;
      const terrain = document.getElementById("plannerTerrain").value;
      const pressure = document.getElementById("plannerPressure").value;

      if (!startDateStr) {
        plannerError.textContent = "Please choose a start date.";
        plannerError.style.display = "block";
        return;
      }
      if (Number.isNaN(lat) || Number.isNaN(lon)) {
        plannerError.textContent = "Please enter valid coordinates.";
        plannerError.style.display = "block";
        return;
      }

      try {
        plannerBtn.disabled = true;
        plannerBtn.textContent = "Loading 7-day forecast...";

        const days = 7;
        const daily = await fetchWeatherRange(lat, lon, startDateStr, days);
        const times = daily.time;
        const tMax = daily.temperature_2m_max;
        const tMin = daily.temperature_2m_min;
        const precip = daily.precipitation_sum;
        const wind = daily.windspeed_10m_max;

        const startDate = new Date(startDateStr);
        const rows = [];

        for (let i = 0; i < days; i++) {
          const d = new Date(startDate.getTime() + i * DAY_MS);
          const dateStr = formatDate(d);

          const idxToday = times.indexOf(dateStr);
          const idxPrev = times.indexOf(
            formatDate(new Date(d.getTime() - DAY_MS))
          );

          if (idxToday === -1) continue;

          const today = {
            date: dateStr,
            tMax: tMax[idxToday],
            tMin: tMin[idxToday],
            precip: precip[idxToday],
            windMax: wind[idxToday]
          };

          let prev = null;
          if (idxPrev !== -1) {
            prev = {
              date: times[idxPrev],
              tMax: tMax[idxPrev],
              tMin: tMin[idxPrev],
              precip: precip[idxPrev],
              windMax: wind[idxPrev]
            };
          }

          const flags = deriveWeatherFlags(today, prev, d);
          const rutInfo = getRutPhaseForWashingtonGA(d);
          const phases = rutInfo.id;

          function scoreForTime(timeOfDay) {
            let s = getBaseFromRut(phases);
            s += getTimeOfDayModifier(timeOfDay, phases);
            s += getWeatherModifier(flags);
            s += getPressureModifier(pressure);
            if ((phases === "rut" || phases === "secondRut") &&
                terrain === "pinesClearcuts") {
              s += 3;
            }
            return clamp(s, 20, 90);
          }

          const morningScore = scoreForTime("morning");
          const eveningScore = scoreForTime("evening");
          const bestScore =
            morningScore >= eveningScore ? morningScore : eveningScore;
          const bestTime =
            morningScore >= eveningScore ? "Morning" : "Evening";

          rows.push({
            dateStr,
            rutLabel: rutInfo.label,
            tHi: today.tMax.toFixed(0),
            tLo: today.tMin.toFixed(0),
            bestTime,
            score: bestScore
          });
        }

        if (!rows.length) {
          plannerError.textContent =
            "Could not build planner for those dates. Try a closer start date.";
          plannerError.style.display = "block";
          return;
        }

        const sorted = [...rows].sort((a, b) => b.score - a.score);
        const bestScoreOverall = sorted[0].score;

        plannerSummary.textContent =
          `Best day looks to be ${sorted[0].dateStr} (${sorted[0].bestTime}) with an activity score around ${Math.round(
            bestScoreOverall
          )}/100. Hunt your best spot with the right wind.`;

        plannerTableBody.innerHTML = "";
        rows.forEach(row => {
          const tr = document.createElement("tr");
          if (row.score === bestScoreOverall) {
            tr.classList.add("best-day");
          }

          const scoreRounded = Math.round(row.score);

          tr.innerHTML =
            `<td>${row.dateStr}</td>` +
            `<td>${row.rutLabel.replace(" (Washington County, GA)", "")}</td>` +
            `<td>${row.tHi} / ${row.tLo}</td>` +
            `<td>${row.bestTime}</td>` +
            `<td>${scoreRounded}</td>`;

          plannerTableBody.appendChild(tr);
        });

        plannerResultsCard.style.display = "block";
      } catch (err) {
        console.error(err);
        plannerError.textContent =
          "Error loading 7-day forecast. Try again or adjust your dates.";
        plannerError.style.display = "block";
      } finally {
        plannerBtn.disabled = false;
        plannerBtn.textContent = "Generate 7-Day Forecast";
      }
    });
  }

  // ----- Hunt log tab -----
  const logSaveBtn = document.getElementById("logSaveBtn");
  const logClearBtn = document.getElementById("logClearBtn");
  const logError = document.getElementById("logError");

  let logEntries = loadLog();
  renderLog(logEntries);

  if (logSaveBtn) {
    logSaveBtn.addEventListener("click", () => {
      logError.style.display = "none";
      const date = document.getElementById("logDate").value;
      const timeOfDay = document.getElementById("logTimeOfDay").value;
      const deerSeen =
        parseInt(document.getElementById("logDeerSeen").value, 10) || 0;
      const shots =
        parseInt(document.getElementById("logShots").value, 10) || 0;
      const success = document.getElementById("logSuccess").value;
      const notes = document.getElementById("logNotes").value.trim();

      if (!date) {
        logError.textContent = "Please choose a date for your hunt.";
        logError.style.display = "block";
        return;
      }

      const entry = { date, timeOfDay, deerSeen, shots, success, notes };
      logEntries.push(entry);
      saveLog(logEntries);
      renderLog(logEntries);

      document.getElementById("logNotes").value = "";
    });
  }

  if (logClearBtn) {
    logClearBtn.addEventListener("click", () => {
      if (!confirm("Clear all saved hunt logs on this device?")) return;
      logEntries = [];
      saveLog(logEntries);
      renderLog(logEntries);
    });
  }
});
