/* Search-as-you-type suggestions for streets, venues and postcodes.
 * Streets and venues come from Photon (komoot's OpenStreetMap geocoder, which allows autocomplete;
 * Nominatim's usage policy doesn't). Postcodes come from postcodes.io. */
"use strict";

const PHOTON = "https://photon.komoot.io/api/";
const BH_BBOX = "-0.26,50.79,-0.02,50.89";   // minLon,minLat,maxLon,maxLat
const ABBREVIATIONS = [[/\bst$/i, "street"], [/\brd$/i, "road"], [/\bave?$/i, "avenue"], [/\bsq$/i, "square"],
  [/\bpl$/i, "place"], [/\bcres$/i, "crescent"], [/\bgdns$/i, "gardens"], [/\bter$/i, "terrace"]];

const ICON = {
  street: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 3 5 21M16 3l3 18M12 4v3M12 11v3M12 18v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  venue: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="9.5" r="2.5" fill="currentColor"/></svg>',
  postcode: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 10h4M7 14h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

const titleCase = s => s.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());

function photonItem(f) {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  const area = p.district || p.locality || p.city || "";
  const isStreet = p.osm_key === "highway" && p.type === "street";
  const item = { lat, lon, label: p.name || [p.housenumber, p.street].filter(Boolean).join(" ") };
  if (!item.label) return null;
  if (isStreet) {
    item.kind = "street";
    item.sub = ["Street", area, p.postcode && p.postcode.split(" ")[0]].filter(Boolean).join(" · ");
    if (p.extent) item.bbox = [[p.extent[0], p.extent[3]], [p.extent[2], p.extent[1]]];
    item.key = `street|${item.label}|${area}`;
  } else {
    item.kind = "venue";
    const where = [p.street && [p.housenumber, p.street].filter(Boolean).join(" "), area].filter(Boolean).join(", ");
    item.sub = [p.osm_value && titleCase(p.osm_value), where].filter(Boolean).join(" · ");
    item.key = `venue|${item.label}|${p.street || area}`;
  }
  return item;
}

async function fetchSuggestions(q, signal) {
  if (/^[A-Z]{1,2}\d/i.test(q)) {
    const r = await fetch(`https://api.postcodes.io/postcodes?q=${encodeURIComponent(q)}&limit=6`, { signal });
    const { result } = await r.json();
    if (result?.length) {
      return result.map(pc => ({
        kind: "postcode", label: pc.postcode, lat: pc.latitude, lon: pc.longitude,
        sub: ["Postcode", pc.admin_ward].filter(Boolean).join(" · "), key: pc.postcode,
      }));
    }
  }
  let text = q;
  for (const [re, full] of ABBREVIATIONS) text = text.replace(re, full);
  const c = map.getCenter();
  const url = `${PHOTON}?q=${encodeURIComponent(text)}&limit=10&lang=en&bbox=${BH_BBOX}&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(r.status);
  const byKey = new Map();
  for (const f of (await r.json()).features) {
    const it = photonItem(f);
    if (!it) continue;
    const prev = byKey.get(it.key);
    if (!prev) { byKey.set(it.key, it); continue; }
    // A street comes back once per stretch of road: merge them so the whole street is framed.
    if (prev.bbox && it.bbox) {
      prev.bbox = [[Math.min(prev.bbox[0][0], it.bbox[0][0]), Math.min(prev.bbox[0][1], it.bbox[0][1])],
                   [Math.max(prev.bbox[1][0], it.bbox[1][0]), Math.max(prev.bbox[1][1], it.bbox[1][1])]];
      prev.lon = (prev.bbox[0][0] + prev.bbox[1][0]) / 2;
      prev.lat = (prev.bbox[0][1] + prev.bbox[1][1]) / 2;
    }
  }
  return [...byKey.values()].slice(0, 6);
}

/**
 * Attach a suggestion dropdown to an input.
 * onPick(item) receives { kind, label, sub, lat, lon, bbox? }.
 * Returns { first() } so a form submit can fall back to the top suggestion.
 */
function attachSuggest(input, list, onPick) {
  let items = [], active = -1, timer, controller, seq = 0;
  list.setAttribute("role", "listbox");
  input.setAttribute("aria-autocomplete", "list");

  const close = () => { list.hidden = true; active = -1; };
  const render = () => {
    list.innerHTML = items.map((it, i) => `
      <li role="option" aria-selected="${i === active}" data-i="${i}" class="${i === active ? "on" : ""}">
        <span class="ico ${it.kind}">${ICON[it.kind]}</span>
        <span class="txt"><b>${esc(it.label)}</b><small>${esc(it.sub || "")}</small></span>
      </li>`).join("");
    list.hidden = !items.length;
  };
  const pick = i => {
    const it = items[i];
    if (!it) return;
    input.value = it.label;
    close();
    input.blur();
    onPick(it);
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    controller?.abort();
    const q = input.value.trim();
    if (q.length < 2) { items = []; close(); return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      controller = new AbortController();
      try {
        const res = await fetchSuggestions(q, controller.signal);
        if (mine !== seq) return;
        items = res;
        active = -1;
        render();
      } catch { /* suggestions are optional */ }
    }, 220);
  });
  input.addEventListener("keydown", e => {
    if (list.hidden || !items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      render();
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      close();
    }
  });
  // pointerdown fires before the input's blur, so the tap isn't lost when the list closes.
  list.addEventListener("pointerdown", e => {
    const li = e.target.closest("li[data-i]");
    if (!li) return;
    e.preventDefault();
    pick(+li.dataset.i);
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
  input.addEventListener("focus", () => { if (items.length && input.value.trim().length >= 2) render(); });

  return { first: () => (!list.hidden && items.length ? items[0] : null), close };
}
