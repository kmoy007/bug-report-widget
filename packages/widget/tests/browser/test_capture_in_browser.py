"""The capture drawn by a real browser: the widget's own capture call, through capture-engine.js
and html-to-image, on a page scrolled mid-way.

The Node tests cannot see where things land in the picture; these can. They load the shipped
src/ files into a blank page in Chromium and WebKit (Playwright), call
BugReportWidget.captureScreenshotDetailed as the form does, and read pixels of the PNG.

    pip install -r tests/browser/requirements.txt
    python -m playwright install chromium webkit
    python -m pytest tests/browser
"""

import pathlib

import pytest
from playwright.sync_api import sync_playwright

SRC = pathlib.Path(__file__).resolve().parents[2] / "src"
SCRIPTS = ["html2canvas.min.js", "html-to-image.js", "capture-engine.js", "bug-report.js"]
VIEW = {"width": 1000, "height": 700}

# 4000px of in-flow blocks, a pale-green marker 1500px down the page, a fixed bar along the top
# and a fixed button in the bottom-right corner (like the daily report's "Run report again").
PAGE = """<!doctype html><html><head><style>
  body { margin: 8px; background: #fff; }
  .tall { height: 4000px; background: #ddd; position: relative; }
  #marker { position: absolute; top: 1500px; left: 200px; width: 300px; height: 80px; background: rgb(0, 200, 0); }
  #bar { position: fixed; top: 0; left: 0; right: 0; height: 30px; background: rgb(0, 0, 255); }
  #rerun { position: fixed; right: 16px; bottom: 16px; width: 140px; height: 40px; background: rgb(255, 0, 0); }
</style></head><body><div class="tall"><div id="marker"></div></div><div id="bar"></div><div id="rerun"></div></body></html>"""

# Capture as the form does, then read the pixel at the centre of each element's live box.
CAPTURE = """async (ids) => {
  const W = window.BugReportWidget;
  const cfg = W.mergeConfig({ captureTimeoutMs: 20000 });
  const r = await W.captureScreenshotDetailed({ document, window, html2canvas: window.html2canvas }, cfg);
  if (!r.dataUrl) return { reason: r.reason };
  const img = new Image(); img.src = r.dataUrl; await img.decode();
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
  const k = img.width / document.documentElement.clientWidth;
  const at = {};
  for (const id of ids) {
    const b = document.getElementById(id).getBoundingClientRect();
    at[id] = Array.from(ctx.getImageData(Math.round((b.left + b.width / 2) * k),
                                         Math.round((b.top + b.height / 2) * k), 1, 1).data).slice(0, 3);
  }
  return { at };
}"""

RED, BLUE, GREEN = [255, 0, 0], [0, 0, 255], [0, 200, 0]


@pytest.fixture(scope="module", params=["chromium", "webkit"])
def page(request):
    with sync_playwright() as p:
        browser = getattr(p, request.param).launch()
        pg = browser.new_page(viewport=VIEW)
        pg.set_content(PAGE)
        for name in SCRIPTS:
            pg.add_script_tag(content=(SRC / name).read_text())
        yield pg
        browser.close()


def capture(page, scroll_y, ids):
    page.evaluate(f"window.scrollTo(0, {scroll_y})")
    r = page.evaluate(CAPTURE, ids)
    assert "at" in r, f"no screenshot: {r.get('reason')}"
    return r["at"]


def close(got, want):
    return all(abs(a - b) <= 8 for a, b in zip(got, want))


@pytest.mark.parametrize("scroll_y", [0, 1200, 99999], ids=["top", "mid-page", "bottom"])
def test_fixed_elements_are_where_the_person_sees_them(page, scroll_y):
    # Cropping by a transform on the clone made <body> the containing block of every fixed
    # element, so they were laid out against the page, not the screen: scrolled mid-page the
    # bottom-right button was not in the picture at all (daily report, 2026-10-26).
    at = capture(page, scroll_y, ["rerun", "bar"])
    assert close(at["rerun"], RED), f"fixed bottom-right button: {at['rerun']}"
    assert close(at["bar"], BLUE), f"fixed top bar: {at['bar']}"


def test_scrolled_content_is_where_the_person_sees_it(page):
    # The crop moves the page up by the scroll; if the shift is lost (Chromium writes the clone's
    # inset-block: auto after an explicit top) the picture is the top of the page.
    at = capture(page, 1200, ["marker"])
    assert close(at["marker"], GREEN), f"marker 1500px down, scrolled to 1200: {at['marker']}"
