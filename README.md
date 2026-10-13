# MI Hunt Land

A phone-friendly map of Michigan land open to hunting. It's a static site with no backend.

Layers come from the Michigan DNR's ArcGIS open data. They use the same filters as the DNR's own MiHunt map (web map `18147285694d4ec7b0af058562b677da`):

| Layer | Source | Filter |
|---|---|---|
| State Forest | Forest Inventory compartments | `ManagementType = 1`, minus the closed compartments MiHunt excludes |
| State Game & Wildlife Areas | DNRWILDLandsOPENDATA/2 | MiHunt's list of excluded floodings and refuges |
| State Parks & Rec Areas | DNRBoundariesParksHuntableLandsOPENDATA/2 | `HuntTrap NOT LIKE '%Closed%'` |
| Hunter Access Program | DNRWILDLandsOPENDATA/0 | `ActiveOrInactive = 'Active'` |
| Commercial Forest | CommercialForestParcels_View | `ParcelStatusText = 'Active'` |
| National Forest | USA Federal Lands 2025 | `Agency = 'Forest Service'`, clipped to Michigan |

## Background maps and overlays

Backgrounds: Esri Topo, Esri Satellite, LiDAR terrain (USGS 3DEP bare-earth hillshade, multidirectional), USGS Topo, USGS Imagery + Topo. All can be saved for offline use.

Overlays are queried live from DNR ArcGIS services for the area on screen, so they need a signal: forest stand cover type (zoom 13+), DNR roads (11+), DNR trails with hunter walking trails and temporary closures (10+), DNR parking (10+), PLSS sections (12+) and townships (8+). DMU boundaries come from `data/dmu.geojson` and work offline.

**Weather radar** (`radar.js`): NWS composite reflectivity from the [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/ogc/) tile mirror, refreshed every 5 minutes, with a loop of the last 50 minutes. Never cached.

**Possibly landlocked public land** (`data/landlocked.geojson`, built by `scripts/landlocked.py`): public pieces (State Forest, game areas, parks, National Forest) that no Act 51 public road touches, counting Commercial Forest and HAP land as walkable. Roads come from the Michigan Geographic Framework (All Roads v17a). Pieces under 5 acres are left out. Some can still be reached by water, a trail, a forest road or an easement. The weekly data job reruns it when the land boundaries change (needs `pip install shapely`).

## Deer hunting hours and rules

Tap the hours chip under the top bar. It shows legal hunting hours and the 2026 deer rules for your GPS position, or for the map center (marked with a crosshair) when location is off. It uses `data/deer_rules_2026.json`, built from the [2026 deer digest](https://www.michigan.gov/dnr/-/media/Project/Websites/dnr/Documents/LED/digests/2026_deer_regs_summary.pdf):

- Hours: the Zone A table (pp. 36–37), plus 6, 12 or 18 minutes for zones B, C and D (p. 35), minus 1 hour in the four Central Time counties. County and DMU come from DNR boundary layers. Drummond Island (DMU 117) is Zone A; the rest of Chippewa County is Zone B.
- Seasons by date and peninsula (pp. 6–10), antler point restrictions by DMU (pp. 12–15), universal antlerless use limits (pp. 17–19), baiting (pp. 56–58).

**This file needs a yearly update** when the DNR publishes the next digest. The weekly data job does not change it.

## Pins, wind and hunt log

Stands, blinds, camp, parking and other spots, saved only in the phone's browser storage. Each pin can have good winds (8 directions) and a hunt log (sightings, shots, harvests, notes with time and wind).

- Wind: hourly NWS forecast (api.weather.gov), cached per ~4 km for an hour and kept for offline viewing. Pins show "Good wind / Wrong wind" now, and the editor lists the next good-wind stretches trimmed to legal hunting hours.
- Share: sends name, type and location in the link's `#fragment` (never sent to the server). Notes, winds and logs are not shared. Opening the link offers to save the pin.
- Backup: "Full backup" saves pins, logs and tracks as JSON; "Pins as GPX" for other apps. Import takes either.

## Tracks

Records the GPS trail while the app is open and shows distance and direction back to the start. Requests a screen wake lock while recording, because phones pause GPS for web apps when the screen locks. Saved tracks can be shown, hidden, exported as GPX or deleted.

## Search

Coordinates (decimal or degrees-minutes), pins, public land names, counties, DMUs, township/range/section (DNR PLSS service, needs signal) and places (OpenStreetMap Nominatim, on submit only, needs signal).

## Run locally

    python3 -m http.server 8765
    # open http://127.0.0.1:8765

## Put it on your phone

Phones only allow GPS on HTTPS pages, so host the site somewhere with HTTPS. Any static host works; the simplest options are:

- **GitHub Pages:** push this folder to a repo, then go to Settings → Pages → Deploy from branch.
- **Netlify Drop:** drag this folder onto https://app.netlify.com/drop.

Then open the URL on your phone and choose "Add to Home Screen". The app itself and all land boundaries are stored for offline use. Basemap tiles are cached as you view them (up to 4,000 tiles). To have an area available with no signal, pan and zoom around it while you still have a connection.

## Refresh the data

    python3 scripts/fetch_data.py

After refreshing, change `VERSION` in `sw.js`. Otherwise phones keep the old cached copy.
The layer filters are saved in `scripts/layers.json`, copied from MiHunt's web map at build time. If the DNR changes MiHunt's filters, re-download the web map from `https://www.arcgis.com/sharing/rest/content/items/18147285694d4ec7b0af058562b677da/data?f=json` and update that file.

## Not shown

Safety zones (450 ft around occupied buildings), posted closures, refuges inside otherwise open areas, and local ordinances. Treat this map as a guide, not a legal boundary.

## Weather and moon

The hunting-hours sheet (tap the hours chip) shows, for the chosen day: the NWS forecast (high/low, sky, rain chance, temperature and wind at first light and in the last hour), a "cold snap" flag when the daytime high is 8°F or more below the day before, the moon phase with rise/set/overhead/underfoot times, solunar periods trimmed to legal hours, and the pressure trend (hourly sea-level pressure from [Open-Meteo](https://open-meteo.com), since NWS has none): readings with 3-hour arrows at first light and the last hour, and a daily label for rising, falling, steady or a front passing. A 7-day strip lets you pick a day. The moon is computed on the phone with [SunCalc](https://github.com/mourner/suncalc) (`vendor/suncalc.js`), so it works offline. Solunar periods are labelled as tradition: GPS-collar studies found little link between moon phase and deer movement, while temperature was the most consistent predictor.

## Scent cones, patterns and measuring

- **Scent cones** (`scent.js`): a wedge 300 m long and 50° wide downwind of each tree stand and ground blind, from the current forecast hour (a 70 m circle when calm). It turns red when it covers a trail cam, rub or scrape pin, and the pin list and editor say which. Toggle under Layers.
- **Patterns** (`stats.js`): hunt-log entries are grouped into sits (one morning or evening at a pin). For wind, time of day, temperature and pressure trend, each pin shows sits with deer out of sits logged. "No deer" entries record empty sits. New entries save the forecast wind, temperature and 3-hour pressure change as numbers; older ones are parsed from the wind text.
- **Measure** (`measure.js`, ruler in the top bar): tap points for distance and the area they enclose, or drop 450 ft safety-zone rings. Tapping a pin measures to it exactly.

## Private server and sync

`server/server.mjs` (Node 22, no dependencies) serves the app at hunt.tradersedges.net through the Cloudflare Tunnel on webserver02, behind Cloudflare Access. It verifies the Access token on every request and serves nothing until `CF_TEAM` and `CF_AUD` are set. Each user's pins (with hunt logs), tracks, lines and areas are kept in `~/mi-hunt-data/` as one JSON file. `sync.js` keeps the phone's copy and syncs when there's a signal; the newer edit of each pin or track wins and deletes carry over. Runs as a user service (`systemctl --user status mi-hunt`) with a daily `git pull`. Shared-pin links point at the public GitHub Pages copy so people without a login can open them.

## Lines, areas and go-to

- **Draw** (`draw.js`, pencil in the top bar): tap points for a line (property line, route in, drag line) or an area (food plot, bedding area, sanctuary), then give it a name, color and notes. Tap one on the map to edit, change its points or delete it. Listed under Pins, synced, and included in the full backup.
- **Go to** (`goto.js`, in a pin's editor or a partner's pin or location): a live arrow, distance, compass bearing and walking time (2 mph) from GPS and the phone's compass. The iPhone asks for compass permission the first time. With no compass, the arrow points map-up until you're walking. Works with no signal.

## Hunting partners

Set `HUNT_GROUP` in `~/.config/mi-hunt.env` on webserver02 to the partners' emails, yours included (comma-separated), add the same emails to the Cloudflare Access policy, and restart (`systemctl --user restart mi-hunt`). Each person keeps their own private data; pins, tracks, lines and areas marked "Share" are copied to `~/mi-hunt-data/group.json` on every sync and show read-only on the partners' maps (pins with a letter badge, tracks and shapes dashed), A shared pin shows its spot, name and type; its notes, good winds, hunt log and photos go along only if the owner ticks each one (the server strips the rest, and partners can only load photos that were shared). Under Pins, "Share my location" sends your position every 30 seconds while the app is open on screen (`/api/where`, kept in memory for 12 hours).

## Settings and the user guide

The gear in the top bar opens Settings (`settings.js`, saved per phone): text size (scales panels, buttons and labels with CSS `zoom`, not the map), distance units (yards/miles, feet/miles or metres/km, with acres or hectares), night mode (a red multiply overlay), keep the screen on (Wake Lock), battery saver (GPS polled once a minute and partner location every 2 minutes, except while recording or using Go to), names on the map, and the walking pace used by Go to. The user guide is `docs/MI-Hunt-Land-Guide.pdf`, linked from Settings.

## Photos and backups

- **Photos** (`photos.js`, server copy only): add photos to any pin from its editor. The phone resizes each one (2048 px full, 360 px thumbnail) and uploads to `/api/photos/<id>/<full|thumb>`; the time comes from the photo's EXIF DateTimeOriginal. The photo list is stored on the pin and syncs with it. Adding photos to a trail cam pin logs a "Cam check". The service worker keeps each photo once viewed, for offline. Files no pin refers to are removed after 7 days.
- **Backups**: `server/backup.sh` (user timer `mi-hunt-backup`, 05:30 UTC) snapshots `~/mi-hunt-data` to `~/mi-hunt-backups/<day>` with hard links, keeping 30 days; restore steps are in the script. The Mac copies the latest snapshot into iCloud Drive each night (`~/bin/mi-hunt-backup.sh`, launchd `com.rajdixon.mi-hunt-backup`) and emails the result.
