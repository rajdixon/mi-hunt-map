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

## Deer hunting hours and rules

Tap the hours chip under the top bar. It shows legal hunting hours and the 2026 deer rules for your GPS position, or for the map center (marked with a crosshair) when location is off. It uses `data/deer_rules_2026.json`, built from the [2026 deer digest](https://www.michigan.gov/dnr/-/media/Project/Websites/dnr/Documents/LED/digests/2026_deer_regs_summary.pdf):

- Hours: the Zone A table (pp. 36–37), plus 6, 12 or 18 minutes for zones B, C and D (p. 35), minus 1 hour in the four Central Time counties. County and DMU come from DNR boundary layers. Drummond Island (DMU 117) is Zone A; the rest of Chippewa County is Zone B.
- Seasons by date and peninsula (pp. 6–10), antler point restrictions by DMU (pp. 12–15), universal antlerless use limits (pp. 17–19), baiting (pp. 56–58).

**This file needs a yearly update** when the DNR publishes the next digest. The weekly data job does not change it.

## Pins

Stands, blinds, camp, parking and other spots. Pins are saved only in the phone's browser storage and never leave the device. Use Export GPX to back them up or move them to another phone.

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
