"""Guest Intelligence R3: real Chromium flow, export/import privacy and mobile acceptance."""
import json
import socket
import subprocess
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT = 18848
BASE = f"http://127.0.0.1:{PORT}"
PROOF = ROOT / "qa" / "guest-r3"

def server():
    p = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
                         cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            with socket.create_connection(("127.0.0.1",PORT),timeout=1):
                return p
        except OSError:
            time.sleep(.2)
    p.terminate()
    raise RuntimeError("No local static server")

def run():
    PROOF.mkdir(parents=True,exist_ok=True)
    process=server()
    try:
        with sync_playwright() as w:
            browser=w.chromium.launch(headless=True,args=["--disable-dev-shm-usage"])
            try:
                page=browser.new_page(viewport={"width":1440,"height":900},accept_downloads=True)
                errors=[]
                page.on("pageerror",lambda e:errors.append(str(e)))
                page.goto(BASE+"/assets/guest/offer.html",wait_until="domcontentloaded")
                page.get_by_role("link",name="Проверить готовность к пилоту").click()
                assert page.url.endswith("/assets/guest/pilot.html"),page.url
                page.locator("#weeks .week").first.wait_for()
                assert page.locator("#weeks .week").count()==2
                assert "0/6" in page.locator("#readinessStatus").inner_text()
                assert "участников на группу" in page.locator("#sampleSize").inner_text()
                assert page.locator("#weekTable tr").count()==2
                assert "ПРОМЕЖУТОЧНО" in page.locator("#outcome").inner_text()
                assert page.locator("#downloadJSON").is_enabled()

                # Readiness must reflect all six checks, without implying payment was made.
                for checkbox in page.locator("[data-ready]").all():
                    checkbox.check()
                assert "6/6" in page.locator("#readinessStatus").inner_text()
                page.locator("#finalized").check()
                assert "НЕДОСТАТОЧНО ОСНОВАНИЙ" in page.locator("#outcome").inner_text()
                assert "НЕТ ГАРАНТИРОВАННОЙ ПРИБЫЛИ" in page.locator("#report").input_value()

                # Price presets change costs only.
                page.locator("#monthlyPreset").click()
                assert page.locator("#fee").input_value()=="15000"
                page.locator("#pilotPreset").click()
                assert page.locator("#fee").input_value()=="25000"

                # Incomplete new weeks are flagged; no phantom data/export.
                page.locator("#addWeek").click()
                assert page.locator("#weeks .week").count()==3
                assert page.locator("#downloadJSON").is_disabled()
                page.locator("#weeks .week").last.locator("button.remove").click()
                assert page.locator("#downloadJSON").is_enabled()

                # Reject more returns than customers and recover cleanly.
                control_return=page.locator("#weeks .week").first.locator('[data-field="controlReturn"]')
                control_return.fill("1000")
                assert page.locator("#downloadCSV").is_disabled()
                control_return.fill("20")
                assert page.locator("#downloadCSV").is_enabled()

                with page.expect_download() as csv_event:
                    page.locator("#downloadCSV").click()
                csv_bytes=Path(csv_event.value.path()).read_bytes()
                assert csv_bytes.startswith(b"\xef\xbb\xbf")
                assert b"2026-11-02" in csv_bytes

                with page.expect_download() as json_event:
                    page.locator("#downloadJSON").click()
                json_bytes=Path(json_event.value.path()).read_bytes()
                snapshot=json.loads(json_bytes)
                assert snapshot["schema"]=="osmanx.guest.pilot.v1"
                assert snapshot["finalized"] is True
                assert len(snapshot["rows"])==2

                # Restoring valid snapshot works; malicious extra personal field fails without mutation.
                page.locator("#weeks .week").first.locator('[data-field="controlReturn"]').fill("30")
                page.locator("#upload").set_input_files({"name":"pilot.json","mimeType":"application/json","buffer":json_bytes})
                assert "Сценарий восстановлен" in page.locator("#operationStatus").inner_text()
                assert page.locator("#weeks .week").first.locator('[data-field="controlReturn"]').input_value()=="20"
                altered={**snapshot,"contact":"should be rejected"}
                page.locator("#upload").set_input_files({"name":"bad.json","mimeType":"application/json",
                                                       "buffer":json.dumps(altered).encode()})
                assert "Импорт отклонён" in page.locator("#operationStatus").inner_text()
                assert page.locator("#weeks .week").first.locator('[data-field="controlReturn"]').input_value()=="20"
                page.screenshot(path=str(PROOF/"desktop.png"),full_page=True)

                mobile=browser.new_page(viewport={"width":390,"height":844},accept_downloads=True)
                mobile.on("pageerror",lambda e:errors.append(str(e)))
                mobile.goto(BASE+"/assets/guest/pilot.html",wait_until="domcontentloaded")
                mobile.locator("#weeks .week").first.wait_for()
                dimensions=mobile.evaluate("({scroll:document.documentElement.scrollWidth,viewport:innerWidth})")
                assert dimensions["scroll"]<=dimensions["viewport"]+2,dimensions
                assert mobile.locator("#sampleSize").inner_text()
                mobile.screenshot(path=str(PROOF/"mobile.png"),full_page=True)
                assert not errors,errors
                mobile.close();page.close()
            finally:
                browser.close()
    finally:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill()
    print("PASS: R3 offer -> pilot, six checks, sample planning, weekly ledger, guarded interpretation, strict JSON, CSV, mobile")

if __name__=="__main__":
    run()
