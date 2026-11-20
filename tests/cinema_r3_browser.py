"""OSMANX CINEMA R3 — desktop/mobile acceptance for safe online and offline funnels."""
from __future__ import annotations
import socket, subprocess, sys, time, shutil, json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
PORT=18792
BASE=f"http://127.0.0.1:{PORT}/assets/stories/cinema.html"
OUT=ROOT/"qa"/"cinema-r3"

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    server=subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(70):
            try:
                with socket.create_connection(("127.0.0.1",PORT),timeout=1):break
            except OSError:time.sleep(.2)
        else:raise RuntimeError("Static server not started")
        with sync_playwright() as p:
            path=shutil.which("google-chrome") or shutil.which("chromium") or None
            browser=p.chromium.launch(headless=True,executable_path=path,args=["--disable-dev-shm-usage"])
            try:
                for width,height in [(1440,900),(390,844)]:
                    # A. Explicitly offline: no server endpoint must NEVER pretend it stored a lead.
                    off=browser.new_page(viewport={"width":width,"height":height},reduced_motion="reduce")
                    errors=[]
                    off.on("pageerror",lambda e:errors.append(str(e)))
                    off.goto(BASE,wait_until="domcontentloaded")
                    off.locator("#r3-intake").wait_for(timeout=15000)
                    off.wait_for_function("document.querySelector('#r3-availability')?.textContent.includes('Онлайн-приём временно недоступен')",timeout=10000)
                    assert off.locator("#r3-lead-form").is_hidden()
                    assert off.locator("#r3-offline").is_visible()
                    assert off.locator("#r2-email").get_attribute("href").startswith("mailto:")
                    assert not errors,errors
                    off.close()

                    # B. Mock the real API contract to verify POST only on opt-in consent and user click.
                    page=browser.new_page(viewport={"width":width,"height":height},reduced_motion="reduce")
                    errors=[]
                    posts=[]
                    events=[]
                    page.on("pageerror",lambda e:errors.append(str(e)))
                    page.route("**/api/industry/v1/cinema/public/config",
                        lambda route:route.fulfill(status=200,content_type="application/json",
                          body=json.dumps({"schema":"osmanx.cinema.intake.v1","intakeEnabled":True,"aggregateEventsEnabled":True,"retentionDays":90})))
                    def fake_lead(route):
                        data=json.loads(route.request.post_data)
                        posts.append({"payload":data,"headers":route.request.headers})
                        route.fulfill(status=201,content_type="application/json",
                          body=json.dumps({"accepted":True,"reference":"00000000-0000-4000-8000-000000000001","duplicate":False}))
                    def fake_event(route):
                        events.append(json.loads(route.request.post_data))
                        route.fulfill(status=202,content_type="application/json",body='{"recorded":true,"uniqueVisitor":false}')
                    page.route("**/api/industry/v1/cinema/public/leads",fake_lead)
                    page.route("**/api/industry/v1/cinema/public/events",fake_event)
                    page.goto(BASE,wait_until="domcontentloaded")
                    page.locator("#r3-lead-form").wait_for(state="visible",timeout=15000)
                    assert page.locator("#episode-grid .episode").count()==12
                    assert page.locator("#r3-consent").is_checked() is False
                    assert len(posts)==0
                    page.select_option("#r2-story","01-restaurant")
                    page.locator("#r2-company").fill("Тестовая кофейня")
                    page.locator("#r2-observation").fill("Посетители уходят из очереди, не оформив заказ")
                    page.locator("#r2-goal").fill("Проверить причину ухода")
                    page.locator('#r2-form button[type="submit"]').click()
                    assert page.locator("#r2-result").is_visible()
                    assert len(posts)==0
                    page.locator("#r3-name").fill("Мария")
                    page.locator("#r3-email").fill("maria@example.test")
                    page.locator("#r3-consent").check()
                    page.locator("#r3-submit").click()
                    page.wait_for_function("document.querySelector('#r3-result')?.textContent.includes('Заявка принята сервером')",timeout=10000)
                    assert len(posts)==1
                    assert posts[0]["payload"]["consent"] is True
                    assert posts[0]["payload"]["storyId"]=="01-restaurant"
                    assert posts[0]["headers"].get("idempotency-key")
                    assert posts[0]["payload"]["contactEmail"]=="maria@example.test"
                    assert all("contactEmail" not in row for row in events),events
                    assert page.locator("#r3-submit").is_disabled()
                    page.screenshot(path=str(OUT/f"conversion-{width}.png"),full_page=True)
                    sizes=page.evaluate("({w:innerWidth,doc:document.documentElement.scrollWidth})")
                    assert sizes["doc"]<=sizes["w"]+3,sizes
                    assert not errors,errors
                    page.close()
            finally:browser.close()
    finally:
        server.terminate()
        try:server.wait(timeout=5)
        except subprocess.TimeoutExpired:server.kill()

if __name__=="__main__":
    main()
    print("CINEMA R3 — privacy fallback + real opt-in form E2E passed")
