"""R6 mobile/desktop Chromium: real client paging, retry key, full subject export."""
import json,shutil,socket,subprocess,sys,time
from datetime import datetime,timedelta,timezone
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
PORT=18826
BASE=f"http://127.0.0.1:{PORT}"
OWNER="10000000-0000-4000-8000-000000000001"
def reply(route,data,status=200):
    route.fulfill(status=status,content_type="application/json",body=json.dumps(data,ensure_ascii=False))
def fixtures():
    now=datetime(2026,11,20,12,0,0,tzinfo=timezone.utc)
    leads=[]
    for n in range(62):
        leads.append(dict(id=f"20000000-0000-4000-8000-{n+1:012d}",
            contact_name=f"Директор {n+1}",contact_email=f"client{n+1}@example.test",
            organization=f"Тестовая точка {n+1}",story_id="07-coffee",observation="Гости редко возвращаются",
            goal="Измерить причины",source="cinema",campaign_code="moscow_r6",
            state="new",deal_value_minor=None,version=1,assigned_to=None,contact_count=0,
            first_contact_at=None,last_contact_at=None,
            next_action_at=(now-timedelta(hours=2)).isoformat() if n==0 else None,
            next_action_kind="email" if n==0 else None,loss_reason_code=None,
            created_at=(now-timedelta(minutes=n)).isoformat(),updated_at=now.isoformat()))
    return {"leads":leads,"contactRequests":[],"pageCalls":0,"exportCalls":0}
def mock(page,state):
    page.route("**/api/industry/v1/auth/me",lambda r:reply(r,{"role":"owner","account":{"id":OWNER,"email":"owner@example.test"}}))
    page.route("**/api/industry/v1/cinema/leads?*",lambda r:reply(r,{"items":state["leads"],"limit":100}))
    page.route("**/api/industry/v1/cinema/metrics",lambda r:reply(r,{
        "stages":[{"state":"new","leads":62,"won_value_minor":"0"}],
        "sources":[{"source":"cinema","leads":62}],"stories":[{"story_id":"07-coffee","leads":62}],
        "events":[],"campaigns":[{"campaign_code":"moscow_r6","leads":62,"won":0,"won_estimate_minor":"0"}],
        "followups":{"overdue":1,"due_today":0}}))
    page.route("**/api/industry/v1/cinema/followups?*",lambda r:reply(r,{"items":[]}))
    page.route("**/api/industry/v1/cinema/assignees",lambda r:reply(r,{"items":[{"id":OWNER,"email":"owner@example.test","role":"owner"}]}))
    page.route("**/api/industry/v1/cinema/performance?*",lambda r:reply(r,{
        "campaigns":[{"campaign_code":"moscow_r6","leads":62,"agreed":0,"with_attempt":0,"connected":0,
          "attempts":"0","avg_hours_to_connection":None}],"actions":[]}))
    page.route("**/api/industry/v1/cinema/queue/summary",lambda r:reply(r,{
        "schema":"osmanx.cinema.queue-summary.v1",
        "counts":{"active":62,"overdue":1,"unassigned":62,"uncontacted":0}}))
    def queue(route):
        state["pageCalls"]+=1
        q=parse_qs(urlsplit(route.request.url).query)
        view=q.get("view",["all"])[0]
        data=state["leads"]
        if view=="overdue":data=[item for item in data if item["next_action_at"]]
        if view=="unassigned":data=[item for item in data if not item["assigned_to"]]
        if view=="uncontacted":data=[]
        assigned=q.get("assignedTo",["all"])[0]
        if assigned=="mine":data=[item for item in data if item["assigned_to"]==OWNER]
        if assigned=="unassigned":data=[item for item in data if not item["assigned_to"]]
        stage=q.get("state",[None])[0]
        if stage:data=[item for item in data if item["state"]==stage]
        cursor=q.get("beforeId",[None])[0]
        start=next((n+1 for n,item in enumerate(data) if item["id"]==cursor),0) if cursor else 0
        chosen=data[start:start+50]
        more=start+len(chosen)<len(data)
        next_cursor={"beforeCreatedAt":chosen[-1]["created_at"],"beforeId":chosen[-1]["id"]} if more else None
        reply(route,{"schema":"osmanx.cinema.queue.v1","items":chosen,"total":len(data),
            "nextCursor":next_cursor,"hasMore":more,
            "itemsWithTriage":[{"id":item["id"],"priority":"urgent" if item["next_action_at"] else "attention",
               "signals":[{"code":"followup_overdue","description":"Просрочен контакт"}] if item["next_action_at"] else
                [{"code":"unassigned","description":"Не назначен ответственный"}]} for item in chosen]})
    page.route("**/api/industry/v1/cinema/queue?*",queue)
    page.route("**/api/industry/v1/cinema/privacy/search?*",lambda r:reply(r,{
        "items":[{"id":state["leads"][0]["id"],"contact_email":"client1@example.test",
             "created_at":state["leads"][0]["created_at"],"state":"new"}],
        "requiresIdentityVerification":True}))
    page.route("**/api/industry/v1/cinema/privacy/access-log",lambda r:reply(r,{
        "items":[{"action":"subject_export","actor_id":OWNER,"lead_id":state["leads"][0]["id"],
                  "result_count":1000,"created_at":"2026-11-20T12:00:00Z"}],"containsEmail":False}))
    def lead_path(route):
        url=route.request.url
        lead=state["leads"][0]
        if "/contacts" in url:
            state["contactRequests"].append({"payload":json.loads(route.request.post_data),
                "key":route.request.headers.get("idempotency-key")})
            lead["version"]+=1;lead["contact_count"]+=1
            reply(route,{"recorded":True,"duplicate":False,"item":{
                "id":lead["id"],"version":lead["version"],"contact_count":lead["contact_count"]}})
        elif "/export" in url:
            state["exportCalls"]+=1
            after=int(parse_qs(urlsplit(url).query).get("afterVersion",["0"])[0])
            if after==0:
                reply(route,{"schema":"osmanx.cinema.subject-export.v2","lead":{
                    "id":lead["id"],"contact_email":"client1@example.test"},
                    "events":[{"version":i,"event_type":"state_changed"} for i in range(1,1001)],
                    "truncated":True,"nextAfterVersion":1000})
            else:
                reply(route,{"schema":"osmanx.cinema.subject-export.v2","lead":{
                    "id":lead["id"],"contact_email":"client1@example.test"},
                    "events":[{"version":i,"event_type":"state_changed"} for i in range(1001,1018)],
                    "truncated":False,"nextAfterVersion":None})
        elif route.request.method=="PATCH":
            body=json.loads(route.request.post_data)
            lead["assigned_to"]=body.get("assignedTo")
            lead["version"]+=1
            reply(route,{"item":lead})
        else:reply(route,{"items":[]})
    page.route("**/api/industry/v1/cinema/leads/**",lead_path)
def main():
    proc=subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1"],
        cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(90):
            try:
                with socket.create_connection(("127.0.0.1",PORT),timeout=1):break
            except OSError:time.sleep(.15)
        else:raise RuntimeError("HTTP server unavailable")
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path=shutil.which("google-chrome") or shutil.which("chromium") or None,
                args=["--disable-dev-shm-usage"])
            try:
                for width,height in [(1440,900),(390,844)]:
                    state=fixtures()
                    page=browser.new_page(viewport={"width":width,"height":height},
                        accept_downloads=True,reduced_motion="reduce")
                    errors=[];page.on("pageerror",lambda e:errors.append(str(e)))
                    mock(page,state)
                    page.goto(BASE+"/assets/stories/manager.html",wait_until="domcontentloaded")
                    page.locator("#workspace").wait_for(state="visible",timeout=15000)
                    page.locator("#r6-workqueue").wait_for(state="visible",timeout=15000)
                    assert page.locator(".lead").count()==50
                    assert page.locator(".r6-triage").count()==50
                    assert page.locator("#r6-queue-status").inner_text().find("50 из 62")>=0
                    page.locator("#r6-more").click()
                    page.wait_for_function("document.querySelectorAll('.lead').length===62",timeout=15000)
                    assert page.locator("#r6-queue-status").inner_text().find("62 из 62")>=0
                    assert not page.locator("#r6-more").is_visible()
                    # Versioned, replay-safe client contact is sent with a nontrivial header.
                    page.locator(".r5-contact select").first.select_option("email")
                    page.locator(".r5-contact select").nth(1).select_option("no_reply")
                    with page.expect_response(lambda r: "/contacts" in r.url and r.status==200,timeout=10000):
                        page.locator(".r5-contact button").first.click()
                    assert len(state["contactRequests"])==1,state["contactRequests"]
                    assert len(state["contactRequests"][0]["key"])>=16
                    # Exact-email data rights and complete multi-page export.
                    page.locator("#r5-subject-email").fill("client1@example.test")
                    page.locator("#r5-subject-form button").click()
                    page.locator(".r5-subject-item").wait_for(state="visible",timeout=15000)
                    assert page.locator(".r5-subject-item button").first.is_disabled()
                    page.locator("#r5-identity-verified").check()
                    with page.expect_download(timeout=15000) as download:
                        page.locator(".r5-subject-item button").first.click()
                    assert state["exportCalls"]==2
                    file=Path(download.value.path())
                    exported=json.loads(file.read_text())
                    assert exported["complete"] is True
                    assert len(exported["events"])==1017
                    page.locator("#r6-audit-refresh").click()
                    page.locator(".r6-access-event").wait_for(timeout=12000)
                    assert page.locator("#r6-audit-items").inner_text().find("subject_export")>=0
                    assert not errors,errors
                    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+3")
                    page.close()
            finally:browser.close()
    finally:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill()
if __name__=="__main__":
    main()
    print("CINEMA R6: mobile + desktop full queue and 1017-event verified export PASS")
