// Weather that follows the PC around (Auckland now, China later), all keyless:
// - where: Windows location (location.ps1), named via BigDataCloud's reverse geocoder
// - forecast: Open-Meteo, the next day hourly + 4 days, fetched once an hour (the cache rides out its outages)
// - reality check: the nearest airport's live observation (METAR, aviationweather.gov). Models happily say
//   "drizzle" under a clear sky, so "now" is what the airport measured, and the forecast temperatures are
//   shifted by the model's current error, fading out over the next 6 hours.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { writeCache } = require("./extras");

const FORECAST_TTL = 60 * 60e3, RETRY = 10 * 60e3, OBS_TTL = 10 * 60e3, PLACE_TTL = 30 * 60e3;
const OBS_MAX_KM = 35, OBS_MAX_AGE = 90 * 60e3, FADE = 6 * 3600e3;
const DEFAULT = { lat: -36.85, lon: 174.76, name: "Auckland" };
// WEATHER_LAT / WEATHER_LON (+ WEATHER_CITY) pin the place instead of following Windows location
const FIXED = process.env.WEATHER_LAT && process.env.WEATHER_LON
  ? { lat: Number(process.env.WEATHER_LAT), lon: Number(process.env.WEATHER_LON), name: process.env.WEATHER_CITY || "" } : null;

const FILE = path.join(__dirname, "weather-cache.json");
let cache = (() => { try { const c = JSON.parse(fs.readFileSync(FILE, "utf8")); return c.v === 2 ? c : { v: 2 }; } catch { return { v: 2 }; } })();
const save = () => writeCache(FILE, cache);

const km = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------- where ----------
function windowsLocation() {
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "location.ps1")],
      { timeout: 20000, windowsHide: true, encoding: "utf8" }, (err, out) => {
        const [lat, lon] = (out || "").trim().split(",").map(Number);
        resolve(Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null);
      });
  });
}
async function placeName({ lat, lon }) {
  try {
    const j = await getJson(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    return j.city || j.locality || j.principalSubdivision || "";
  } catch { return ""; }
}
let placeAt = 0;
async function readPlace() {
  if (FIXED) return FIXED;
  if (Date.now() - placeAt < PLACE_TTL && cache.place) return cache.place;
  placeAt = Date.now();
  const pos = await windowsLocation();
  // small moves (Wi-Fi positioning jitter) keep the old place, so the forecast isn't refetched for nothing
  if (pos && (!cache.place || km(pos, cache.place) > 3 || !cache.place.name)) {
    cache.place = { lat: +pos.lat.toFixed(3), lon: +pos.lon.toFixed(3), name: await placeName(pos) };
    save();
  }
  return cache.place || DEFAULT;
}

// ---------- forecast ----------
let forecastTry = 0;
async function readForecast(place) {
  const f = cache.forecast, fresh = f && Date.now() - f.fetchedAt < FORECAST_TTL && km(f, place) < 3;
  if (fresh || Date.now() - forecastTry < RETRY) return f && km(f, place) < 50 ? f : null;
  forecastTry = Date.now();
  try {
    const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&timezone=auto` +
      `&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code&past_hours=3&forecast_hours=27` +
      `&minutely_15=precipitation&forecast_minutely_15=24` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=4`);
    const at = (t) => Date.parse(t + "Z") - j.utc_offset_seconds * 1000; // local ISO -> epoch ms
    cache.forecast = {
      fetchedAt: Date.now(), lat: place.lat, lon: place.lon, tz: j.timezone,
      hourly: j.hourly.time.map((t, i) => ({
        at: at(t), temp: j.hourly.temperature_2m[i], feels: j.hourly.apparent_temperature[i],
        rain: j.hourly.precipitation_probability[i] ?? 0, code: j.hourly.weather_code[i],
      })),
      rain15: (j.minutely_15?.time || []).map((t, i) => ({ at: at(t), mm: j.minutely_15.precipitation[i] ?? 0 })),
      days: j.daily.time.map((date, i) => ({
        date, code: j.daily.weather_code[i], max: j.daily.temperature_2m_max[i],
        min: j.daily.temperature_2m_min[i], rain: j.daily.precipitation_probability_max[i],
      })),
    };
    save();
  } catch { /* keep the last day we have */ }
  return cache.forecast && km(cache.forecast, place) < 50 ? cache.forecast : null;
}

// ---------- what the nearest airport sees ----------
let obsAt = 0;
async function readObs(place) {
  const o = cache.obs;
  if (Date.now() - obsAt < OBS_TTL) return o && km(o, place) <= OBS_MAX_KM ? o : null;
  obsAt = Date.now();
  try {
    const dLat = 0.4, dLon = 0.4 / Math.cos(place.lat * Math.PI / 180);
    const bbox = [place.lat - dLat, place.lon - dLon, place.lat + dLat, place.lon + dLon].map((v) => v.toFixed(2)); // long floats get a 400
    const list = await getJson(`https://aviationweather.gov/api/data/metar?format=json&bbox=${bbox}`);
    const best = (Array.isArray(list) ? list : [])
      .filter((m) => m.temp != null && m.obsTime * 1000 > Date.now() - OBS_MAX_AGE)
      .map((m) => ({ station: m.icaoId, lat: m.lat, lon: m.lon, at: m.obsTime * 1000, temp: m.temp,
        // weather here, not "VC" (in the vicinity)
        wx: (m.wxString || "").split(" ").filter((w) => !w.startsWith("VC")).join(" "), cover: m.cover || "" }))
      .map((m) => ({ ...m, km: km(m, place) })).filter((m) => m.km <= OBS_MAX_KM).sort((a, b) => a.km - b.km)[0];
    cache.obs = best || null;
    save();
  } catch { /* a missed observation just means no correction */ }
  return cache.obs && Date.now() - cache.obs.at < OBS_MAX_AGE && km(cache.obs, place) <= OBS_MAX_KM ? cache.obs : null;
}

const WET = /DZ|RA|SN|SG|PL|GS|GR|UP|TS/;
// METAR present weather / cloud cover -> WMO weather code (what the panel's icons and labels use)
function obsCode({ wx, cover }) {
  const lvl = (light, mid, heavy) => (wx.includes("+") ? heavy : wx.includes("-") ? light : mid);
  if (/TS/.test(wx)) return 95;
  if (/SN|SG|PL|GS|GR/.test(wx)) return lvl(71, 73, 75);
  if (/RA/.test(wx)) return /SH/.test(wx) ? lvl(80, 81, 82) : lvl(61, 63, 65);
  if (/DZ/.test(wx)) return lvl(51, 53, 55);
  if (/FG/.test(wx)) return 45;
  return { CLR: 0, SKC: 0, NSC: 0, NCD: 0, CAVOK: 0, FEW: 1, SCT: 2, BKN: 2, OVC: 3, OVX: 3 }[cover] ?? null;
}

function interp(series, t, key) {
  for (let i = 0; i < series.length - 1; i++) {
    const a = series[i], b = series[i + 1];
    if (a.at <= t && t <= b.at) return a[key] + ((b[key] - a[key]) * (t - a.at)) / (b.at - a.at);
  }
  return null;
}

async function readWeather() {
  const place = await readPlace();
  const [f, obs] = await Promise.all([readForecast(place), readObs(place)]);
  if (!f) return null;
  const now = Date.now();
  const model = interp(f.hourly, obs ? obs.at : now, "temp");
  const delta = obs && model != null ? obs.temp - model : 0;
  const fix = (at) => delta * Math.max(0, 1 - Math.max(0, at - (obs ? obs.at : now)) / FADE);
  const hour = f.hourly.find((h) => h.at <= now && now < h.at + 3600e3) || f.hourly[0];
  const temp = obs ? obs.temp : interp(f.hourly, now, "temp") ?? hour.temp;
  const feels = (interp(f.hourly, now, "feels") ?? hour.feels) + fix(now);
  const today = f.days[0];
  return {
    place: { name: place.name || (FIXED ? "" : DEFAULT.name), lat: place.lat, lon: place.lon, tz: f.tz },
    now: { temp, feels, code: (obs && obsCode(obs)) ?? hour.code },
    observed: obs ? { station: obs.station, at: obs.at, km: Math.round(obs.km) } : null,
    raining: obs ? WET.test(obs.wx) : null, // null: no observation, go by the model
    // next 12 hours, corrected; the first point is now
    hourly: [{ at: now, temp, feels, rain: obs ? (WET.test(obs.wx) ? 100 : 0) : hour.rain },
      ...f.hourly.filter((h) => h.at > now).slice(0, 12).map((h) => ({ ...h, temp: h.temp + fix(h.at), feels: h.feels + fix(h.at) }))],
    rain15: f.rain15,
    days: [{ ...today, max: Math.max(today.max, temp), min: Math.min(today.min, temp) }, ...f.days.slice(1)],
  };
}

module.exports = { readWeather };

if (require.main === module) readWeather().then((w) => console.dir(w, { depth: 3 }));
