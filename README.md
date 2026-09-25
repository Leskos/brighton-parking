# Brighton & Hove on-street parking data

`scrape.py` downloads paid, permit, and shared-use parking bays from Brighton & Hove City Council's
public ArcGIS feature service (the one behind their
[On-Street Parking Information app](https://experience.arcgis.com/experience/bc9e3e192b794c268d144192a53939c6)).
It turns the council's messy free-text fields into structured data.

```
python scrape.py      # stdlib only, ~30s; re-run any time to refresh
```

## Source layers

| Layer | Service URL | `type` |
|---|---|---|
| Paid Parking Only | `.../Parking/MBTRO/FeatureServer/57` | `paid` |
| Permit Holders Only | `.../Parking/MBTRO/FeatureServer/60` | `permit` |
| Shared Permit Or Paid | `.../Parking/MBTRO/FeatureServer/62` | `shared` |

## Outputs (`data/`)

- **`parking_bays.geojson`**: every bay as a polygon (WGS84, 6 dp) with the cleaned properties below. Loads directly into Leaflet or MapLibre.
- **`parking_bays.csv`**: the same properties without geometry, plus centroid `lat`/`lon`. Useful for lists, search, or a spreadsheet.
- **`metadata.json`**: fetch time, counts, and every record that needed an assumption or couldn't be parsed.
- **`raw/*.geojson`**: the records exactly as the council serves them.

## Bay properties

| Field | Example | Notes |
|---|---|---|
| `id` | `shared-1` | `<type>-<source OBJECTID>` |
| `type` | `shared` | `paid` \| `permit` \| `shared` |
| `zone` | `N&R` | Controlled parking zone |
| `red_route` | `false` | Bay is on a red route |
| `tariff` | `Low` | `Low` / `Medium` / `High` / `High-Summer & Low-Winter` (paid and shared only) |
| `pay_by_phone` | `85528` | PayByPhone location code |
| `max_stay_mins` | `120` | Maximum stay for paying visitors |
| `no_return_mins` | `240` | No return within this period |
| `schedule` | see below | When the restriction applies. Outside these windows the bay is unrestricted. |
| `centroid` | `[-0.1756, 50.8348]` | `[lon, lat]`, useful for markers and "nearest bay" |
| `area_m2`, `perimeter_m` | `104.2` | Rough bay size |
| `*_raw` | `9 am to 8 pm` | Original text, kept for display and audit |
| `issues` | `null` | Assumptions made while parsing, if any |

`schedule` is a list of windows, each with a set of days and a local (Europe/London) start and end time:

```json
[{"days": ["mon","tue","wed","thu","fri"], "start": "09:00", "end": "10:00"},
 {"days": ["mon","tue","wed","thu","fri"], "start": "13:00", "end": "14:00"}]
```

A bay is restricted when the current weekday is in `days` and `start <= now < end` for any window.

## Data caveats

- Around 30 records needed an assumption. Each one is listed in `metadata.json` and in the record's `issues` field. Examples: `"11"` max stay read as 11 hours; `"11 am Noon"` read as 11:00–12:00; `"7 pm & 8 pm"` read as 19:00–20:00.
- Two bays have no usable schedule: `paid-144` (no days or times recorded) and `permit-414` (start time missing).
- `permit-2753` ("Sun to Fri & Sat" / "9 am to 8 pm & 4 pm to 8 pm") was paired by position: Sun–Fri 09:00–20:00, Sat 16:00–20:00.
- The council's data is not the legal record. On-street signs and the traffic orders take precedence. Check the licence before republishing.

## The web app

`site/` is a static, mobile-first map (no build step, no framework):

- **`index.html` / `style.css` / `app.js`**: a MapLibre GL map on OpenFreeMap tiles. Bays are coloured by their status *right now*, in Europe/London time: free, pay, pay-or-permit, permit only, or unknown. The colours refresh every 30 seconds. Tapping a bay opens a card with its hours, when the status next changes, max stay, and PayByPhone code.
- **Search**: postcodes (and partial postcodes like `BN1`) via [postcodes.io](https://postcodes.io), with suggestions as you type. Street and place names use OpenStreetMap's Nominatim, limited to Brighton & Hove.
- **Prices** (`prices.json`): the council's current £ rates, copied by hand from its [per-zone price pages](https://www.brighton-hove.gov.uk/parking/street-parking/paid-parking-zone-prices). `scrape.py` gives each paid or shared bay a `price_band`, matching by PayByPhone code first (seafront and Kingsway bays have their own seasonal rates) and then by tariff (Low/Medium/High). The card shows rates up to the bay's max stay. **When the council changes prices, edit `prices.json` and update `checked`.**
- **`manifest.webmanifest` + `icons/`**: lets you "Add to Home Screen" as an app. Regenerate the icons with `python tools/make_icons.py`.

To run it locally:

```
python scrape.py                                          # fetches data into data/ and site/data/
python -m http.server 8765 --directory site               # then open http://localhost:8765
```

## Deployment

The site is hosted on GitHub Pages at https://leskos.github.io/brighton-parking/.

`.github/workflows/deploy.yml` runs `scrape.py` and deploys `site/` (including fresh data):
- on every push to `main`
- every Monday at 04:17 UTC
- manually, from the Actions tab (**Run workflow**)

`data/` and `site/data/` are gitignored, because they're rebuilt on every deploy.
