"""OSMANX Industry OS R3 operations suite browser acceptance."""
from __future__ import annotations
import http.server, subprocess, sys, time, socket
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
PORT=18784
BASE=f"http://127.0.0.1:{PORT}"
def main():
    server=subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                with socket.create_connection(("127.0.0.1",PORT),timeout=1): break
            except OSError: time.sleep(.2)
        else: raise RuntimeError("Static server unavailable")
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,args=["--disable-dev-shm-usage"])
            try:
                page=browser.new_page(viewport={"width":1440,"height":960},accept_downloads=True)
                errors=[]
                page.on("pageerror",lambda err:errors.append(str(err)))
                page.goto(BASE+"/assets/industry/",wait_until="domcontentloaded")
                page.locator('[data-industry="dental"]').click()
                page.locator("#ops-open").wait_for()
                page.locator("#ops-open").click()
                page.get_by_role("dialog").wait_for()
                page.locator('[data-ops-tab="capacity"]').click()
                page.locator("[data-capacity]").fill("1")
                page.locator("[data-capacity]").dispatch_event("change")
                page.locator('[data-ops="close"]').click()
                page.locator('[data-nav="bookings"]').click()
                before=page.locator(".data-table tbody tr").count()
                first=page.evaluate("""() => {
                  const db=JSON.parse(localStorage.getItem('osmanx-industry-demo-r2'));
                  const s=db.data.dental,a=s.appointments.find(x=>x.status!=='cancelled');
                  return {customer:s.customers[0].id,service:s.services[0].id,date:a.date,time:a.time}
                }""")
                page.locator('#booking-form select[name="customerId"]').select_option(first["customer"])
                page.locator('#booking-form select[name="serviceId"]').select_option(first["service"])
                page.locator('#booking-form input[name="date"]').fill(first["date"])
                page.locator('#booking-form input[name="time"]').fill(first["time"])
                page.locator('#booking-form button[type="submit"]').click()
                assert page.locator(".data-table tbody tr").count()==before
                assert "занято" in page.locator("#ops-toast").inner_text().lower()
                page.locator('#booking-form input[name="time"]').fill("19:40")
                page.locator('#booking-form button[type="submit"]').click()
                assert page.locator(".data-table tbody tr").count()==before
                page.locator('[data-nav="customers"]').click()
                page.locator('#customer-form input[name="name"]').fill("Ops QA Client")
                page.locator('#customer-form button[type="submit"]').click()
                assert "Ops QA Client" in page.locator(".data-table").inner_text()
                page.locator("#ops-open").click()
                page.locator('[data-ops-tab="privacy"]').click()
                page.locator("[data-consent]").first.select_option("yes")
                assert page.evaluate("JSON.parse(localStorage.getItem('osmanx-industry-consent-r1')).records.dental")
                page.locator('[data-ops-tab="audit"]').click()
                page.locator(".ops-content").get_by_text("Клиент добавлен").wait_for(timeout=3000)
                assert "Клиент добавлен" in page.locator(".ops-content").inner_text()
                page.locator('[data-ops-tab="reports"]').click()
                with page.expect_download() as report:
                    page.locator('[data-ops="report-export"]').click()
                assert report.value.suggested_filename.endswith(".csv")
                page.locator('[data-ops-tab="backup"]').click()
                with page.expect_download() as backup:
                    page.locator('[data-ops="backup-export"]').click()
                assert backup.value.suggested_filename.endswith(".json")
                page.screenshot(path=str(ROOT/"qa/industry/operations-desktop.png"),full_page=True)
                page.close()
                mobile=browser.new_page(viewport={"width":390,"height":844})
                mobile.goto(BASE+"/assets/industry/",wait_until="domcontentloaded")
                mobile.locator("#ops-open").click()
                mobile.get_by_role("dialog").wait_for()
                dims=mobile.evaluate("({doc:document.documentElement.scrollWidth,view:innerWidth})")
                assert dims["doc"]<=dims["view"]+2,dims
                mobile.screenshot(path=str(ROOT/"qa/industry/operations-mobile.png"),full_page=True)
                mobile.close()
                assert not errors,errors
            finally: browser.close()
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill()
    print("PASS: overbooking guard, daily capacity, consent ledger, audit trail, JSON backup, CSV report, mobile layout")
if __name__=="__main__": main()
