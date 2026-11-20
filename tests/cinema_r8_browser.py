"""CINEMA R8: mobile and desktop read-only owner diagnostics and audited CSV.
Synthetic browser fixtures; real PostgreSQL RBAC is verified in cinema-r8.test.mjs.
"""
import json,shutil,socket,subprocess,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
from cinema_r6_browser import fixtures,mock,reply,ROOT,OWNER
PORT=18828
URL=f"http://127.0.0.1:{PORT}/assets/stories/manager.html"
def run():
    proc=subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1"],
        cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(90):
            try:
                with socket.create_connection(("127.0.0.1",PORT),timeout=1):break
            except OSError:time.sleep(.15)
        else:raise RuntimeError("R8 browser fixture server unavailable")
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,
                executable_path=shutil.which("google-chrome") or shutil.which("chromium") or None,
                args=["--disable-dev-shm-usage"])
            try:
                for width,height in [(1440,900),(390,844)]:
                    state=fixtures();state["approvals"]=[]
                    page=browser.new_page(viewport={"width":width,"height":height},
                        accept_downloads=True,reduced_motion="reduce")
                    errors=[];page.on("pageerror",lambda e:errors.append(str(e)))
                    mock(page,state)
                    page.route("**/api/industry/v1/cinema/public/runtime",lambda r:reply(r,{
                        "schema":"osmanx.cinema.runtime.v1","apiRelease":"r8",
                        "onlineIntakeEnabled":False,"aggregateActionsEnabled":False,
                        "operatorTenantConfigured":True,
                        "capabilities":{"ownerCsvApproval":True,"retentionReceipts":True}}))
                    page.route("**/api/industry/v1/cinema/ops/preflight",lambda r:reply(r,{
                        "schema":"osmanx.cinema.ops-preflight.v1","apiRelease":"r8",
                        "intakeEnabled":False,"aggregateEventsEnabled":False,
                        "leads":{"total":62,"expired":0},
                        "retention":{"lastExecution":None,
                            "assessment":{"status":"not_observed","explanation":"Очистка ещё не зарегистрирована."}},
                        "requiresHumanReview":True}))
                    def approve(route):
                        assert route.request.method=="POST"
                        body=json.loads(route.request.post_data)
                        state["approvals"].append(body)
                        reply(route,{"approved":True,"approvedCount":len(body["leadIds"])})
                    page.route("**/api/industry/v1/cinema/exports/approve",approve)
                    page.goto(URL,wait_until="domcontentloaded")
                    page.locator("#workspace").wait_for(state="visible",timeout=15000)
                    page.locator("#r8-ops").wait_for(state="visible",timeout=15000)
                    assert page.locator("#csv").is_enabled()
                    assert "API R8 доступен" in page.locator("#r8-runtime-status").inner_text()
                    with page.expect_response(lambda r: "/ops/preflight" in r.url and r.status==200,timeout=12000):
                        page.locator("#r8-refresh").click()
                    assert "Очистка ещё не зарегистрирована" in page.locator("#r8-ops-result").inner_text()
                    page.on("dialog",lambda d:d.accept())
                    with page.expect_download(timeout=15000) as info:
                        page.locator("#csv").click()
                    assert info.value.suggested_filename=="osmanx-cinema-leads.csv"
                    assert len(state["approvals"])==1
                    assert state["approvals"][0]["confirm"]=="EXPORT_LOADED"
                    assert len(state["approvals"][0]["leadIds"])==50
                    assert "CSV сформирован" in page.locator("#leads-status").inner_text()
                    assert not errors,errors
                    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 3")
                    page.close()

                    # Pre-R8 API: same static page retains R6 list but disallows all bulk exports.
                    old=browser.new_page(viewport={"width":width,"height":height})
                    mock(old,fixtures())
                    old.route("**/api/industry/v1/cinema/public/runtime",
                        lambda r:reply(r,{"error":"R8 not deployed"},404))
                    old.goto(URL,wait_until="domcontentloaded")
                    old.locator("#workspace").wait_for(state="visible",timeout=15000)
                    assert old.locator("#csv").is_disabled()
                    assert old.locator("#r8-ops").is_hidden()
                    assert old.locator(".lead").count()==50
                    assert "не подтверждён" in old.locator("#r8-runtime-status").inner_text()
                    old.close()
            finally:browser.close()
    finally:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill()
if __name__=="__main__":
    run()
    print("CINEMA R8: mobile/desktop owner CSV, retention and R7 fallback passed")
