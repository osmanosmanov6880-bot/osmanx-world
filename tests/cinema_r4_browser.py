"""R4 Chromium: staff follow-up workflow and campaign-tagged public consent."""
import json,shutil,socket,subprocess,sys,time
from datetime import datetime,timedelta,timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1];PORT=18804
BASE=f"http://127.0.0.1:{PORT}"
def answer(route,body,status=200):
    route.fulfill(status=status,content_type="application/json",body=json.dumps(body,ensure_ascii=False))
def main():
    proc=subprocess.Popen([sys.executable,"-m","http.server",str(PORT),"--bind","127.0.0.1"],
                          cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for i in range(100):
            try:
                with socket.create_connection(("127.0.0.1",PORT),timeout=1):break
            except OSError:time.sleep(.15)
        else:raise RuntimeError("HTTP test server did not start")
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path=shutil.which("google-chrome") or shutil.which("chromium") or None,args=["--disable-dev-shm-usage"])
            try:
                for width,height in [(1440,900),(390,844)]:
                    page=browser.new_page(viewport={"width":width,"height":height},reduced_motion="reduce")
                    errors=[];changes=[]
                    page.on("pageerror",lambda err:errors.append(str(err)))
                    lead=dict(id="10000000-0000-4000-8000-000000000001",contact_name="Тест",
                        contact_email="test@example.test",organization="Тестовая кофейня",
                        story_id="01-restaurant",observation="Гости уходят",goal="Измерить причины",
                        source="cinema",campaign_code="moscow_week1",state="new",deal_value_minor=None,
                        next_action_at=None,next_action_kind=None,loss_reason_code=None,version=1,
                        created_at="2026-11-20T10:00:00Z",updated_at="2026-11-20T10:00:00Z")
                    page.route("**/api/industry/v1/auth/me",lambda r:answer(r,{"role":"owner","tenant":{"slug":"test"}}))
                    page.route("**/api/industry/v1/cinema/metrics",lambda r:answer(r,{
                        "stages":[{"state":"new","leads":1,"won_value_minor":"0"}],
                        "sources":[{"source":"cinema","leads":1}],
                        "stories":[{"story_id":"01-restaurant","leads":1}],
                        "events":[],"campaigns":[{"campaign_code":"moscow_week1","leads":1,"won":0,"won_estimate_minor":"0"}],
                        "followups":{"overdue":0,"due_today":0}}))
                    page.route("**/api/industry/v1/cinema/followups?*",lambda r:answer(r,{"items":[]}))
                    page.route("**/api/industry/v1/cinema/leads?*",lambda r:answer(r,{"items":[lead.copy()],"limit":100}))
                    def patch(r):
                        body=json.loads(r.request.post_data);changes.append(body)
                        lead.update(next_action_at=body["nextActionAt"],next_action_kind=body["nextActionKind"],version=lead["version"]+1)
                        answer(r,{"item":lead})
                    page.route("**/api/industry/v1/cinema/leads/*",patch)
                    page.goto(BASE+"/assets/stories/manager.html",wait_until="domcontentloaded")
                    page.locator("#workspace").wait_for(state="visible",timeout=15000)
                    assert page.locator(".r4-campaign-card").count()==1
                    page.locator("#r4-campaign-name").fill("moscow_week1")
                    page.select_option("#r4-campaign-story","07-coffee")
                    page.locator('#r4-link-form button').click()
                    assert "utm_campaign=moscow_week1" in page.locator("#r4-created-link").input_value()
                    page.locator(".r4-fields select").first.select_option("email")
                    due=(datetime.now(timezone.utc)+timedelta(days=2)).strftime("%Y-%m-%dT%H:%M")
                    page.locator('.r4-fields input[type="datetime-local"]').fill(due)
                    page.locator(".lead-tools button").first.click()
                    page.wait_for_timeout(350)
                    assert len(changes)==1,changes
                    assert changes[0]["nextActionKind"]=="email"
                    assert changes[0]["expectedVersion"]==1
                    assert not errors,errors
                    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+3")
                    page.close()

                    public=browser.new_page(viewport={"width":width,"height":height},reduced_motion="reduce")
                    submissions=[]
                    public.route("**/api/industry/v1/cinema/public/config",
                        lambda r:answer(r,{"intakeEnabled":True,"aggregateEventsEnabled":False}))
                    def submit(r):
                        submissions.append(json.loads(r.request.post_data))
                        answer(r,{"accepted":True,"reference":"10000000-0000-4000-8000-000000000002"},201)
                    public.route("**/api/industry/v1/cinema/public/leads",submit)
                    public.goto(BASE+"/assets/stories/cinema.html?story=07-coffee&utm_campaign=moscow_week1#episodes",wait_until="domcontentloaded")
                    public.locator("#r2-form").wait_for(state="attached")
                    public.locator("#r2-observation").fill("Посетители уходят, когда очередь слишком длинная")
                    public.locator('#r2-form button[type="submit"]').click()
                    public.locator("#r3-lead-form").wait_for(state="visible",timeout=15000)
                    public.locator("#r3-name").fill("Тестировщик")
                    public.locator("#r3-email").fill("r4@example.test")
                    public.locator("#r3-consent").check()
                    public.locator("#r3-submit").click()
                    public.wait_for_function("document.querySelector('#r3-result')?.textContent.includes('Заявка принята')",timeout=12000)
                    assert len(submissions)==1
                    assert submissions[0]["campaignCode"]=="moscow_week1"
                    assert submissions[0]["consent"] is True
                    public.close()
            finally:browser.close()
    finally:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill()
if __name__=="__main__":
    main()
    print("CINEMA R4 Chromium desktop/mobile accepted")
