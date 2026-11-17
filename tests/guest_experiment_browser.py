"""OSMANX Guest Intelligence R2: real Chromium functional, privacy and responsive QA."""
import json
import socket
import subprocess
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
PORT = 18847
BASE = f"http://{HOST}:{PORT}"
SCREENSHOTS = ROOT / "qa" / "guest"

def boot():
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", HOST],
                              cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            with socket.create_connection((HOST, PORT), timeout=1):
                return server
        except OSError:
            time.sleep(0.25)
    server.terminate()
    raise RuntimeError("Static test server did not start")

def main():
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    server = boot()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
            try:
                page = browser.new_page(viewport={"width": 1440, "height": 960}, accept_downloads=True)
                errors = []
                page.on("pageerror", lambda exception: errors.append(str(exception)))
                # Public offer must lead to the new laboratory.
                page.goto(BASE + "/assets/guest/offer.html", wait_until="networkidle")
                page.get_by_role("link", name="Перейти в лабораторию").click()
                assert page.url.endswith("/assets/guest/experiment.html"), page.url
                assert "10 п.п." in page.locator("#numbers").inner_text()
                assert "−" in page.locator("#net").inner_text() or "-" in page.locator("#net").inner_text()
                assert page.locator("#downloadCsv").is_enabled()
                assert page.locator("#downloadJson").is_disabled()
                # Reject impossible return counts and keep exports disabled.
                page.locator("#offerReturn").fill("101")
                assert "превышать размер группы" in page.locator("#errors").inner_text()
                assert page.locator("#downloadCsv").is_disabled()
                page.locator("#offerReturn").fill("30")
                page.locator("#startDate").fill("2026-11-18")
                page.locator("#endDate").fill("2026-12-17")
                page.locator("#allocation").select_option("random")
                assert "Протокол заполнен" in page.locator("#briefNotice").inner_text()
                assert page.locator("#downloadJson").is_enabled()
                assert "2026-11-18" in page.locator("#briefText").input_value()
                # Profit cannot be claimed as guaranteed.
                assert "НЕ ЯВЛЯЕТСЯ ДОКАЗАТЕЛЬСТВОМ" in page.locator("#briefText").input_value()
                with page.expect_download() as csv_result:
                    page.locator("#downloadCsv").click()
                csv_download = csv_result.value
                assert csv_download.suggested_filename.endswith(".csv")
                contents = Path(csv_download.path()).read_bytes()
                assert contents.startswith(b"\xef\xbb\xbf") and b"controlReturn" in contents
                with page.expect_download() as json_result:
                    page.locator("#downloadJson").click()
                json_download = json_result.value
                payload = Path(json_download.path()).read_bytes()
                saved = json.loads(payload)
                assert saved["schema"] == "osmanx.guest.experiment.v1"
                assert saved["protocol"]["allocation"] == "random"
                # Restore a fully validated scenario. This file never leaves the browser.
                page.locator("#offerReturn").fill("40")
                page.locator("#importJson").set_input_files(
                    {"name": "pilot.json", "mimeType": "application/json", "buffer": payload})
                page.get_by_text("Сценарий импортирован и заново проверен.").wait_for()
                assert page.locator("#offerReturn").input_value() == "30"
                # A JSON file containing customer details cannot be imported.
                poisoned = {**saved, "customerName": "do-not-store"}
                page.locator("#importJson").set_input_files(
                    {"name": "personal.json", "mimeType": "application/json",
                     "buffer": json.dumps(poisoned).encode("utf-8")})
                assert "Импорт отклонён" in page.locator("#status").inner_text()
                # Price presets must adjust the model rather than starting a charge.
                page.locator("#presetPilot").click()
                assert page.locator("#fee").input_value() == "25000"
                assert "не счёт на оплату" in page.locator("#status").inner_text()
                page.locator("#presetMonthly").click()
                assert page.locator("#fee").input_value() == "15000"
                page.screenshot(path=str(SCREENSHOTS / "desktop.png"), full_page=True)
                mobile = browser.new_page(viewport={"width": 390, "height": 844}, accept_downloads=True)
                mobile.on("pageerror", lambda exception: errors.append(str(exception)))
                mobile.goto(BASE + "/assets/guest/experiment.html", wait_until="networkidle")
                widths = mobile.evaluate("({documentWidth:document.documentElement.scrollWidth, screenWidth:innerWidth})")
                assert widths["documentWidth"] <= widths["screenWidth"] + 2, widths
                assert mobile.locator("#numbers").inner_text()
                mobile.screenshot(path=str(SCREENSHOTS / "mobile.png"), full_page=True)
                assert errors == [], errors
                mobile.close()
                page.close()
            finally:
                browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    print("PASS: public offer -> lab, invalid inputs, financial outcomes, protocol, CSV+JSON downloads, privacy rejection, mobile")

if __name__ == "__main__":
    main()
