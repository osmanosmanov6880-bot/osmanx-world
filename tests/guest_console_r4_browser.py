"""Guest R4 visual/functional contract: real Chromium UI, mocked HTTP, explicit offline state.
Actual authentication, PostgreSQL RLS, CSRF and approval gates are verified separately
by services/industry-api/test/guest.test.mjs against PostgreSQL 16.
"""
import http.server
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
PORT=18849
BASE=f"http://127.0.0.1:{PORT}"
OUT=ROOT/"qa"/"guest-r4"

def boot():
    proc=subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1"],
                          cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            with socket.create_connection(("127.0.0.1",PORT),timeout=1):
                return proc
        except OSError:
            time.sleep(.2)
    proc.terminate()
    raise RuntimeError("static test server failed")

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    proc=boot()
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,args=["--disable-dev-shm-usage"], executable_path=os.environ.get("OSMANX_CHROMIUM_BIN") or None)
            try:
                # Graceful failure when no protected API has been deployed.
                offline=browser.new_context(viewport={"width":1280,"height":850})
                missing=offline.new_page()
                missing.goto(BASE+"/assets/guest/console.html",wait_until="networkidle")
                assert missing.locator("#loginPanel").is_visible()
                assert missing.locator("#workPanel").is_hidden()
                assert "API" in missing.locator("#globalStatus").inner_text()
                missing.screenshot(path=str(OUT/"offline.png"),full_page=True)
                offline.close()

                state={"authenticated":False,"requests":[],"pilots":[],"calls":[]}
                pilot_id="4929420c-375c-4e64-8916-8d774e182c63"
                owner_id="0a61dbcb-e23e-474a-a9df-9b3f1338b165"
                response_profile={"account":{"id":owner_id,"email":"owner@example.test"},
                                  "tenant":{"id":"09c333c5-b150-4ed9-b07c-9980e8c0011a","name":"Учебная кофейня","slug":"coffee-team"},
                                  "role":"owner"}
                def intercept(route):
                    req=route.request
                    path=urlparse(req.url).path.removeprefix("/api/industry/v1")
                    method=req.method
                    state["calls"].append((method,path,dict(req.headers)))
                    def respond(status,payload):
                        route.fulfill(status=status,body=json.dumps(payload,ensure_ascii=False),
                                      headers={"content-type":"application/json; charset=utf-8",
                                               "cache-control":"no-store"})
                    if path=="/auth/me" and method=="GET":
                        return respond(200,response_profile) if state["authenticated"] else respond(401,{"error":"Требуется вход"})
                    if path=="/auth/login" and method=="POST":
                        body=req.post_data_json
                        assert body["tenantSlug"]=="coffee-team"
                        assert body["email"]=="owner@example.test"
                        state["authenticated"]=True
                        return respond(200,{"authenticated":True})
                    if path=="/guest/requests" and method=="GET":
                        return respond(200,{"items":state["requests"]})
                    if path=="/guest/requests" and method=="POST":
                        assert req.headers.get("idempotency-key"),"Guest client must provide stable request key"
                        body=req.post_data_json
                        item={"id":"75076af0-b645-43db-92f5-495c02cf9a13","title":body["title"],
                              "source":body["source"],"state":"new","created_at":"2026-11-18T00:00:00Z"}
                        state["requests"].append(item)
                        return respond(201,{"item":item})
                    if path.startswith("/guest/requests/") and method=="PATCH":
                        state["requests"][0]["state"]=req.post_data_json["state"]
                        return respond(200,{"item":{"id":state["requests"][0]["id"],"state":state["requests"][0]["state"]}})
                    if path=="/guest/pilots" and method=="GET":
                        return respond(200,{"items":state["pilots"]})
                    if path=="/guest/pilots" and method=="POST":
                        body=req.post_data_json
                        item={"id":pilot_id,"title":body["title"],"phase":"draft",
                              "requestId":body.get("requestId"),"version":1,"targetPerGroup":294,
                              "plan":body["plan"],
                              "readiness":{k:False for k in ["repeatDefinition","sameWindow","independentGroups",
                                                            "marginVerified","contactConsent","ownerAgreed"]},
                              "submittedBy":None}
                        state["pilots"].append(item)
                        return respond(201,{"item":item})
                    if path==f"/guest/pilots/{pilot_id}" and method=="GET":
                        return respond(200,{"item":state["pilots"][0],"observations":[],"reviews":[]})
                    if path==f"/guest/pilots/{pilot_id}/report" and method=="GET":
                        return respond(200,{"item":state["pilots"][0],"report":None,"analysis":None,
                                            "evidenceDigest":"a"*64})
                    return respond(404,{"error":"Mock route not configured"})

                context=browser.new_context(viewport={"width":1360,"height":980})
                context.add_cookies([{"name":"osmanx_industry_csrf","value":"csrf-test-2026","url":BASE,
                                     "httpOnly":False,"sameSite":"Strict"}])
                context.route("**/api/industry/v1/**",intercept)
                page=context.new_page()
                errors=[]
                page.on("pageerror",lambda e:errors.append(str(e)))
                page.goto(BASE+"/assets/guest/console.html",wait_until="networkidle")
                assert page.locator("#loginPanel").is_visible()
                page.locator("#tenant").fill("coffee-team")
                page.locator("#email").fill("owner@example.test")
                page.locator("#password").fill("long-testing-password-2026")
                page.locator("#loginForm button[type=submit]").click()
                page.locator("#workPanel").wait_for(state="visible")
                assert "Учебная кофейня" in page.locator("#tenantLabel").inner_text()
                page.locator("#requestTitle").fill("Повторные визиты после 30 дней")
                page.locator("#requestSource").select_option("field")
                page.locator("#requestForm button[type=submit]").click()
                page.wait_for_function("() => document.querySelector('#requestsList').textContent.includes('Повторные визиты после 30 дней')")
                # Approve a lead and convert it into a draft (mocked API only).
                page.get_by_role("button",name="Квалифицировать").click()
                page.wait_for_function("() => document.querySelector('#requestId').options.length===2")
                assert state["requests"][0]["state"]=="qualified"
                page.locator("#requestId").select_option(state["requests"][0]["id"])
                page.locator("#pilotTitle").fill("Пилот по лояльности")
                page.locator("#pilotForm button[type=submit]").click()
                page.locator("#detailPanel").wait_for(state="visible")
                assert "Пилот по лояльности" in page.locator("#pilotHeading").inner_text()
                assert "294" in page.locator("#sample").inner_text()
                page.wait_for_function("() => document.querySelector('#observationList').textContent.includes('Наблюдений пока нет')")
                # Only same-origin requests; mutation requests must carry CSRF.
                for method,path,headers in state["calls"]:
                    if method in ("POST","PATCH","DELETE") and path!="/auth/login":
                        assert headers.get("x-csrf-token")=="csrf-test-2026",(method,path)
                assert not errors,errors
                page.screenshot(path=str(OUT/"desktop.png"),full_page=True)
                page.close()
                mobile_context=browser.new_context(viewport={"width":390,"height":844})
                mobile_context.add_cookies([{"name":"osmanx_industry_csrf","value":"csrf-test-2026","url":BASE,
                                            "httpOnly":False,"sameSite":"Strict"}])
                mobile_context.route("**/api/industry/v1/**",intercept)
                mobile=mobile_context.new_page()
                mobile.on("pageerror",lambda e:errors.append(str(e)))
                mobile.goto(BASE+"/assets/guest/console.html",wait_until="networkidle")
                widths=mobile.evaluate("({documentWidth:document.documentElement.scrollWidth,viewport:innerWidth})")
                assert widths["documentWidth"]<=widths["viewport"]+2,widths
                assert mobile.locator("#workPanel").is_visible()
                mobile.screenshot(path=str(OUT/"mobile.png"),full_page=True)
                assert not errors,errors
                mobile.close()
                mobile_context.close()
                context.close()
            finally:
                browser.close()
    finally:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill()
    print("PASS: R4 console offline state, mocked staff login, lead intake and qualification, linked pilot, CSRF headers, mobile layout")

if __name__=="__main__":
    main()
