"""OSMANX CINEMA R2: live Chromium interactions against a local static site."""
from __future__ import annotations

import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT = 18783
BASE = f"http://127.0.0.1:{PORT}"
TARGET = BASE + "/assets/stories/cinema.html"
OUT = ROOT / "qa" / "cinema-r2"


def open_server():
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=1):
                return server
        except OSError:
            time.sleep(.2)
    server.terminate()
    raise RuntimeError("Local HTTP server failed to start")


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    server = open_server()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
            try:
                for width, height in [(1440, 900), (390, 844)]:
                    page = browser.new_page(
                        viewport={"width":width,"height":height},
                        reduced_motion="reduce", accept_downloads=True
                    )
                    errors = []
                    requests = []
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    page.on("request", lambda req: requests.append(req.url))
                    response = page.goto(TARGET, wait_until="domcontentloaded")
                    assert response.status == 200
                    page.locator("#r2-diagnostic").wait_for(timeout=15000)
                    assert page.locator(".r2-chapter").count() == 4
                    assert page.locator("#episode-grid .episode").count() == 12
                    assert page.locator(".r2-story-actions").count() == 12
                    assert page.locator("#r2-story option").count() == 13
                    assert page.locator("#hero-film").get_attribute("preload") == "none"
                    assert page.locator("#r2-result").is_hidden()

                    # Explicit guided control; never starts without pressing a button.
                    guided = page.locator(".r2-guide")
                    assert guided.get_attribute("aria-pressed") == "false"
                    guided.click()
                    assert guided.get_attribute("aria-pressed") == "true"
                    guided.click()
                    assert guided.get_attribute("aria-pressed") == "false"

                    # Verify the real diagnostics form creates a measurable brief.
                    page.select_option("#r2-story", "02-fashion")
                    page.locator("#r2-company").fill("Тестовый магазин")
                    page.locator("#r2-volume").fill("350")
                    page.locator("#r2-observation").fill("Покупатели спрашивают другие размеры")
                    page.locator("#r2-goal").fill("Проверить неудовлетворённый спрос")
                    page.locator('#r2-form button[type="submit"]').click()
                    assert page.locator("#r2-result").is_visible()
                    body = page.locator("#r2-brief").inner_text()
                    assert "Отрасль: Магазин одежды" in body, body
                    assert "350" in body
                    assert "контрольный показатель" in body.lower()
                    assert page.locator("#r2-email").get_attribute("href").startswith("mailto:hello@osmanx.world")
                    assert page.locator("#r2-offer").get_attribute("href").startswith("/assets/sovereign/workspace.html")
                    page.locator('#r2-form button[type="reset"]').click()
                    assert page.locator("#r2-result").is_hidden()

                    # R1 navigation still intact. R2 filter and deep-links never duplicate stories.
                    page.locator('[data-filter="health"]').click()
                    assert page.locator("#episode-grid .episode:visible").count() == 2
                    page.locator('[data-filter="all"]').click()
                    assert page.locator("#episode-grid .episode:visible").count() == 12
                    assert not errors, errors
                    assert all(urlparse(url).hostname in {"127.0.0.1", "localhost"} for url in requests), requests
                    dimensions = page.evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth})")
                    assert dimensions["scroll"] <= dimensions["width"] + 3, dimensions
                    page.screenshot(path=str(OUT / f"cinema-r2-{width}.png"), full_page=True)
                    page.close()

                    # A shared story URL selects a case, category and scroll destination.
                    direct = browser.new_page(viewport={"width":width,"height":height}, reduced_motion="reduce")
                    direct_errors = []
                    direct.on("pageerror", lambda e: direct_errors.append(str(e)))
                    direct.goto(TARGET + "?story=07-coffee#episodes", wait_until="domcontentloaded")
                    direct.locator("#r2-diagnostic").wait_for(timeout=15000)
                    assert direct.locator("#r2-story").input_value() == "07-coffee"
                    assert direct.locator("#story-07-coffee").count() == 1
                    assert direct.locator("#story-07-coffee").is_visible()
                    assert direct.locator("#episode-grid .episode:visible").count() == 3
                    assert not direct_errors, direct_errors
                    direct.close()
            finally:
                browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=6)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    run()
    print("OSMANX CINEMA R2: desktop + mobile browser checks passed.")
