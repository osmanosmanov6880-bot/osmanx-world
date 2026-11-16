#!/usr/bin/env python3
"""OSMANX Labs: true Chromium acceptance against an isolated local HTTP server."""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:18765"
QA = ROOT / "qa" / "labs"


def main() -> None:
    QA.mkdir(parents=True, exist_ok=True)
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", "18765", "--bind", "127.0.0.1"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(80):
            try:
                with socket.create_connection(("127.0.0.1", 18765), timeout=1):
                    break
            except OSError:
                time.sleep(0.15)
        else:
            raise RuntimeError("Local server did not start")

        routes = [
            "/assets/labs/index.html",
            "/assets/labs/breakthrough/index.html",
            "/assets/labs/breakthrough/styles.css",
            "/assets/labs/breakthrough/scene.js",
            "/assets/labs/breakthrough/app.js",
            "/assets/labs/internet-v-humanity/index.html",
            "/assets/labs/zion-9/index.html",
        ] + [f"/assets/labs/zion-9/queue/ZION-0{i}/index.html" for i in range(20,30)]
        for url in routes:
            with urllib.request.urlopen(BASE+url, timeout=5) as res:
                if res.status != 200:
                    raise AssertionError(f"Route failed: {url}: {res.status}")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
            try:
                for width, height, name in [(1440, 900, "desktop"), (390, 844, "mobile")]:
                    page = browser.new_page(viewport={"width":width, "height":height})
                    errors=[]
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.goto(BASE+"/assets/labs/index.html",wait_until="domcontentloaded")
                    page.locator(".card").first.wait_for(timeout=10000)
                    assert page.locator(".card").count() == 25
                    assert page.locator("#total").inner_text() == "25"
                    page.screenshot(path=str(QA/f"catalog-{name}.png"),full_page=True)
                    page.locator("#search").fill("breakthrough")
                    assert page.locator(".card").count() == 1
                    assert "breakthrough" in page.locator(".card h2").inner_text().lower()
                    page.locator("#search").fill("")
                    page.locator('[data-filter="ready"]').click()
                    assert page.locator(".card").count() >= 5
                    if width == 390:
                        dims=page.evaluate("({w:document.documentElement.scrollWidth,v:innerWidth})")
                        assert dims["w"] <= dims["v"]+2, dims
                    assert not errors, errors
                    page.close()

                page = browser.new_page(viewport={"width":1366,"height":768})
                errors=[]
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(BASE+"/assets/labs/breakthrough/index.html",wait_until="domcontentloaded")
                page.locator("#sceneCanvas").wait_for()
                page.locator('[data-action="reset-camera"]').click()
                page.screenshot(path=str(QA/"breakthrough-desktop.png"),full_page=True)
                assert not errors, errors
                page.goto(BASE+"/assets/labs/internet-v-humanity/index.html",wait_until="domcontentloaded")
                page.locator("#lite").click()
                page.locator("#reset").click()
                page.screenshot(path=str(QA/"internet-cinema-desktop.png"),full_page=True)
                assert not errors, errors
                page.goto(BASE+"/assets/labs/zion-9/index.html",wait_until="domcontentloaded")
                assert page.locator(".card").count()==10
                page.locator(".card").first.click()
                page.wait_for_url("**/ZION-020/index.html",timeout=10000)
                page.locator("#reset").click()
                page.screenshot(path=str(QA/"zion-020-desktop.png"),full_page=True)
                assert not errors, errors
                page.goto(BASE+"/",wait_until="domcontentloaded")
                page.locator('a[href="/assets/labs/index.html"]').first.wait_for(timeout=12000)
                page.locator('a[href="/assets/labs/index.html"]').first.click()
                page.wait_for_url("**/assets/labs/index.html",timeout=12000)
                assert page.locator(".card").count()==25
                assert not errors, errors
                page.close()
            finally:
                browser.close()
        print("OSMANX Labs browser QA: 25 repositories, search, filters, 12 prototypes, homepage navigation, 390px: PASS")
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill()


if __name__=="__main__":
    main()
