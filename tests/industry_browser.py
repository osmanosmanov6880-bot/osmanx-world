"""OSMANX INDUSTRY OS: desktop/mobile browser acceptance with seven sector workflows."""
from __future__ import annotations
import http.server
import socketserver
import subprocess
import sys
import time
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:18783"
OUT = ROOT / "qa" / "industry"
SECTORS = ["lab", "dental", "auto", "beauty", "fitness", "cafe", "cleaning"]

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server = subprocess.Popen([sys.executable, "-m", "http.server", "18783", "--bind", "127.0.0.1"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(65):
            import socket
            try:
                with socket.create_connection(("127.0.0.1", 18783), timeout=1):
                    break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError("Static server unavailable")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, executable_path=shutil.which("google-chrome") or shutil.which("chromium") or None, args=["--disable-dev-shm-usage"])
            try:
                for width, height in [(1440, 900), (390, 844)]:
                    page = browser.new_page(viewport={"width": width, "height": height}, accept_downloads=True)
                    errors = []
                    page.on("pageerror", lambda err: errors.append(str(err)))
                    page.goto(BASE + "/assets/industry/", wait_until="domcontentloaded")
                    page.get_by_role("heading", name="Выберите направление").wait_for(timeout=10000)
                    assert page.locator(".industry-card").count() == 7
                    assert "OSMANX INDUSTRY OS" in page.title()
                    for code in SECTORS:
                        page.locator(f'[data-industry="{code}"]').click()
                        assert page.locator(f'[data-industry="{code}"]').get_attribute("aria-pressed") == "true"
                        assert page.locator(".feature-list").count() >= 2
                        page.locator('[data-nav="client"]').click()
                        page.locator(".device-frame").wait_for()
                        page.locator('nav[aria-label="Навигация клиентского приложения"] [data-phone="bookings"]').click()
                        page.locator('[data-phone="profile"]').click()
                        page.locator('[data-nav="diagnostic"]').click()
                        page.locator('[data-audit="0"]').click()
                        assert "1 / 4" in page.locator(".finance-summary").inner_text()
                        page.locator('[data-nav="integrations"]').click()
                        assert page.locator(".integration").count() == 3
                        page.locator('[data-nav="overview"]').click()
                    dims = page.evaluate("({width:document.documentElement.scrollWidth,viewport:innerWidth})")
                    assert dims["width"] <= dims["viewport"] + 2, dims
                    assert not errors, errors
                    page.screenshot(path=str(OUT / f"overview-{width}.png"), full_page=True)
                    page.close()
                page = browser.new_page(viewport={"width": 1440, "height": 900}, accept_downloads=True)
                page.goto(BASE + "/assets/industry/", wait_until="domcontentloaded")
                page.locator('[data-industry="auto"]').click()
                page.locator('[data-nav="bookings"]').click()
                assert page.locator(".data-table tbody tr").count() == 2
                page.locator('#booking-form select[name="serviceId"]').select_option("auto-s2")
                page.locator('#booking-form button[type="submit"]').click()
                assert page.locator(".data-table tbody tr").count() == 3
                page.locator('[data-status]').first.select_option("done")
                assert "Выполнена" in page.locator(".data-table tbody tr").first.inner_text()
                with page.expect_download() as download:
                    page.locator('[data-action="export-bookings"]').click()
                assert download.value.suggested_filename.endswith(".csv")
                page.reload()
                page.locator('[data-industry="auto"]').click()
                page.locator('[data-nav="bookings"]').click()
                assert page.locator(".data-table tbody tr").count() == 3
                page.locator('[data-nav="customers"]').click()
                page.locator('#customer-form input[name="name"]').fill("Демо Клиент 03")
                page.locator('#customer-form button[type="submit"]').click()
                assert "Демо Клиент 03" in page.locator(".data-table").inner_text()
                page.locator('[data-nav="services"]').click()
                page.locator('#service-form input[name="name"]').fill("Тестовая услуга")
                page.locator('#service-form button[type="submit"]').click()
                assert "Тестовая услуга" in page.locator(".data-table").inner_text()
                page.locator('[data-nav="roi"]').click()
                page.locator('[data-finance="build"]').fill("300000")
                page.locator('[data-finance="build"]').dispatch_event("change")
                assert "300000" == page.locator('[data-finance="build"]').input_value()
                page.screenshot(path=str(OUT / "finance-1440.png"), full_page=True)
                assert page.locator(".finance-summary strong").inner_text().endswith("%")
                assert page.locator("#toast").count() <= 1
                page.close()
                console = browser.new_page(viewport={"width": 390, "height": 844})
                console.goto(BASE + "/assets/industry/console.html", wait_until="domcontentloaded")
                console.locator(".api-offline").wait_for(timeout=10000)
                assert console.get_by_text("Кабинет ожидает API").count() == 1
                assert console.locator('a[href="./"]').count() >= 1
                console.screenshot(path=str(OUT / "secure-console-offline-390.png"), full_page=True)
                console.close()
                portal = browser.new_page(viewport={"width": 1440, "height": 900})
                portal.goto(BASE + "/assets/sovereign/portal.html", wait_until="domcontentloaded")
                portal.locator(".product-tile").first.wait_for()
                assert portal.locator(".product-tile").count() == 6, "Portfolio should show six projects including OSGARD WORLD"
                assert portal.locator('.product-tile a[href="https://osgard.world/"]').count() == 1, "OSGARD portal link missing"
                assert portal.locator('a[href="/assets/industry/index.html"]').count() >= 1
                portal.close()
            finally:
                browser.close()
        print("PASS: 7 verticals, bookings, status, CRM, catalog, ROI, mobile, portal preservation, no JS errors")
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill()

if __name__ == "__main__":
    main()
