"""Build docs/MI-Hunt-Land-Guide.pdf from docs/guide/guide.html.

    pip install playwright && playwright install chromium
    python3 scripts/build_guide.py

Fails (and writes nothing) if any page's content overflows its page, so a
new section never gets cut off silently. Screenshots: scripts/guide_shots.py.
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "guide" / "guide.html"
OUT = ROOT / "docs" / "MI-Hunt-Land-Guide.pdf"

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    pg.goto(SRC.as_uri(), wait_until="networkidle")
    pg.evaluate("document.fonts.ready")
    missing = pg.evaluate("[...document.images].filter(i => !i.naturalWidth).map(i => i.getAttribute('src'))")
    over = pg.evaluate("""[...document.querySelectorAll('.page')].map((p, i) => {
        const bottom = p.getBoundingClientRect().bottom - parseFloat(getComputedStyle(p).paddingBottom) + 1;
        const worst = Math.max(...[...p.querySelectorAll('*')].map(e => e.getBoundingClientRect().bottom));
        return worst > bottom ? `page ${i + 1} overflows by ${Math.round(worst - bottom)}px` : null; }).filter(Boolean)""")
    if missing or over:
        print("Not built:", *[f"missing image {m}" for m in missing], *over, sep="\n  ")
        sys.exit(1)
    pg.pdf(path=str(OUT), prefer_css_page_size=True, print_background=True)
    n = pg.evaluate("document.querySelectorAll('.page').length")
    b.close()
print(f"Built {OUT.relative_to(ROOT)}: {n} pages")
