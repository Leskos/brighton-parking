/* Brighton Parking — map of on-street bays coloured by whether they're restricted right now. */
"use strict";

const BRIGHTON = [-0.1372, 50.8262];
const BASEMAP = "https://tiles.openfreemap.org/styles/positron";
const DATA_URL = "data/parking_bays.geojson";
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAME = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const WEEK = 7 * 1440;
const POINTS_MAX_ZOOM = 15.5;   // below this, bays are drawn as dots; above, as shapes

const css = getComputedStyle(document.documentElement);
const COLOR = Object.fromEntries(["free", "pay", "shared", "permit", "unknown"].map(k => [k, css.getPropertyValue(`--${k}`).trim()]));

const TYPE_TITLE = { paid: "Paid parking bay", permit: "Permit holders bay", shared: "Shared use bay" };
const STATUS_TEXT = {
  free: "Free to park now",
  pay: "Pay to park now",
  shared: "Pay to park now (or permit holders)",
  permit: "Permit holders only now",
  unknown: "Hours unknown — check the signs",
};

const $ = id => document.getElementById(id);
const bays = new Map();         // id -> { p: properties, iv: [[start, end], ...] week-minute intervals | null, status }
let prices = null;              // site/prices.json, if it loaded
let selectedId = null;
let searchMarker = null;

// ---------------------------------------------------------------- time (always Europe/London)

const londonFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** Minutes since Monday 00:00, London time. */
function weekMinute(date = new Date()) {
  const p = Object.fromEntries(londonFmt.formatToParts(date).map(x => [x.type, x.value]));
  return DAYS.indexOf(p.weekday.slice(0, 3).toLowerCase()) * 1440 + (+p.hour) * 60 + (+p.minute);
}

const hhmm = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

function clock(min) {
  min = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 12 && m === 0) return "noon";
  if (h === 0 && m === 0) return "midnight";
  const h12 = h % 12 || 12, ap = h < 12 ? "am" : "pm";
  return m ? `${h12}:${String(m).padStart(2, "0")}${ap}` : `${h12}${ap}`;
}

/** Schedule windows -> list of [start, end) intervals in week-minutes. */
function compile(schedule) {
  if (!schedule || !schedule.length) return null;
  const iv = [];
  for (const w of schedule) {
    const s = hhmm(w.start), e = hhmm(w.end);
    for (const d of w.days) {
      const base = DAYS.indexOf(d) * 1440;
      iv.push([base + s, base + (e > s ? e : e + 1440)]);   // e <= s means it runs past midnight
    }
  }
  return iv;
}

function restrictedAt(iv, wm) {
  wm = ((wm % WEEK) + WEEK) % WEEK;
  return iv.some(([a, b]) => (wm >= a && wm < b) || (wm + WEEK >= a && wm + WEEK < b));
}

/** Minutes until the restriction next switches on/off, or null if it never does. */
function minutesToChange(iv, wm) {
  const now = restrictedAt(iv, wm);
  const deltas = [...new Set(iv.flat().map(x => ((x - wm) % WEEK + WEEK) % WEEK || WEEK))].sort((a, b) => a - b);
  for (const d of deltas) if (restrictedAt(iv, wm + d) !== now) return d;
  return null;
}

function statusOf(bay, wm) {
  if (!bay.iv) return "unknown";
  if (!restrictedAt(bay.iv, wm)) return "free";
  return { paid: "pay", shared: "shared", permit: "permit" }[bay.p.type];
}

function whenText(wm, delta) {
  const t = wm + delta;
  const days = Math.floor(t / 1440) - Math.floor(wm / 1440);
  const time = clock(t);
  if (days === 0) return time;
  if (days === 1) return `${time} tomorrow`;
  return `${time} ${DAY_NAME[DAYS[Math.floor(t / 1440) % 7]]}`;
}

function daysLabel(days) {
  if (days.length === 7) return "Every day";
  const idx = days.map(d => DAYS.indexOf(d));
  const contiguous = idx.every((v, i) => i === 0 || v === (idx[i - 1] + 1) % 7);
  if (contiguous && days.length > 2) return `${DAY_NAME[days[0]]}–${DAY_NAME[days[days.length - 1]]}`;
  return days.map(d => DAY_NAME[d]).join(", ");
}

function hoursLines(schedule) {
  const groups = new Map();
  for (const w of schedule) {
    const k = daysLabel(w.days);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(`${clock(hhmm(w.start))}–${clock(hhmm(w.end))}`);
  }
  return [...groups].map(([d, t]) => `${d}, ${t.join(" & ")}`);
}

const money = n => `£${n.toFixed(2)}`;

/** Price rows for a bay, e.g. [["1 hr", 1.8], ["2 hr", 3.5]], capped at its max stay. */
function priceInfo(p) {
  const band = prices?.bands?.[p.price_band];
  if (!band) return null;
  let season = null, rates = band.rates;
  if (!rates) {
    const month = +new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", month: "numeric" }).format(new Date());
    season = month >= 3 && month <= 10 ? "summer" : "winter";
    rates = band[season];
  }
  const tiers = Object.entries(rates).map(([m, v]) => [+m, v]).sort((a, b) => a[0] - b[0]);
  const max = p.max_stay_mins;
  const rows = [];
  for (const [m, v] of tiers) {
    if (max != null && m > max) {
      // Max stay falls between tiers (e.g. 3 hr): you pay the next tier's "up to" price.
      if (!rows.length || rows[rows.length - 1][0] < max) rows.push([max, v]);
      break;
    }
    rows.push([m, v]);
  }
  return { label: band.label, season, rows: rows.map(([m, v]) => [duration(m), v]) };
}

function duration(mins) {
  if (mins == null) return null;
  const h = Math.floor(mins / 60), m = mins % 60;
  return [h && `${h} hr`, m && `${m} min`].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- map

const map = new maplibregl.Map({
  container: "map",
  style: BASEMAP,
  center: BRIGHTON,
  zoom: 14,
  minZoom: 10,
  attributionControl: { compact: true },
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();

const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  fitBoundsOptions: { maxZoom: 17 },
});
map.addControl(geolocate, "bottom-right");
geolocate.on("error", () => toast("Couldn't get your location"));

fetch("prices.json").then(r => r.ok ? r.json() : null).then(j => { prices = j; }).catch(() => {});

const dataReady = fetch(DATA_URL).then(r => {
  if (!r.ok) throw new Error(r.status);
  return r.json();
});

map.on("load", async () => {
  let fc;
  try {
    fc = await dataReady;
  } catch {
    $("loading").textContent = "Couldn't load parking data";
    return;
  }

  const points = { type: "FeatureCollection", features: [] };
  for (const f of fc.features) {
    const p = f.properties;
    bays.set(p.id, { p, iv: compile(p.schedule), status: null });
    points.features.push({ type: "Feature", properties: { id: p.id }, geometry: { type: "Point", coordinates: p.centroid } });
  }

  map.addSource("bays", { type: "geojson", data: fc, promoteId: "id" });
  map.addSource("points", { type: "geojson", data: points, promoteId: "id" });

  const color = ["match", ["coalesce", ["feature-state", "status"], "unknown"],
    "free", COLOR.free, "pay", COLOR.pay, "shared", COLOR.shared, "permit", COLOR.permit, COLOR.unknown];
  const beforeLabels = map.getStyle().layers.find(l => l.type === "symbol")?.id;

  map.addLayer({
    id: "bays-fill", type: "fill", source: "bays", minzoom: POINTS_MAX_ZOOM - 0.5,
    paint: { "fill-color": color, "fill-opacity": 0.55 },
  }, beforeLabels);
  map.addLayer({
    id: "bays-line", type: "line", source: "bays", minzoom: POINTS_MAX_ZOOM - 0.5,
    paint: { "line-color": color, "line-width": ["interpolate", ["linear"], ["zoom"], 15, 1, 19, 2.5] },
  }, beforeLabels);
  map.addLayer({
    id: "bays-selected", type: "line", source: "bays",
    paint: {
      "line-color": "#111",
      "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3.5, 0],
    },
  });
  map.addLayer({
    id: "bays-points", type: "circle", source: "points", maxzoom: POINTS_MAX_ZOOM,
    paint: {
      "circle-color": color,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 13, 2.5, 15.5, 5],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12, 0, 14, 0.8],
    },
  });

  refresh();
  setInterval(refresh, 30 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  $("loading").hidden = true;

  // Jump to the user's location straight away if they've already allowed it.
  navigator.permissions?.query({ name: "geolocation" })
    .then(s => { if (s.state === "granted") geolocate.trigger(); })
    .catch(() => {});
});

/** Recompute every bay's status for the current London time and repaint the ones that changed. */
function refresh() {
  const wm = weekMinute();
  for (const [id, bay] of bays) {
    const s = statusOf(bay, wm);
    if (s !== bay.status) {
      bay.status = s;
      map.setFeatureState({ source: "bays", id }, { status: s });
      map.setFeatureState({ source: "points", id }, { status: s });
    }
  }
  $("clock").textContent = `Now · ${DAY_NAME[DAYS[Math.floor(wm / 1440)]]} ${clock(wm % 1440)}`;
  if (selectedId) renderSheet(selectedId);
}

// ---------------------------------------------------------------- tapping a bay

map.on("click", e => {
  const { x, y } = e.point;
  // A tap squarely inside a bay wins; otherwise take the nearest bay within a finger's width.
  let hits = map.queryRenderedFeatures(e.point, { layers: ["bays-fill"] });
  if (!hits.length) {
    const pad = 18;
    hits = map.queryRenderedFeatures([[x - pad, y - pad], [x + pad, y + pad]], { layers: ["bays-fill", "bays-points"] });
  }
  if (!hits.length) return closeSheet();

  let best = null, bestD = Infinity;
  for (const f of hits) {
    const c = map.project(bays.get(f.properties.id).p.centroid);
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bestD) { bestD = d; best = f.properties.id; }
  }
  select(best);
});

for (const layer of ["bays-fill", "bays-points"]) {
  map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
}

function select(id) {
  if (selectedId) map.setFeatureState({ source: "bays", id: selectedId }, { selected: false });
  selectedId = id;
  map.setFeatureState({ source: "bays", id }, { selected: true });
  renderSheet(id);

  // Nudge the map up if the bay is hidden behind the sheet.
  const sheetH = $("sheet").offsetHeight;
  const pt = map.project(bays.get(id).p.centroid);
  const visibleBottom = window.innerHeight - sheetH - 30;
  if (pt.y > visibleBottom) map.panBy([0, pt.y - (window.innerHeight - sheetH) / 2]);
}

function closeSheet() {
  if (selectedId) map.setFeatureState({ source: "bays", id: selectedId }, { selected: false });
  selectedId = null;
  $("sheet").hidden = true;
}
$("sheet-close").addEventListener("click", closeSheet);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderSheet(id) {
  const bay = bays.get(id), p = bay.p;
  const wm = weekMinute();
  const status = statusOf(bay, wm);

  let detail = "";
  if (bay.iv) {
    const d = minutesToChange(bay.iv, wm);
    if (d != null) {
      const when = whenText(wm, d);
      detail = status === "free"
        ? { paid: `Charges apply from ${when}`, shared: `Charges apply from ${when}`, permit: `Permit holders only from ${when}` }[p.type]
        : `Free from ${when}`;
    } else if (status !== "free") {
      detail = "At all times";
    }
  }

  const title = TYPE_TITLE[p.type] + (p.red_route ? " · Red route" : "");
  const price = priceInfo(p);
  const priceLabel = p.price_band ? prices?.bands?.[p.price_band]?.label : null;
  const sub = [p.zone && p.zone !== "SEA" && `Zone ${p.zone}`, priceLabel || (p.tariff && `${p.tariff} tariff`)].filter(Boolean).join(" · ");
  if ((status === "pay" || status === "shared") && price?.rows.length) {
    detail = `From ${money(price.rows[0][1])} for ${price.rows[0][0]}` + (detail ? ` · ${detail}` : "");
  }

  const facts = [];
  if (p.schedule) facts.push(["Hours", hoursLines(p.schedule).map(esc).join("<br>")]);
  else if (p.days_raw || p.times_raw) facts.push(["Hours", esc([p.days_raw, p.times_raw].filter(Boolean).join(", "))]);
  if (p.type !== "permit") {
    if (p.max_stay_mins != null) facts.push(["Max stay", esc(duration(p.max_stay_mins))]);
    if (p.no_return_mins != null) facts.push(["No return", `within ${esc(duration(p.no_return_mins))}`]);
  }
  if (p.type === "shared") facts.push(["Permits", `Zone ${esc(p.zone || "?")} permit holders can park without paying`]);
  if (p.type === "permit") facts.push(["Who", `Zone ${esc(p.zone || "?")} permit holders during hours`]);
  if (price) {
    const note = price.season ? ` <span class="muted">(${price.season} rate)</span>` : "";
    facts.push(["Prices", `<table class="prices">${price.rows.map(([d, v]) =>
      `<tr><td>up to ${esc(d)}</td><td>${money(v)}</td></tr>`).join("")}</table>${note}`]);
  } else if (p.type !== "permit") {
    facts.push(["Prices", `<span class="muted">Not known, so check the sign or PayByPhone</span>`]);
  }
  if (p.pay_by_phone) facts.push(["PayByPhone", `<span class="pbp"><code>${esc(p.pay_by_phone)}</code>
      <button class="btn" data-copy="${esc(p.pay_by_phone)}">Copy</button></span>`]);

  const [lon, lat] = p.centroid;
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && "ontouchend" in document;
  const directions = isApple
    ? `https://maps.apple.com/?daddr=${lat},${lon}`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;

  $("sheet-body").innerHTML = `
    <h2>${esc(title)}</h2>
    <div class="sub">${esc(sub)}</div>
    <div class="status" style="--c:${COLOR[status]}">
      <i></i><div><b>${esc(STATUS_TEXT[status])}</b>${detail ? `<span>${esc(detail)}</span>` : ""}</div>
    </div>
    <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
    ${p.issues ? `<div class="warn">Some of the council's data for this bay was unclear or missing, so double-check the signs.</div>` : ""}
    <div class="actions"><a class="btn primary" href="${directions}" target="_blank" rel="noopener">Directions</a></div>
    <p class="fine">From Brighton & Hove City Council data. Signs on the street always take precedence.</p>`;
  $("sheet").hidden = false;
}

$("sheet-body").addEventListener("click", async e => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  try {
    await navigator.clipboard.writeText(b.dataset.copy);
    b.textContent = "Copied";
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  } catch {
    toast(`PayByPhone code: ${b.dataset.copy}`);
  }
});

// ---------------------------------------------------------------- search

const FULL_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const BH_VIEWBOX = "-0.26,50.89,-0.02,50.79";   // Brighton & Hove, for place-name searches

$("search").addEventListener("submit", async e => {
  e.preventDefault();
  const input = $("q");
  const q = input.value.trim();
  if (!q) return;
  input.blur();   // dismiss the phone keyboard
  try {
    const hit = await geocode(q);
    if (!hit) return toast(`Couldn't find “${q}”`);
    closeSheet();
    map.flyTo({ center: [hit.lon, hit.lat], zoom: hit.zoom, speed: 1.6 });
    searchMarker?.remove();
    searchMarker = new maplibregl.Marker({ color: "#1f3a5f" }).setLngLat([hit.lon, hit.lat]).addTo(map);
  } catch {
    toast("Search failed — check your connection");
  }
});

async function geocode(q) {
  const compact = q.replace(/\s+/g, "");
  if (FULL_POSTCODE.test(q)) {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(compact)}`);
    if (r.ok) { const { result } = await r.json(); return { lat: result.latitude, lon: result.longitude, zoom: 17.5 }; }
    if (r.status !== 404) throw new Error(r.status);
    return null;
  }
  if (OUTCODE.test(q)) {
    const r = await fetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(compact)}`);
    if (r.ok) { const { result } = await r.json(); return { lat: result.latitude, lon: result.longitude, zoom: 15 }; }
    if (r.status !== 404) throw new Error(r.status);
  }
  // Anything else: a street or place name in Brighton & Hove, via OpenStreetMap's Nominatim.
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&countrycodes=gb&bounded=1`
    + `&viewbox=${BH_VIEWBOX}&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "Accept-Language": "en-GB" } });
  if (!r.ok) throw new Error(r.status);
  const hits = await r.json();
  if (!hits.length) return null;
  // Prefer results inside the city, then the one nearest to where the map is looking.
  const inCity = hits.filter(h => h.display_name.includes("Brighton and Hove"));
  const c = map.getCenter();
  const dist = h => (h.lat - c.lat) ** 2 + ((h.lon - c.lng) * Math.cos(c.lat * Math.PI / 180)) ** 2;
  const hit = (inCity.length ? inCity : hits).sort((a, b) => dist(a) - dist(b))[0];
  return { lat: +hit.lat, lon: +hit.lon, zoom: 17 };
}

// Postcode suggestions as you type.
let suggestTimer;
$("q").addEventListener("input", e => {
  clearTimeout(suggestTimer);
  const q = e.target.value.trim();
  if (q.length < 3 || !/^[A-Z]{1,2}\d/i.test(q)) return;
  suggestTimer = setTimeout(async () => {
    try {
      const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(q)}/autocomplete?limit=6`);
      const { result } = await r.json();
      $("suggestions").innerHTML = (result || []).map(pc => `<option value="${esc(pc)}">`).join("");
    } catch { /* suggestions are optional */ }
  }, 250);
});

// ---------------------------------------------------------------- toast

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
