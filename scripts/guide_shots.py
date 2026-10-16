"""Screenshots for the user guide (docs/guide), taken from the real app.

Starts the sync server locally with made-up demo users and data (nothing
real is used or touched), opens the app in headless Chromium at phone size
and saves each shot to docs/guide/img/<name>.jpg.

    pip install playwright && playwright install chromium
    python3 scripts/guide_shots.py            # all shots
    python3 scripts/guide_shots.py notes      # just some, by name

To document a new feature: add a function below with @shot("name"), set the
app up the way the guide should show it, and refer to img/name.jpg in
docs/guide/guide.html. Then run scripts/build_guide.py.

Shots from before this script (the other files in docs/guide/img) were taken
by hand; retake them here when their part of the app changes.
"""
import hashlib, json, os, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "docs" / "guide" / "img"
PORT = 8096
BASE = f"http://127.0.0.1:{PORT}/"
ME, DAVE, JEN = "mike@demo.test", "dave@demo.test", "jen@demo.test"
HERE = (-84.9555, 44.6755)          # a State Forest spot in Kalkaska County
LOGGING = (-84.6575, 44.8375)                   # recent cuts, a timber sale and planned cuts close together
PHONE = {"viewport": {"width": 330, "height": 714}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True}
DESKTOP = {"viewport": {"width": 1280, "height": 800}, "device_scale_factor": 1.5}
key = lambda e: hashlib.sha256(e.encode()).hexdigest()[:24]
now_ms = lambda: int(time.time() * 1000)


def api(path, body=None, user=ME, method=None):
    req = urllib.request.Request(BASE + "api/" + path, method=method or ("POST" if body is not None else "GET"),
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "x-dev-user": user})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def off(dx, dy):
    """A spot dx/dy metres east/north of HERE"""
    return [round(HERE[0] + dx / 79000, 6), round(HERE[1] + dy / 111000, 6)]


def seed(data_dir):
    for u, n in [(ME, "Mike"), (DAVE, "Dave"), (JEN, "Jen")]:
        api("me", {"name": n}, user=u)
    t = now_ms()
    log = [{"id": f"l{i}", "kind": k, "t": time.strftime("%Y-%m-%dT%H:%M", time.localtime(t / 1000 - d * 86400)), "text": x, "wind": w}
           for i, (k, d, x, w) in enumerate([("sighting", 1, "6-point and 2 does, came up from the swamp at 7:40", "NW 6 mph, 38°F"),
                                             ("sighting", 3, "Doe and fawn", "NW 8 mph, 44°F"), ("nodeer", 5, "", "S 6 mph, 52°F")])]
    pin = lambda id, name, type, dx, dy, **k: {"id": id, "name": name, "type": type, "lng": off(dx, dy)[0], "lat": off(dx, dy)[1], "created": t, **k}
    pins = [pin("p1", "Ridge stand", "stand", 160, 180, winds=["NW", "W"], log=log, notes="Walk in on the logging road"),
            pin("p2", "Creek blind", "blind", -260, -120, winds=["S", "SW"]),
            pin("p3", "Swamp cam", "cam", 260, 380),
            pin("p4", "Rub line", "rub", 40, 330),
            pin("p5", "Parking", "parking", -380, -380)]
    route = {"id": "s1", "kind": "line", "name": "Route in", "color": "#ff6a13", "created": t,
             "pts": [off(-380, -380), off(-250, -200), off(-60, -60), off(80, 90), off(160, 180)]}
    bed = {"id": "s2", "kind": "area", "name": "Bedding", "color": "#57c26b", "created": t,
           "pts": [off(320, 260), off(560, 300), off(600, 520), off(380, 560), off(280, 420), off(320, 260)]}
    api("sync", {"pins": pins, "shapes": [route, bed], "tracks": []})
    # Partners share a few things
    api("sync", {"pins": [{**pin("d1", "Oak flat", "stand", -420, 220, winds=["E"]), "shared": True}]}, user=DAVE)
    api("sync", {"pins": [{**pin("j1", "Jen's blind", "blind", 420, -260), "shared": True}]}, user=JEN)
    api("where", {"lng": off(-150, 420)[0], "lat": off(-150, 420)[1], "acc": 6}, user=DAVE)
    # The bell: a typical evening's notes (after the share notes above are written)
    time.sleep(1)
    inbox = Path(data_dir) / "inbox" / f"{key(ME)}.json"
    inbox.parent.mkdir(parents=True, exist_ok=True)
    note = lambda id, kind, mins, title, body, read=False: {"id": id, "t": t - mins * 60000, "kind": kind, "title": title, "body": body, "at": None, "read": read}
    inbox.write_text(json.dumps({"items": [
        note("n1", "wind", 12, "Good wind Saturday at Ridge stand", "Ridge stand: 7:41–11 AM, 4–7:31 PM"),
        note("n2", "front", 13, "Cold front Saturday: high 41°F", "12° colder than today. Deer tend to move more after a temperature drop."),
        note("n3", "partner", 95, 'Dave shared "Oak flat" with you', "Oak flat"),
        note("n4", "partner", 60 * 27, "Jen shared 2 things with you", "Jen's blind, Route in", True),
    ], "subs": [], "prefs": {}, "sent": {}}))


SHOTS = {}
def shot(name):
    def wrap(fn):
        SHOTS[name] = fn
        return fn
    return wrap


def open_app(browser, size=PHONE, locate=True):
    ctx = browser.new_context(**size, geolocation={"longitude": HERE[0], "latitude": HERE[1], "accuracy": 6},
                              permissions=["geolocation", "notifications"])   # DEV_USER is ME; a custom header would break tile requests
    ctx.add_init_script(f"""localStorage.setItem("mhl:center", '{json.dumps(list(HERE))}');
        localStorage.setItem("mhl:zoom", "15"); localStorage.setItem("mhl:where:share", "false");""")
    pg = ctx.new_page()
    pg.goto(BASE)
    pg.wait_for_timeout(2500)
    if locate:
        pg.click("#btn-locate")
        pg.wait_for_timeout(4000)
    return ctx, pg


def save(pg, name, **kw):
    pg.wait_for_timeout(600)
    pg.screenshot(path=str(IMG / f"{name}.jpg"), type="jpeg", quality=84, **kw)
    print("saved", name)


@shot("start")
def _(b):
    ctx, pg = open_app(b)
    save(pg, "start")
    ctx.close()


@shot("notes")
def _(b):
    ctx, pg = open_app(b)
    pg.click("#btn-notes")
    pg.wait_for_timeout(1500)
    save(pg, "notes")
    ctx.close()


@shot("share")
def _(b):
    ctx, pg = open_app(b)
    pg.click("#btn-pins")
    pg.wait_for_timeout(600)
    pg.locator("#pin-list .pin-row", has_text="Ridge stand").click()
    pg.wait_for_timeout(800)
    pg.check("#pin-share-cb")
    pg.check("#pin-share-who-some")
    pg.check(f"#pin-share-p-{key(DAVE)}")
    pg.check("#pin-share-shareWinds")
    pg.evaluate("document.getElementById('pin-share').scrollIntoView({ block: 'start' })")
    pg.evaluate("document.getElementById('sheet-pin-edit').scrollBy(0, -12)")
    save(pg, "share")
    ctx.close()


@shot("partners")
def _(b):
    ctx, pg = open_app(b)
    pg.click("#btn-pins")
    pg.wait_for_timeout(600)
    pg.check("#partners-card input[type=checkbox]")
    pg.wait_for_timeout(1200)
    pg.check("#where-who-some")
    pg.check(f"#where-p-{key(DAVE)}")
    pg.evaluate("document.querySelector('#sheet-pins').scrollTop = 0")
    save(pg, "partners")
    ctx.close()


@shot("cover")
def _(b):
    ctx, pg = open_app(b)
    pg.evaluate("map.jumpTo({ zoom: 14.2 })")
    pg.click("#btn-layers")
    pg.check("#ov-stands")
    pg.wait_for_timeout(500)
    pg.locator("#cover-pick li", has_text="Oak").locator(".cover-btn").click()
    pg.wait_for_timeout(5000)   # stands load from the DNR
    pg.evaluate("document.getElementById('ov-stands').closest('li').scrollIntoView({ block: 'start' })")
    save(pg, "cover")
    ctx.close()


@shot("logging")
def _(b):
    ctx, pg = open_app(b, locate=False)
    pg.evaluate(f"map.jumpTo({{ center: {json.dumps(LOGGING)}, zoom: 14 }})")
    pg.click("#btn-layers")
    for g in ("cuts", "sales", "plans"):
        pg.check(f"#ov-{g}")
    pg.evaluate("closeSheet('sheet-layers')")
    pg.wait_for_timeout(7000)   # the overlays load from the DNR
    save(pg, "logging")
    ctx.close()


@shot("view3d")
def _(b):
    ctx, pg = open_app(b, locate=False)
    pg.evaluate("setBasemap('sat'); map.jumpTo({ center: [-84.95, 45.045], zoom: 13.6, bearing: 0 })")
    pg.click("#btn-3d")
    pg.wait_for_timeout(1500)
    pg.evaluate("map.easeTo({ bearing: 160, pitch: 65, duration: 0 })")
    pg.wait_for_timeout(8000)   # elevation and imagery tiles
    save(pg, "view3d")
    ctx.close()


@shot("desktop")
def _(b):
    ctx, pg = open_app(b, DESKTOP)
    pg.click("#btn-pins")
    pg.mouse.move(900, 420)
    save(pg, "desktop")
    ctx.close()


def main(names):
    IMG.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as data_dir:
        env = {**os.environ, "PORT": str(PORT), "DATA_DIR": data_dir, "DEV_USER": ME, "OWNER_EMAIL": "",
               "HUNT_GROUP": ",".join([ME, DAVE, JEN])}
        server = subprocess.Popen(["node", str(ROOT / "server" / "server.mjs")], env=env)
        try:
            for _ in range(50):
                try: urllib.request.urlopen(BASE + "manifest.webmanifest"); break
                except Exception: time.sleep(0.1)
            seed(data_dir)
            with sync_playwright() as p:
                browser = p.chromium.launch()
                for n in names or SHOTS:
                    SHOTS[n](browser)
                browser.close()
        finally:
            server.terminate()
            server.wait()


if __name__ == "__main__":
    main(sys.argv[1:])
