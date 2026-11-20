"""CINEMA R9 browser acceptance: server CSV, response evidence, 409 recovery, old R8 fallback."""
import json,shutil,socket,subprocess,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
from cinema_r6_browser import fixtures,mock,reply,ROOT,OWNER

PORT=18829
URL=f"http://127.0.0.1:{PORT}/assets/stories/manager.html"

def configure(page,state,role="owner",r9=True):
    mock(page,state)
    page.route("**/api/industry/v1/auth/me",lambda r:reply(r,{
        "role":role,"account":{"id":OWNER,"email":role+"@example.test"}}))
    page.route("**/api/industry/v1/cinema/public/runtime",lambda r:reply(r,{
        "apiRelease":"r8","onlineIntakeEnabled":False,"aggregateActionsEnabled":False,
        "capabilities":{"ownerCsvApproval":True}}))
    page.route("**/api/industry/v1/cinema/public/r9-runtime",lambda r:reply(r,{
        "apiRelease":"r9","onlineIntakeEnabled":False,"aggregateActionsEnabled":False,
        "capabilities":{"serverCsvSnapshot":True,"contactResponseReview":True}
    }) if r9 else reply(r,{"error":"R9 not installed"},404))
    page.route("**/api/industry/v1/cinema/team/workload",lambda r:reply(r,{
        "schema":"osmanx.cinema.team-workload.v1",
        "items":[{"id":OWNER,"email":"owner@example.test","role":"owner",
          "active":0,"overdue":0,"awaiting_first_attempt":0}]}))
    page.route("**/api/industry/v1/cinema/ops/response-review?*",lambda r:reply(r,{
        "schema":"osmanx.cinema.response-review.v1","windowDays":30,
        "asOf":"2026-11-20T12:00:00Z",
        "counts":{"total":62,"with_attempt":14,"manager_marked_connected":9,
            "unassigned_active":50,"overdue_active":1,"without_attempt_24h":4,
            "eligible_1h":45,"responded_within_1h":12,
            "recorded_attempts":30,"avg_minutes_to_first_attempt":"40.2"},
        "percentages":{"everAttempted":22.6,"respondedWithin1h":26.7}}))
    def export(r):
        assert r.request.method=="POST"
        state["csvRequests"].append(json.loads(r.request.post_data))
        r.fulfill(status=200,content_type="text/csv; charset=utf-8",
            headers={"Content-Disposition":'attachment; filename="osmanx-cinema-snapshot.csv"',
                     "Cache-Control":"private, no-store, max-age=0"},
            body='\ufeff"ID";"Email"\r\n"test";"latest@example.test"\r\n')
    page.route("**/api/industry/v1/cinema/exports/csv",export)
    def conflict(route):
        assert route.request.method=="POST"
        state["claimAttempts"]+=1
        reply(route,{"error":"Карточка обновлена другим менеджером"},409)
    page.route("**/api/industry/v1/cinema/leads/*/claim",conflict)

def main():
    proc=subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1"],
        cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(90):
            try:
                with socket.create_connection(("127.0.0.1",PORT),timeout=1):break
            except OSError:time.sleep(.15)
        else:raise RuntimeError("R9 fixture http server unavailable")
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,
                executable_path=shutil.which("google-chrome") or shutil.which("chromium") or None,
                args=["--disable-dev-shm-usage"])
            try:
                for width,height in [(1440,900),(390,844)]:
                    state=fixtures();state["csvRequests"]=[];state["claimAttempts"]=0
                    page=browser.new_page(viewport={"width":width,"height":height},
                        accept_downloads=True,reduced_motion="reduce")
                    errors=[];page.on("pageerror",lambda error:errors.append(str(error)))
                    configure(page,state)
                    page.goto(URL,wait_until="domcontentloaded")
                    page.locator("#workspace").wait_for(state="visible",timeout=15000)
                    page.locator("#r9-response").wait_for(state="visible",timeout=15000)
                    assert page.locator(".r9-response-card").count()==6
                    assert "22.6%" in page.locator("#r9-response-cards").inner_text()
                    assert page.locator("#csv").is_enabled()
                    assert "Подтверждён R9" in page.locator("#r8-runtime-status").inner_text()
                    page.on("dialog",lambda d:d.accept())
                    with page.expect_download(timeout=15000) as item:
                        page.locator("#csv").click()
                    assert item.value.suggested_filename=="osmanx-cinema-snapshot.csv"
                    csv=Path(item.value.path()).read_text(encoding="utf-8-sig")
                    assert 'latest@example.test' in csv
                    assert len(state["csvRequests"])==1
                    assert state["csvRequests"][0]["confirm"]=="GENERATE_CSV"
                    assert len(state["csvRequests"][0]["leadIds"])==50
                    # Conflict must be visible; the interface must not auto retry a mutation.
                    first=page.locator(".lead").first
                    with page.expect_response(lambda r:r.url.endswith("/claim") and r.status==409,timeout=10000):
                        first.get_by_role("button",name="Взять заявку").click()
                    page.locator("#r9-conflict").wait_for(state="visible",timeout=10000)
                    assert state["claimAttempts"]==1
                    page.locator("#r9-conflict-reload").click()
                    page.locator("#r9-conflict").wait_for(state="hidden",timeout=15000)
                    assert state["claimAttempts"]==1
                    assert not errors,errors
                    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+3")
                    page.close()

                    # R8 API remains usable for viewing, but old client CSV is disabled.
                    old=browser.new_page(viewport={"width":width,"height":height})
                    oldState=fixtures();oldState["csvRequests"]=[];oldState["claimAttempts"]=0
                    configure(old,oldState,r9=False)
                    old.goto(URL,wait_until="domcontentloaded")
                    old.locator("#workspace").wait_for(state="visible",timeout=15000)
                    assert old.locator("#csv").is_disabled()
                    assert old.locator("#r9-response").is_hidden()
                    assert old.locator(".lead").count()==50
                    old.close()

                    # Manager can read the contact report, but cannot request owner CSV.
                    manager=browser.new_page(viewport={"width":width,"height":height})
                    mgr=fixtures();mgr["csvRequests"]=[];mgr["claimAttempts"]=0
                    configure(manager,mgr,role="manager")
                    manager.goto(URL,wait_until="domcontentloaded")
                    manager.locator("#workspace").wait_for(state="visible",timeout=15000)
                    manager.locator("#r9-response").wait_for(state="visible",timeout=15000)
                    assert manager.locator("#csv").is_disabled()
                    manager.close()
            finally:browser.close()
    finally:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill()
if __name__=="__main__":
    main()
    print("CINEMA R9: mobile/desktop server CSV, response evidence, 409 and R8 fallback PASS")
