# MI Hunt Land: notes for Claude

## Keep the user guide current (required)

`docs/MI-Hunt-Land-Guide.pdf` is linked from Settings and is how users learn the app. Every change users can see (a new feature, a renamed button, a changed behavior, a removed option) must update the guide in the same commit:

1. Edit `docs/guide/guide.html`: add or change the section. Section numbers, the contents and page numbers fill in by themselves. Owner-only features (Usage stats) stay out of the guide.
2. New or changed screens: add a `@shot` function to `scripts/guide_shots.py` (it runs the app locally with demo users and data) and run it, e.g. `python3 scripts/guide_shots.py cover`. Reference `img/<name>.jpg` from the guide.
3. Run `python3 scripts/build_guide.py`. It refuses to build if a page overflows or an image is missing; split or trim the page and run it again.
4. Look at the changed pages (render them to images) before committing, and commit the HTML, images and PDF together.

Both scripts need `pip install playwright && playwright install chromium`, and Node for the local server.

## Shipping

Bump `VERSION` in `sw.js` and `APP_VERSION` in `settings.js`, commit, `git pull --rebase` (a weekly bot commits data), push, then `ssh webserver02 'cd ~/mi-hunt-map && git pull && systemctl --user restart mi-hunt'`.
