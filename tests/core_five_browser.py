"""End-to-end functional acceptance of the six OSMANX portfolio projects."""
from __future__ import annotations

import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
BASE="http://127.0.0.1:18769"
OUT=ROOT/"qa"/"core-five"

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    server=subprocess.Popen([sys.executable,"-m","http.server","18769","--bind","127.0.0.1"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(70):
            try:
                with socket.create_connection(("127.0.0.1",18769),timeout=1):break
            except OSError:time.sleep(.15)
        else:raise RuntimeError("Static server did not start")
        for suffix in ["/assets/labs/index.html","/assets/labs/breakthrough/index.html"]:
            try:urllib.request.urlopen(BASE+suffix,timeout=5)
            except urllib.error.HTTPError as e:assert e.code==404,(suffix,e.code)
            else:raise AssertionError("Unrelated lab still accessible: "+suffix)
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,args=["--disable-dev-shm-usage"])
            try:
                names=["OSMANX WORLD","Retail Intelligence","OSMANX App Factory","OSMANX OmniChat","SENQARD","OSGARD WORLD"]
                for width,height in [(1440,900),(390,844)]:
                    page=browser.new_page(viewport={"width":width,"height":height},accept_downloads=True)
                    errors=[]
                    page.on("pageerror",lambda err:errors.append(str(err)))
                    page.goto(BASE+"/",wait_until="domcontentloaded")
                    page.locator(".product-tile").first.wait_for(timeout=10000)
                    assert page.locator(".product-tile").count()==6
                    tiles=page.locator(".product-tile h3").all_inner_texts()
                    assert tiles==names,tiles
                    assert page.locator('a[href="/assets/labs/index.html"]').count()==0
                    assert page.locator('a[href*="app=cafe"]').count()==0
                    assert page.locator('a[href*="app=nebula"]').count()==0
                    assert page.locator('.tile-action').count()==6
                    assert page.locator('.product-tile').nth(3).locator('.tile-action').get_attribute('href')=='/assets/omnichat/index.html'
                    assert page.locator('.product-tile').nth(5).locator('.tile-action').get_attribute('href')=='https://osgard.world/'
                    assert page.locator('.tile-action').first.get_attribute("href")=="/#home"
                    page.locator(".product-tile").nth(3).locator("a").click()
                    page.wait_for_url("**/assets/omnichat/index.html",timeout=10000)
                    assert page.locator("h1").count()==1
                    page.goto(BASE+"/",wait_until="domcontentloaded")
                    page.locator(".product-tile").nth(2).locator("a").click()
                    page.wait_for_url("**/assets/sovereign/workspace.html?app=factory",timeout=10000)
                    assert page.locator(".ws-banner h1").inner_text()=="OSMANX App Factory"
                    page.goto(BASE+"/#projects",wait_until="domcontentloaded")
                    page.locator(".product-tile").first.wait_for()
                    assert page.locator(".product-tile").count()==6
                    widths=page.evaluate("({scroll:document.documentElement.scrollWidth,inner:innerWidth})")
                    assert widths["scroll"]<=widths["inner"]+2,widths
                    page.screenshot(path=str(OUT/f"six-projects-{width}.png"),full_page=True)
                    assert not errors,errors
                    page.close()

                for code,title in [("retail","Retail Intelligence"),("omni","OSMANX OmniChat"),("factory","OSMANX App Factory"),("senqard","SENQARD")]:
                    page=browser.new_page(viewport={"width":1440,"height":900},accept_downloads=True)
                    errors=[]
                    page.on("pageerror",lambda err:errors.append(str(err)))
                    page.goto(BASE+f"/assets/sovereign/workspace.html?app={code}",wait_until="domcontentloaded")
                    page.locator(".ws-banner h1").wait_for(timeout=10000)
                    assert page.locator(".ws-banner h1").inner_text()==title
                    if code=="retail":
                        page.get_by_role("button",name="Опрос").first.click()
                        page.locator("#retail-survey select").select_option("Нет размера")
                        page.locator("#retail-survey textarea").fill("Без персональных данных")
                        page.locator("#retail-survey button").click()
                        assert page.get_by_text("Без персональных данных").count()>=1
                    elif code=="omni":
                        page.locator("#omni-send textarea").fill("Демо ответ не отправляется внешнему клиенту")
                        page.locator("#omni-send button").first.click()
                        assert page.get_by_text("Демо ответ не отправляется внешнему клиенту").count()>=1
                    elif code=="factory":
                        page.get_by_role("button",name="Создать сайт").first.click()
                        page.locator("#factory-new input[name=name]").fill("Тестовый сайт")
                        page.locator("#factory-new button").click()
                        page.locator("#factory-preview").wait_for()
                        with page.expect_download(timeout=10000) as d:page.get_by_role("button",name="Скачать HTML").click()
                        assert d.value.suggested_filename.endswith(".html")
                    elif code=="senqard":
                        page.locator("#senqard-project input[name=name]").fill("Контрольный проект")
                        page.locator("#senqard-project button").click()
                        assert page.get_by_text("Контрольный проект").count()>=1
                    page.screenshot(path=str(OUT/f"workspace-{code}.png"),full_page=True)
                    assert not errors,(code,errors)
                    page.close()
                for removed in ["cafe","nebula"]:
                    page=browser.new_page()
                    page.goto(BASE+f"/assets/sovereign/workspace.html?app={removed}",wait_until="domcontentloaded")
                    page.wait_for_url("**/#projects",timeout=10000)
                    assert page.locator(".product-tile").count()==6
                    page.close()

                # OmniChat source-backed product page: health gate remains closed
                # until the real API reports the correct PostgreSQL readiness.
                for width,height in [(1440,900),(390,844)]:
                    page=browser.new_page(viewport={"width":width,"height":height})
                    errors=[]
                    page.on("pageerror",lambda err:errors.append(str(err)))
                    url="https://chat.osmanx.world/api/health/ready"
                    def unavailable(route):
                        route.fulfill(status=503,content_type="application/json",headers={"Access-Control-Allow-Origin":"*"},body='{"status":"error"}')
                    page.route(url,unavailable)
                    page.goto(BASE+"/assets/omnichat/index.html",wait_until="domcontentloaded")
                    page.locator("#check-connection").wait_for(timeout=10000)
                    assert page.locator("#open-live").is_hidden()
                    assert page.get_by_role("link",name="Скачать полный исходный код R36").count()==1
                    page.locator("#check-connection").click()
                    page.get_by_text("Публичный сервер не подтверждён. Демо доступно выше.").wait_for(timeout=8000)
                    assert page.locator("#open-live").is_hidden()
                    page.unroute(url,unavailable)
                    def ready(route):
                        route.fulfill(status=200,content_type="application/json",headers={"Access-Control-Allow-Origin":"*"},body='{"status":"ready","database":"ok"}')
                    page.route(url,ready)
                    page.locator("#check-connection").click()
                    page.locator("#open-live").wait_for(state="visible",timeout=8000)
                    assert page.locator("#open-live").get_attribute("href")=="https://chat.osmanx.world/"
                    dims=page.evaluate("({scroll:document.documentElement.scrollWidth,inner:innerWidth})")
                    assert dims["scroll"]<=dims["inner"]+2,dims
                    page.screenshot(path=str(OUT/f"omnichat-r36-{width}.png"),full_page=True)
                    assert not errors,errors
                    page.close()
            finally:browser.close()
        print("PASS: Six portfolio cards; four operational demos; OSGARD portal; excluded apps blocked; desktop/mobile Chromium QA")
    finally:
        server.terminate()
        try:server.wait(timeout=5)
        except subprocess.TimeoutExpired:server.kill()

if __name__=="__main__":
    main()
