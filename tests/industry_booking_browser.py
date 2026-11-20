"""Browser acceptance for the public client booking demo: seven sectors, booking lifecycle and mobile layout."""
import http.server, socketserver, subprocess, sys, time, socket
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
PORT=18786
BASE="http://127.0.0.1:"+str(PORT)
SECTORS=["lab","dental","auto","beauty","fitness","cafe","cleaning"]
def main():
    out=ROOT/"qa"/"industry"
    out.mkdir(parents=True,exist_ok=True)
    server=subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                with socket.create_connection(("127.0.0.1",PORT),timeout=1): break
            except OSError: time.sleep(.2)
        else: raise RuntimeError("Static server unavailable")
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path=shutil.which("google-chrome") or shutil.which("chromium") or None,args=["--disable-dev-shm-usage"])
            try:
                page=browser.new_page(viewport={"width":1440,"height":1000},accept_downloads=True)
                errors=[]
                page.on("pageerror",lambda e:errors.append(str(e)))
                page.goto(BASE+"/assets/industry/",wait_until="domcontentloaded")
                page.locator('[data-industry="dental"]').click()
                page.locator("#portal-demo").wait_for()
                assert "industry=dental" in page.locator("#portal-demo").get_attribute("href")
                page.goto(BASE+"/assets/industry/booking.html?industry=dental",wait_until="domcontentloaded")
                assert "КЛИЕНТСКИЙ ПОРТАЛ" in page.locator(".intro .eyebrow").inner_text().upper()
                page.locator("#service-search").fill("гигиена")
                assert page.locator(".service-card").count()==1
                page.locator("#service-search").fill("")
                page.locator('[data-service="dental-s0"]').click()
                day=page.evaluate("() => {const d=new Date();d.setDate(d.getDate()+4);return d.toISOString().slice(0,10)}")
                page.evaluate("""() => localStorage.setItem('osmanx-industry-ops-r3',JSON.stringify({version:1,capacity:{dental:1},audit:[]}))""")
                page.locator("#booking-date").fill(day)
                page.locator('[data-time="09:00"]').click()
                page.locator('#booking-form input[name="name"]').fill("Демо Проверка")
                page.locator('#booking-form input[name="phone"]').fill("+7 900 000 00 01")
                page.locator('#booking-form input[name="consent"]').check()
                page.locator('#booking-form button[type="submit"]').click()
                page.get_by_text("Демо-запись создана на этом устройстве.").wait_for()
                assert page.locator(".visit-card").count()==1
                assert page.locator("#slots").get_by_text("На эту дату свободного времени нет.").count()==1
                assert page.locator("[data-time]").count()==0
                page.locator("[data-reschedule]").click()
                new_day=page.evaluate("d=>{const x=new Date(d+'T12:00:00');x.setDate(x.getDate()+1);return x.toISOString().slice(0,10)}",day)
                page.locator("#booking-date").fill(new_day)
                page.locator('[data-time="09:00"]').click()
                page.locator('#booking-form input[name="consent"]').check()
                page.locator('#booking-form button[type="submit"]').click()
                assert new_day in page.locator(".visit-card").inner_text()
                with page.expect_download() as calendar:
                    page.locator("[data-ics]").click()
                assert calendar.value.suggested_filename.endswith(".ics")
                page.on("dialog",lambda dialog:dialog.accept())
                page.locator("[data-cancel]").click()
                assert "Отменена" in page.locator(".visit-card").inner_text()
                saved=page.evaluate("""() => {const d=JSON.parse(localStorage.getItem('osmanx-industry-demo-r2'));return d.data.dental.appointments.find(x=>x.id.startsWith('booking-'))}""")
                assert saved["status"]=="cancelled" and saved["date"]==new_day
                # Company schedule rules: opening hours, date exceptions, slot interval and buffers.
                closed_day=page.evaluate("""() => {const d=new Date();d.setDate(d.getDate()+12);return d.toISOString().slice(0,10)}""")
                open_day=page.evaluate("""d => {const x=new Date(d+'T12:00:00');x.setDate(x.getDate()+1);return x.toISOString().slice(0,10)}""",closed_day)
                page.evaluate("""d => {localStorage.setItem('osmanx-industry-ops-r3',JSON.stringify({version:1,capacity:{dental:14},audit:[],schedule:{dental:{open:'10:00',close:'17:00',interval:15,bufferMinutes:15,closedDays:[],closedDates:[d]}}}))}""",closed_day)
                page.goto(BASE+"/assets/industry/booking.html?industry=dental",wait_until="domcontentloaded")
                page.locator('[data-service="dental-s0"]').click()
                page.locator("#booking-date").fill(closed_day)
                assert page.locator("#slots").get_by_text("На эту дату нет приёма.").count()==1
                page.locator("#booking-date").fill(open_day)
                assert page.locator('[data-time="10:00"]').count()==1
                assert page.locator('[data-time="09:00"]').count()==0
                assert page.locator('[data-time="17:00"]').count()==0
                page.locator('[data-time="10:00"]').click()
                page.locator('#booking-form input[name="name"]').fill("Демо График")
                page.locator('#booking-form input[name="phone"]').fill("+7 900 000 00 02")
                page.locator('#booking-form input[name="consent"]').check()
                page.locator('#booking-form button[type="submit"]').click()
                page.get_by_text("Демо-запись создана на этом устройстве.").wait_for()
                assert page.locator('[data-time="10:15"]').is_disabled()
                assert page.locator('[data-time="10:30"]').is_disabled()
                assert page.locator('[data-time="11:00"]').is_enabled()
                page.screenshot(path=str(out/"booking-desktop.png"),full_page=True)
                for sector in SECTORS:
                    page.goto(BASE+"/assets/industry/booking.html?industry="+sector,wait_until="domcontentloaded")
                    assert page.locator(".service-card").count()>=1
                    assert sector.upper() in page.locator(".sector-links a.active").get_attribute("href").upper()
                mobile=browser.new_page(viewport={"width":390,"height":844})
                mobile.on("pageerror",lambda e:errors.append(str(e)))
                mobile.goto(BASE+"/assets/industry/booking.html?industry=beauty",wait_until="domcontentloaded")
                dims=mobile.evaluate("({doc:document.documentElement.scrollWidth,view:innerWidth})")
                assert dims["doc"]<=dims["view"]+2,dims
                mobile.screenshot(path=str(out/"booking-mobile.png"),full_page=True)
                assert not errors,errors
                mobile.close()
                page.close()
            finally: browser.close()
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill()
    print("PASS: 7 sector booking portals, service search, capacity, create/reschedule/cancel, ICS calendar export, mobile layout")
if __name__=="__main__": main()
