"""Guest R4 visual/functional contract: real Chromium UI, mocked HTTP, explicit offline state.
Actual authentication, PostgreSQL RLS, CSRF and approval gates are verified separately
by services/industry-api/test/guest.test.mjs against PostgreSQL 16.
"""
import http.server
import json
import hashlib
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

                state={"authenticated":False,"requests":[],"pilots":[],"invites":[],"accepted":[],"calls":[],"actions":[],"observations":[],"history":[]}
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
                    if path=="/staff" and method=="GET":
                        members=[{"account_id":owner_id,"email":"owner@example.test","role":"owner"}]
                        return respond(200,{"members":members,"invitations":state["invites"]})
                    if path=="/staff/invitations" and method=="POST":
                        payload=req.post_data_json
                        assert payload["role"]=="manager"
                        assert payload["email"]=="manager@example.test"
                        token="f"*64
                        inv={"id":"bdfd36df-e2f1-4f41-9cdf-000000000001",
                             "email":payload["email"],"role":payload["role"],
                             "expires_at":"2099-01-01T00:00:00Z",
                             "accepted_at":None,"revoked_at":None}
                        state["invites"].append(inv)
                        return respond(201,{"invitation":inv,"token":token})
                    if path=="/staff/invitations/accept" and method=="POST":
                        payload=req.post_data_json
                        assert payload["token"]=="f"*64
                        assert len(payload["password"])>=12
                        assert not req.headers.get("cookie"),"Invitation acceptance must not leak session cookies"
                        if state["accepted"]:
                            return respond(404,{"error":"Приглашение недействительно"})
                        state["accepted"].append(payload["token"])
                        state["invites"][0]["accepted_at"]="2026-11-18T01:00:00Z"
                        return respond(200,{"accepted":True})
                    if path=="/guest/overview" and method=="GET":
                        return respond(200,{
                            "schema":"osmanx.guest.overview.v1",
                            "requests":{"new":len([r for r in state["requests"] if r["state"]=="new"]),
                                "qualified":len([r for r in state["requests"] if r["state"]=="qualified"]),
                                "declined":0,"converted":0},
                            "pilots":{"draft":len(state["pilots"]),"running":0,
                                      "in_review":0,"returned":0,"reviewed":0,"archived":0},
                            "quotas":{"requests":{"used":len(state["requests"]),"limit":250,"windowDays":365},
                                      "activePilots":{"used":len(state["pilots"]),"limit":50}},
                            "aggregate":{"periods":0,"control":0,"offered":0}
                        })
                    if path=="/guest/operations" and method=="GET":
                        items=[{"id":p["id"],"title":p["title"],"phase":p["phase"],
                                "version":p["version"],"activePeriods":len(state["observations"]),
                                "openActions":len(state["actions"]),"overdueActions":0,
                                "priority":"normal","alerts":[]}
                               for p in state["pilots"]]
                        return respond(200,{"schema":"osmanx.guest.operations.v1",
                            "returned":len(items),"truncated":False,
                            "totals":{"atRisk":0,"warning":0,"normal":len(items),"overdueActions":0},
                            "items":items,"disclaimer":"Без заявлений о прибыли"})
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
                        assert body["protocol"]["primaryMetric"]=="repeat_visit"
                        assert body["protocol"]["allocation"] in ("random","matched")
                        assert body["protocol"]["startDate"]<=body["protocol"]["endDate"]
                        item={"id":pilot_id,"title":body["title"],"phase":"draft",
                              "requestId":body.get("requestId"),"version":1,"targetPerGroup":294,
                              "plan":body["plan"],"protocol":body["protocol"],
                              "protocolRegisteredAt":"2026-11-18T10:00:00.000Z",
                              "prospectivelyRegistered":True,
                              "readiness":{k:False for k in ["repeatDefinition","sameWindow","independentGroups",
                                                            "marginVerified","contactConsent","ownerAgreed"]},
                              "submittedBy":None}
                        state["pilots"].append(item)
                        return respond(201,{"item":item})
                    if path==f"/guest/pilots/{pilot_id}" and method=="GET":
                        return respond(200,{"item":state["pilots"][0],"observations":state["observations"],"reviews":[]})
                    if path==f"/guest/pilots/{pilot_id}/diagnostics" and method=="GET":
                        return respond(200,{
                            "pilotId":pilot_id,"version":state["pilots"][0]["version"],
                            "evidenceDigest":"a"*64,
                            "diagnostic":{"schema":"osmanx.guest.diagnostic.v1",
                                "disposition":"NO_DATA","observedPeriods":len(state["observations"]),
                                "sample":{"control":0,"offer":0,"minimumPerGroup":294,"enough":False},
                                "rates":{"controlPct":None,"offerPct":None,"differencePp":None},
                                "findingCount":1,
                                "recommendations":[{"code":"COLLECT_OBSERVATIONS","severity":"high",
                                  "title":"Собрать обезличенные наблюдения",
                                  "why":"Нет проверяемых периодов",
                                  "nextStep":"Запишите агрегированные данные"}],
                                "disclaimer":"Не доказанная причина потери клиентов"}
                        })
                    if path==f"/guest/pilots/{pilot_id}/actions" and method=="GET":
                        return respond(200,{"pilotId":pilot_id,"items":state["actions"]})
                    if path==f"/guest/pilots/{pilot_id}/actions" and method=="POST":
                        body=req.post_data_json
                        assert body["code"]=="COLLECT_OBSERVATIONS"
                        assert body["assigneeId"]==owner_id
                        assert body["dueDate"]
                        item={"id":"d7609b01-422d-49c1-82ce-444444444444",
                              "code":body["code"],"status":"open","assigned_to":owner_id,
                              "created_by":owner_id,"dueDate":body["dueDate"],"version":1}
                        state["actions"].append(item)
                        state["history"].append({
                          "id":"bc63e96e-dc11-4607-a219-000000000001",
                          "action_id":item["id"],"event_type":"created",
                          "from_status":None,"to_status":"open",
                          "previousDueDate":None,"nextDueDate":item["dueDate"],
                          "actor_id":owner_id,"action_version":1,
                          "recorded_at":"2026-11-18T11:00:00Z"})
                        return respond(201,{"item":item})
                    action_id="d7609b01-422d-49c1-82ce-444444444444"
                    if path==f"/guest/pilots/{pilot_id}/actions/{action_id}/history" and method=="GET":
                        return respond(200,{"schema":"osmanx.guest.action.history.v1",
                            "pilotId":pilot_id,"actionId":action_id,"items":state["history"]})
                    if path==f"/guest/pilots/{pilot_id}/actions/{action_id}/assignment" and method=="PATCH":
                        body=req.post_data_json
                        item=state["actions"][0]
                        assert body["expectedVersion"]==item["version"]
                        old_due=item["dueDate"]
                        item["dueDate"]=body["dueDate"]
                        item["assigned_to"]=body["assigneeId"]
                        item["version"]+=1
                        state["history"].append({
                          "id":"bc63e96e-dc11-4607-a219-000000000002",
                          "action_id":item["id"],"event_type":"assignment",
                          "from_status":item["status"],"to_status":item["status"],
                          "previousDueDate":old_due,"nextDueDate":item["dueDate"],
                          "actor_id":owner_id,"action_version":item["version"],
                          "recorded_at":"2026-11-18T11:05:00Z"})
                        return respond(200,{"item":item})
                    if path.startswith(f"/guest/pilots/{pilot_id}/actions/") and method=="PATCH":
                        body=req.post_data_json
                        item=state["actions"][0]
                        assert body["expectedVersion"]==item["version"]
                        old_status=item["status"]
                        item["status"]=body["status"]
                        item["version"]+=1
                        state["history"].append({
                          "id":"bc63e96e-dc11-4607-a219-000000000003",
                          "action_id":item["id"],"event_type":"status",
                          "from_status":old_status,"to_status":item["status"],
                          "previousDueDate":item["dueDate"],"nextDueDate":item["dueDate"],
                          "actor_id":owner_id,"action_version":item["version"],
                          "recorded_at":"2026-11-18T11:10:00Z"})
                        return respond(200,{"item":item})
                    if path==f"/guest/pilots/{pilot_id}/observations/import/preview" and method=="POST":
                        body=req.post_data_json
                        assert body["csv"].startswith("date,control,controlReturn,offer,offerReturn")
                        return respond(200,{"schema":"osmanx.guest.csv.preview.v1",
                            "expectedVersion":state["pilots"][0]["version"],"sha256":"f"*64,
                            "remainingSlots":12,"summary":{"rowCount":1,"firstDate":"2026-11-10",
                              "lastDate":"2026-11-10",
                              "totals":{"control":500,"offer":500,"controlReturn":100,"offerReturn":150}}})
                    if path==f"/guest/pilots/{pilot_id}/observations/import" and method=="POST":
                        body=req.post_data_json
                        assert body["sha256"]=="f"*64 and req.headers.get("idempotency-key")
                        state["observations"].append({"id":"84416d00-ae43-4a8a-9725-cf2323232323",
                            "date":"2026-11-10","control":500,"controlReturn":100,
                            "offer":500,"offerReturn":150})
                        state["pilots"][0]["version"]+=1
                        return respond(201,{"importId":"228c4095-3122-4bde-9f15-222222222222",
                            "rowsImported":1,"version":state["pilots"][0]["version"],
                            "sha256":"f"*64})

                    if path==f"/guest/pilots/{pilot_id}/operations/export.json" and method=="GET":
                        compact=lambda obj:json.dumps(obj,separators=(",",":"),ensure_ascii=False).encode("utf-8")
                        sha=lambda obj:hashlib.sha256(compact(obj)).hexdigest()
                        evidence={"schema":"osmanx.guest.evidence.v2",
                                  "plan":{"fee":25000},"observations":state["observations"]}
                        payload={"schema":"osmanx.guest.operations.snapshot.v1",
                                 "pilot":{"id":pilot_id,"phase":state["pilots"][0]["phase"]},
                                 "evidence":evidence,"evidenceSha256":sha(evidence),
                                 "actionHistory":state["history"],"actions":state["actions"],
                                 "importLedger":[{"rows_imported":1}]}
                        return respond(200,{"format":"osmanx.guest.operations.export.v1",
                            "sha256":sha(payload),"snapshot":payload,
                            "disclaimer":"SHA is not a digital signature"})
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
                assert page.locator("#overviewPanel").is_visible()
                assert page.locator("#operationsPanel").is_visible()
                assert "Заявки" in page.locator("#overviewQuotas").inner_text()
                assert page.locator("#staffPanel").is_visible()
                page.locator("#inviteEmail").fill("manager@example.test")
                page.locator("#inviteRole").select_option("manager")
                page.locator("#inviteForm button[type=submit]").click()
                page.locator("#newInvite").wait_for(state="visible")
                token=page.locator("#inviteToken").input_value()
                assert len(token)==64
                assert token not in page.url
                joined=context.new_page()
                joined.goto(BASE+"/assets/guest/join.html",wait_until="networkidle")
                joined.locator("#token").fill(token)
                joined.locator("#password").fill("Some-Long-Password-2026")
                joined.locator("#repeat").fill("Some-Long-Password-2026")
                joined.locator("#joinForm button[type=submit]").click()
                joined.locator("#success").wait_for(state="visible")
                assert joined.locator("#token").input_value()==""
                assert token not in joined.url
                joined.screenshot(path=str(OUT/"join.png"),full_page=True)
                joined.close()
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
                assert "Зафиксированный протокол" in page.locator("#protocolStatus").inner_text()
                assert "Нет проверяемых периодов" in page.locator("#diagnosticFindings").inner_text()
                assert page.locator("#actionForm").is_visible()
                page.locator("#actionCode").select_option("COLLECT_OBSERVATIONS")
                page.locator("#actionAssignee").select_option(owner_id)
                page.locator("#actionForm button[type=submit]").click()
                page.wait_for_function("() => document.querySelector('#actionList').textContent.includes('Собрать обезличенные наблюдения')")
                page.get_by_role("button",name="Изменить ответственного").click()
                page.locator("#assignmentDue").fill("2026-11-25")
                page.locator("#actionAssignmentForm button[type=submit]").click()
                page.wait_for_function("() => document.querySelector('#actionAssignmentForm').hidden")
                page.get_by_role("button",name="История").click()
                page.wait_for_function("() => document.querySelector('#actionHistory').textContent.includes('assignment')")
                page.get_by_role("button",name="Взять в работу").click()
                page.wait_for_function("() => document.querySelector('#actionList').textContent.includes('in_progress')")
                # Mocked plan transitions to running to verify the R9 preview/commit UI.
                state["pilots"][0]["phase"]="running"
                page.locator("#refresh").click()
                page.wait_for_function("() => !document.querySelector('#bulkPreview').disabled")
                page.locator("#bulkCsv").fill(
                    "date,control,controlReturn,offer,offerReturn\n2026-11-10,500,100,500,150\n")
                page.locator("#bulkPreview").click()
                page.wait_for_function("() => document.querySelector('#bulkResult').textContent.includes('Проверено 1 периодов')")
                page.on("dialog",lambda dialog:dialog.accept())
                page.locator("#bulkCommit").click()
                page.wait_for_function("() => document.querySelector('#observationList').textContent.includes('500')")
                assert len(state["observations"])==1
                page.locator("#operationsRefresh").click()
                page.wait_for_function("() => document.querySelector('#operationsList').textContent.includes('Пилот по лояльности')")
                with page.expect_download() as download_info:
                    page.locator("#downloadOperations").click()
                download=download_info.value
                assert download.suggested_filename=="osmanx-guest-r11-operational-proof.json"
                page.wait_for_function("() => document.querySelector('#observationList').textContent.includes('500')")
                # Only same-origin requests; mutation requests must carry CSRF.
                for method,path,headers in state["calls"]:
                    if method in ("POST","PATCH","DELETE") and path not in ("/auth/login","/staff/invitations/accept"):
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
