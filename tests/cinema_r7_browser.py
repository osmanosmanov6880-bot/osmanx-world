"""CINEMA R7: mobile/desktop work claiming, duplicate hints, audit and no-URL PII search.
Synthetic browser stubs only; actual DB permission and races are tested in cinema-r7.test.mjs.
"""
import json,shutil,socket,subprocess,sys,time
from playwright.sync_api import sync_playwright
from cinema_r6_browser import fixtures,mock,reply,ROOT,OWNER
PORT=18827
BASE=f"http://127.0.0.1:{PORT}"
def start():
    proc=subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1"],
        cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for _ in range(80):
        try:
            with socket.create_connection(("127.0.0.1",PORT),timeout=1):return proc
        except OSError:time.sleep(.15)
    proc.terminate()
    raise RuntimeError("No R7 browser server")
def main():
    proc=start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,
                executable_path=shutil.which("google-chrome") or shutil.which("chromium") or None,
                args=["--disable-dev-shm-usage"])
            try:
                for width,height in [(1440,900),(390,844)]:
                    state=fixtures()
                    state["claims"]=[];state["subjectSearches"]=[]
                    page=browser.new_page(viewport={"width":width,"height":height},reduced_motion="reduce")
                    errors=[];page.on("pageerror",lambda err:errors.append(str(err)))
                    mock(page,state)
                    page.route("**/api/industry/v1/cinema/team/workload",lambda r:reply(r,{
                        "schema":"osmanx.cinema.team-workload.v1",
                        "items":[{"id":OWNER,"email":"owner@example.test","role":"owner","active":0,
                            "overdue":0,"awaiting_first_attempt":0}]}))
                    def claim(r):
                        body=json.loads(r.request.post_data)
                        state["claims"].append(body)
                        lead=state["leads"][0]
                        lead["version"]+=1
                        lead["assigned_to"]=OWNER if body["action"]=="claim" else None
                        reply(r,{"recorded":True,"item":{"id":lead["id"],
                            "version":lead["version"],"assigned_to":lead["assigned_to"]}})
                    page.route("**/api/industry/v1/cinema/leads/*/claim",claim)
                    page.route("**/api/industry/v1/cinema/leads/*/similar",lambda r:reply(r,{
                        "schema":"osmanx.cinema.similar.v1","total":1,
                        "items":[{"id":state["leads"][1]["id"],"state":"new",
                            "organization":"Тестовая точка 2","story_id":"07-coffee",
                            "created_at":state["leads"][1]["created_at"]}],
                        "matchBasis":"exact_email_only","truncated":False}))
                    page.route("**/api/industry/v1/cinema/leads/*/audit-integrity",lambda r:reply(r,{
                        "schema":"osmanx.cinema.audit-check.v1","complete":True,
                        "eventCount":state["leads"][0]["version"],"leadVersion":state["leads"][0]["version"],
                        "proofLevel":"sequence_consistency_only_not_cryptographic"}))
                    def protected_search(r):
                        assert r.request.method=="POST"
                        assert "email=" not in r.request.url
                        body=json.loads(r.request.post_data)
                        state["subjectSearches"].append(body)
                        reply(r,{"items":[{
                            "id":state["leads"][0]["id"],"contact_email":body["email"],
                            "created_at":state["leads"][0]["created_at"],"state":"new"}],
                            "requiresIdentityVerification":True})
                    page.route("**/api/industry/v1/cinema/privacy/search",protected_search)
                    page.goto(BASE+"/assets/stories/manager.html",wait_until="domcontentloaded")
                    page.locator("#workspace").wait_for(state="visible",timeout=15000)
                    page.locator("#r7-workload").wait_for(state="visible",timeout=15000)
                    assert page.locator(".r7-staff-card").count()==1
                    assert page.locator(".lead").count()==50
                    first=page.locator(".lead").first
                    assert first.locator(".r7-ops button").count()==3
                    with page.expect_response(lambda r:r.url.endswith("/claim") and r.status==200,timeout=15000):
                        first.get_by_role("button",name="Взять заявку").click()
                    page.wait_for_function("""() => {
                        const b=document.querySelector('.lead .r7-ops button');
                        return b?.textContent?.includes('Освободить');
                    }""",timeout=15000)
                    assert len(state["claims"])==1
                    assert state["claims"][0]["expectedVersion"]==1
                    assert state["claims"][0]["action"]=="claim"
                    first=page.locator(".lead").first
                    first.get_by_role("button",name="Похожие обращения").click()
                    first.locator(".r7-duplicate").wait_for(state="visible",timeout=15000)
                    assert "Точное совпадение email: 1" in first.locator(".r7-duplicate").inner_text()
                    first.get_by_role("button",name="Проверить историю").click()
                    first.locator(".r7-integrity").wait_for(state="visible",timeout=15000)
                    assert "не криптографическое" in first.locator(".r7-integrity").inner_text()
                    page.locator("#r5-subject-email").fill("person@example.test")
                    with page.expect_response(lambda r:r.url.endswith("/privacy/search") and
                        r.request.method=="POST" and r.status==200,timeout=15000):
                        page.locator("#r5-subject-form button").click()
                    assert state["subjectSearches"]==[{"email":"person@example.test"}]
                    assert page.locator(".r5-subject-item").count()==1
                    assert not errors,errors
                    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+3")
                    page.close()

                    # Old R6 server: the new static UI must retain working R6 queue.
                    old=browser.new_page(viewport={"width":width,"height":height})
                    fallback=fixtures();mock(old,fallback)
                    old.route("**/api/industry/v1/cinema/team/workload",
                              lambda r:reply(r,{"error":"unavailable"},404))
                    old.goto(BASE+"/assets/stories/manager.html",wait_until="domcontentloaded")
                    old.locator("#workspace").wait_for(state="visible",timeout=15000)
                    assert old.locator("#r7-workload").is_hidden()
                    assert old.locator(".lead").count()==50
                    assert old.locator(".r7-ops").count()==0
                    old.close()
            finally:browser.close()
    finally:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill()
if __name__=="__main__":
    main()
    print("CINEMA R7 mobile/desktop protected claim, duplicates, audit and privacy POST PASS")
