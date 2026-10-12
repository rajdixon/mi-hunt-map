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
