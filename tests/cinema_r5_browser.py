"""OSMANX CINEMA R5: mobile/desktop browser acceptance, simulated private API.
Real database authorization is tested separately in Node/PostgreSQL.
"""
import json,shutil,socket,subprocess,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
PORT=18815
URL=f"http://127.0.0.1:{PORT}/assets/stories/manager.html"
LEAD="10000000-0000-4000-8000-000000000001"
OWNER="20000000-0000-4000-8000-000000000002"
MANAGER="30000000-0000-4000-8000-000000000003"
def respond(route,payload,status=200):
    route.fulfill(status=status,content_type='application/json',body=json.dumps(payload,ensure_ascii=False))

def install(page,state):
    page.route("**/api/industry/v1/auth/me",lambda r:respond(r,{"role":"owner","account":{"id":OWNER,"email":"owner@example.test"}}))
    page.route("**/api/industry/v1/cinema/leads?*",lambda r:respond(r,{"items":[state['lead']],"limit":100}))
    page.route("**/api/industry/v1/cinema/metrics",lambda r:respond(r,{
        "stages":[{"state":"new","leads":1,"won_value_minor":"0"}],
        "sources":[{"source":"cinema","leads":1}],
        "stories":[{"story_id":"07-coffee","leads":1}],
        "events":[],"campaigns":[{"campaign_code":"moscow_r5","leads":1,"won":0,"won_estimate_minor":"0"}],
        "followups":{"overdue":0,"due_today":0}}))
    page.route("**/api/industry/v1/cinema/followups?*",lambda r:respond(r,{"items":[]}))
    page.route("**/api/industry/v1/cinema/assignees",lambda r:respond(r,{"items":[
        {"id":OWNER,"email":"owner@example.test","role":"owner"},
        {"id":MANAGER,"email":"manager@example.test","role":"manager"}]}))
    page.route("**/api/industry/v1/cinema/performance?*",lambda r:respond(r,{
        "schema":"osmanx.cinema.performance.v1","windowDays":30,
        "campaigns":[{"campaign_code":"moscow_r5","leads":1,"agreed":0,"with_attempt":0,
                     "connected":0,"attempts":"0","avg_hours_to_connection":None}],
        "actions":[{"campaign_code":"moscow_r5","event_type":"film_started","actions":"5"}]}))
    page.route("**/api/industry/v1/cinema/privacy/search?*",lambda r:respond(r,{
        "items":[{"id":LEAD,"contact_email":"client@example.test","created_at":"2026-11-20T11:00:00Z","state":"new"}],
        "requiresIdentityVerification":True}))
    def mutation(r):
        path=r.request.url
        if path.endswith("/contacts"):
            body=json.loads(r.request.post_data)
            state['contacts'].append(body)
            state['lead']['contact_count']+=1
            state['lead']['version']+=1
            respond(r,{"recorded":True,"item":{"version":state['lead']['version'],"contact_count":state['lead']['contact_count']}})
        elif path.endswith("/export"):
            respond(r,{"schema":"osmanx.cinema.subject-export.v1",
                       "lead":{"id":LEAD,"contact_email":"client@example.test"},
                       "events":[],"truncated":False,"verifiedByOperator":False})
        elif r.request.method=="PATCH":
            body=json.loads(r.request.post_data)
            state['patches'].append(body)
            state['lead']['assigned_to']=body.get("assignedTo")
            state['lead']['version']+=1
            respond(r,{"item":state['lead']})
        elif path.endswith("/history"):
            respond(r,{"items":[]})
        else:respond(r,{"erased":True,"id":LEAD})
    page.route("**/api/industry/v1/cinema/leads/*",mutation)

def new_state():
    return {"lead":{
        "id":LEAD,"contact_name":"Тестовый гость","contact_email":"client@example.test",
        "organization":"Тестовая кофейня","story_id":"07-coffee",
        "observation":"Гости не возвращаются","goal":"Проверить гипотезы",
        "source":"cinema","campaign_code":"moscow_r5",
        "state":"new","deal_value_minor":None,"version":1,
        "next_action_at":None,"next_action_kind":None,"loss_reason_code":None,
        "assigned_to":None,"contact_count":0,"first_contact_at":None,"last_contact_at":None,
        "created_at":"2026-11-20T11:00:00Z","updated_at":"2026-11-20T11:00:00Z"
    },"patches":[],"contacts":[]}

def main():
    proc=subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1"],
        cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(80):
            try:
                with socket.create_connection(("127.0.0.1",PORT),timeout=1):break
            except OSError:time.sleep(.2)
        else:raise RuntimeError("HTTP server did not start")
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path=shutil.which("google-chrome") or shutil.which("chromium") or None,
                args=["--disable-dev-shm-usage"])
            try:
                for width,height in [(1440,900),(390,844)]:
                    state=new_state()
                    page=browser.new_page(viewport={"width":width,"height":height},accept_downloads=True,reduced_motion="reduce")
                    errors=[]
                    page.on("pageerror",lambda err:errors.append(str(err)))
                    install(page,state)
                    page.goto(URL,wait_until="domcontentloaded")
                    page.locator("#workspace").wait_for(state="visible",timeout=15000)
                    page.locator(".r5-staff select").wait_for(state="visible",timeout=15000)
                    assert page.locator(".r5-performance-card").count()==1
                    assert page.locator("#r5-subject").is_visible()
                    assert page.locator(".r5-performance-card").inner_text().find("запусков фильма")>=0
                    page.locator(".r5-staff select").select_option(MANAGER)
                    page.locator(".lead-tools button").first.click()
                    # Old select already shows the option before network save finishes.
                    # Wait for the disabled Save button to be replaced by the refreshed card.
                    page.wait_for_function("() => document.querySelector('.lead-tools button')?.disabled===false && document.querySelector('.r5-staff select')?.value==="+json.dumps(MANAGER),timeout=15000)
                    assert len(state["patches"])==1,state["patches"]
                    assert state["patches"][0]["assignedTo"]==MANAGER
                    assert state["patches"][0]["expectedVersion"]==1
                    page.locator(".r5-contact select").first.select_option("email")
                    page.locator(".r5-contact select").nth(1).select_option("connected")
                    page.locator(".r5-contact button").click()
                    for _ in range(50):
                        if len(state["contacts"])>=1:break
                        page.wait_for_timeout(100)
                    assert len(state["contacts"])==1,state["contacts"]
                    assert state["contacts"][0]["outcome"]=="connected"
                    assert state["contacts"][0]["expectedVersion"]==2
                    page.locator("#r5-subject-email").fill("client@example.test")
                    page.locator("#r5-subject-form button").click()
                    page.locator(".r5-subject-item").wait_for(timeout=12000)
                    assert page.locator(".r5-subject-item button").first.is_disabled()
                    page.locator("#r5-identity-verified").check()
                    assert page.locator(".r5-subject-item button").first.is_enabled()
                    with page.expect_download(timeout=12000) as download:
                        page.locator(".r5-subject-item button").first.click()
                    assert download.value.suggested_filename.endswith(".json")
                    assert not errors,errors
                    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 3")
                    page.close()

                    # Static R5 before the API rollout must not break an existing R4 login.
                    stale=browser.new_page(viewport={"width":width,"height":height})
                    install(stale,new_state())
                    stale.route("**/api/industry/v1/cinema/assignees",lambda r:respond(r,{"error":"missing"},404))
                    stale.route("**/api/industry/v1/cinema/performance?*",lambda r:respond(r,{"error":"missing"},404))
                    stale.goto(URL,wait_until="domcontentloaded")
                    stale.locator("#workspace").wait_for(state="visible",timeout=12000)
                    assert stale.locator(".lead").count()==1
                    assert stale.locator(".r5-staff").count()==0
                    assert stale.locator("#r5-report").inner_text().find("R5 ещё не подключён")>=0
                    stale.close()
            finally:browser.close()
    finally:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill()

if __name__=="__main__":
    main()
    print("CINEMA R5: mobile/desktop contact, assignment, owner privacy and R4 fallback passed")
