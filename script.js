// --- helpers ----------------------------------------------------

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

// Rut model for Washington County, GA using GA DNR rut map:
// Peak: Oct 27 – Nov 2. Second rut ≈ 28 days later.
function getRutPhaseForWashingtonGA(date) {
  const year = date.getFullYear();

  const peakStart = new Date(year, 9, 27); // Oct = 9
  const peakEnd   = new Date(year, 10, 2); // Nov 2

  const secondStart = new Date(year, 10, 24); // ~Nov 24
  const secondEnd   = new Date(year, 10, 30); // ~Nov 30

  if (date >= peakStart && date <= peakEnd) {
    return { id: "rut", label: "Peak rut (Washington County, GA)" };
  }
  if (date >= secondStart && date <= secondEnd) {
    return { id: "secondRut", label: "Second rut (late November, Washington County, GA)" };
  }
  if (date < peakStart) {
    const diffDays = Math.round((peakStart - date) / DAY_MS);
    if (diffDays <= 14) {
      return { id: "pre", label: "Pre-rut (within 2 weeks of peak)" };
    }
    return { id: "early", label: "Early season relative to peak rut" };
  }
  if (date > peakEnd && date < secondStart) {
    return { id: "post", label: "Post-peak rut heading toward second rut" };
  }
  if (date > secondEnd) {
    return { id: "late", label: "Late season after second rut" };
  }
  return { id: "early", label: "General season" };
}

// --- scoring model ---------------------------------------------

function getBaseFromRut(rutPhase) {
  switch (rutPhase) {
    case "early": return 45;
    case "pre": return 55;
    case "rut": return 65;
    case "secondRut": return 68; // strong
    case "post": return 50;
    case "late": return 45;
    default: return 50;
  }
}

function getTimeOfDayModifier(timeOfDay, rutPhase) {
  if (timeOfDay === "morning") return 8;
  if (timeOfDay === "evening") return 6;
  if (timeOfDay === "allDay") return 10;

  // Midday
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
      return "Key in on ridges, saddles, and downwind sides of oak flats. Set up on travel routes from bedding to feed in the morning.";
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

function buildExtraTips(timeOfDay, rutPhase, flags, allDay) {
  const tips = [];

  if ((rutPhase === "rut" || rutPhase === "secondRut") && (timeOfDay === "midday" || allDay)) {
    tips.push("During the rut or second rut, don’t sleep on 10 AM – 2 PM. Cruising bucks can appear out of nowhere.");
  }

  if (flags.coldFront) {
    tips.push("You’re hunting behind a front – be set up early, as deer may move earlier in the evening and later into the morning.");
  }

  if (flags.highWind) {
    tips.push("With higher winds, cheat down into leeward sides of hills or thicker cover where deer feel more comfortable.");
  }

  if (!tips.length) {
    tips.push("Play the wind perfectly, keep your entry quiet, and give your best spots rest when the wind is wrong.");
  }

  return tips.join(" ");
}

// --- live weather fetching (Open-Meteo) ------------------------

async function fetchWeather(lat, lon, dateStr) {
  const targetDate = new Date(dateStr);
  const prevDate = new Date(targetDate.getTime() - DAY_MS);
  const startStr = formatDate(prevDate);
  const endStr = formatDate(targetDate);

  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max" +
    "&timezone=auto&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch" +
    `&start_date=${startStr}&end_date=${endStr}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Weather request failed");
  }
  const data = await res.json();

  const daily = data.daily;
  if (!daily || !daily.time || !daily.time.length) {
    throw new Error("No daily weather data available");
  }

  const times = daily.time;
  const idxToday = times.indexOf(endStr);
  const idxPrev = times.indexOf(startStr);

  if (idxToday === -1) {
    throw new Error("Selected date not in weather forecast range");
  }

  const today = {
    date: endStr,
    tMax: daily.temperature_2m_max[idxToday],
    tMin: daily.temperature_2m_min[idxToday],
    precip: daily.precipitation_sum[idxToday],
    windMax: daily.windspeed_10m_max[idxToday]
  };

  let prev = null;
  if (idxPrev !== -1) {
    prev = {
      date: startStr,
      tMax: daily.temperature_2m_max[idxPrev],
      tMin: daily.temperature_2m_min[idxPrev],
      precip: daily.precipitation_sum[idxPrev],
      windMax: daily.windspeed_10m_max[idxPrev]
    };
  }

  return { today, prev };
}

function deriveWeatherFlags(today, prev, targetDate) {
  const month = new Date(targetDate).getMonth() + 1; // 1–12

  const recentRain =
    (prev && prev.precip > 0.05) || (today && today.precip > 0.05);

  let coldFront = false;
  if (prev) {
    const drop = prev.tMax - today.tMax;
    // big temp drop suggests a front
    if (drop >= 10 && prev.precip > 0.05) {
      coldFront = true;
    }
  }

  const highWind = today.windMax >= 15;

  const veryWarm =
    month >= 9 && month <= 12 && today.tMax >= 75;

  return { recentRain, coldFront, highWind, veryWarm };
}

// --- DOM wiring ------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  const calculateBtn = document.getElementById("calculateBtn");
  const errorText = document.getElementById("errorText");
  const weatherCard = document.getElementById("weatherCard");
  const rutPhaseAuto = document.getElementById("rutPhaseAuto");
  const weatherSummary = document.getElementById("weatherSummary");
  const weatherDetails = document.getElementById("weatherDetails");

  const resultsCard = document.getElementById("resultsCard");
  const scoreText = document.getElementById("scoreText");
  const chanceText = document.getElementById("chanceText");
  const ratingText = document.getElementById("ratingText");
  const tipsText = document.getElementById("tipsText");

  calculateBtn.addEventListener("click", async () => {
    errorText.style.display = "none";
    resultsCard.style.display = "none";
    weatherCard.style.display = "none";

    const dateStr = document.getElementById("date").value;
    const timeOfDay = document.getElementById("timeOfDay").value;
    const terrain = document.getElementById("terrain").value;
    const huntingPressure = document.getElementById("huntingPressure").value;
    const lat = parseFloat(document.getElementById("lat").value);
    const lon = parseFloat(document.getElementById("lon").value);

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

      // show weather card
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
      }

      const flagDescriptions = [];
      if (flags.coldFront) flagDescriptions.push("Cold front detected");
      if (flags.recentRain) flagDescriptions.push("Recent rain");
      if (flags.highWind) flagDescriptions.push("High wind for part of the day");
      if (flags.veryWarm) flagDescriptions.push("Very warm for the season");

      if (flagDescriptions.length) {
        details += `Signals: ${flagDescriptions.join(", ")}.`;
      } else {
        details += "Weather signals are fairly neutral.";
      }

      weatherDetails.textContent = details;
      weatherCard.style.display = "block";

      // score calculation
      let score = getBaseFromRut(rutPhase);
      score += getTimeOfDayModifier(timeOfDay, rutPhase);
      score += getWeatherModifier(flags);
      score += getPressureModifier(huntingPressure);

      if ((rutPhase === "rut" || rutPhase === "secondRut") && terrain === "pinesClearcuts") {
        score += 3;
      }

      score = clamp(score, 20, 90);
      const chancePercent = clamp(Math.round(score), 10, 95);

      scoreText.textContent = `Activity Score: ${score.toFixed(0)} / 100`;
      chanceText.textContent =
        `Estimated chance of seeing deer in daylight: ${chancePercent}%`;
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
        "Could not load weather or calculate odds. Try a date within the next 16 days and check your connection.";
      errorText.style.display = "block";
    } finally {
      calculateBtn.disabled = false;
      calculateBtn.textContent = "Fetch Live Weather & Calculate Odds";
    }
  });
});
