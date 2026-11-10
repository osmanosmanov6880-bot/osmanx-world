"""Real local no-AI site editor, typed records and reproducible preview tests."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from campaign180.builder import SiteSpecDenied,validate_site_spec,validate_row,render_site
from campaign180.drafts import LocalDraftStore,DraftDenied
from campaign180.records import LocalRecordStore,RecordDenied
from campaign180.preview import write_preview,verify_preview,PreviewDenied
from campaign180.contracts import digest

REPO=Path(__file__).resolve().parents[3]
SAMPLE=REPO/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"

def spec():
    return json.loads(SAMPLE.read_text(encoding="utf-8"))

def key(s="request"):
    return s+"-"+uuid.uuid4().hex

class BuilderTests(unittest.TestCase):
    def test_demo_spec_is_strict_and_generates_multiple_pages(self):
        value=validate_site_spec(spec())
        a=render_site(value)
        self.assertEqual(set(a),{"index.html","data.html","contact.html"})
        self.assertEqual(a,render_site(value))
        self.assertIn(b'Content-Security-Policy',a["index.html"])
        self.assertIn('lang="ru"',a["index.html"].decode("utf-8"))
        self.assertIn(b'noindex,nofollow',a["index.html"])

    def test_script_and_attribute_injection_escaped(self):
        raw=spec()
        evil='"/><script>alert(1)</script>'
        raw["title"]=evil
        raw["pages"][0]["sections"][0]["heading"]=evil
        html=render_site(raw)["index.html"].decode()
        self.assertNotIn("<script>",html)
        self.assertIn("&lt;script&gt;",html)
        self.assertNotIn('><script>',html)

    def test_invalid_slugs_and_home_requirements_denied(self):
        for slug in ("../oops","A Home","a/other","home.html","home<script>"):
            raw=spec()
            raw["pages"][0]["slug"]=slug
            with self.subTest(slug=slug),self.assertRaises(SiteSpecDenied):
                validate_site_spec(raw)

    def test_unresolved_cta_and_unknown_model_denied(self):
        raw=spec()
        raw["pages"][0]["sections"][0]["cta_page"]="unknown"
        with self.assertRaises(SiteSpecDenied):validate_site_spec(raw)
        raw=spec()
        raw["pages"][1]["sections"][1]["model"]="missing"
        with self.assertRaises(SiteSpecDenied):validate_site_spec(raw)

    def test_unknown_schema_fields_denied(self):
        raw=spec()
        raw["remote_script"]="https://elsewhere.example/script.js"
        with self.assertRaises(SiteSpecDenied):validate_site_spec(raw)
        raw=spec()
        raw["models"][0]["fields"][0]["name"]="api_key"
        with self.assertRaises(SiteSpecDenied):validate_site_spec(raw)

    def test_required_and_bounded_typed_rows(self):
        customers=validate_site_spec(spec())["models"][0]
        for raw in ({"name":34},{"name":""},{"name":"A","email":"not-mail"},
                    {"email":"user@example.org"},{"name":"A","unknown":1}):
            with self.subTest(raw=raw),self.assertRaises(SiteSpecDenied):
                validate_row(customers,raw)
        self.assertEqual(validate_row(customers,{"name":"A"}),{"name":"A"})
        requests=validate_site_spec(spec())["models"][1]
        with self.assertRaises(SiteSpecDenied):
            validate_row(requests,{"customer":"tenant_other","summary":"X"})
        with self.assertRaises(SiteSpecDenied):
            validate_row(requests,{"customer":str(uuid.uuid4()),"summary":"X","value":True})

    def test_preview_dataset_rejects_unknown_model(self):
        with self.assertRaises(SiteSpecDenied):
            render_site(spec(),datasets={"unregistered":[]})

class DraftTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db=LocalDraftStore(Path(self.temp.name)/"sites.sqlite3")
        self.spec=spec()
        self.project=self.spec["project_id"]
        self.db.create(self.spec,tenant=TENANT)

    def test_edit_page_revisioned_and_read_back(self):
        receipt=self.db.edit_page(tenant=TENANT,project_id=self.project,
            slug="home",expected_revision=1,title="Обзор")
        self.assertEqual(receipt["revision"],2)
        self.assertEqual(self.db.load(tenant=TENANT,project_id=self.project)
                         ["pages"][0]["title"],"Обзор")
        self.assertEqual(self.db.load(tenant=TENANT,project_id=self.project,revision=1)
                         ["pages"][0]["title"],"Главная")

    def test_section_edit_produces_real_updated_html(self):
        self.db.edit_page(tenant=TENANT,project_id=self.project,
            slug="home",expected_revision=1,section_index=0,
            changes={"heading":"Новое предложение"})
        new=self.db.load(tenant=TENANT,project_id=self.project)
        self.assertIn("Новое предложение",render_site(new)["index.html"].decode())

    def test_stale_revision_and_invalid_section_edit_rejected(self):
        self.db.edit_page(tenant=TENANT,project_id=self.project,
            slug="home",expected_revision=1,title="Первая версия")
        with self.assertRaises(DraftDenied):
            self.db.edit_page(tenant=TENANT,project_id=self.project,
                slug="home",expected_revision=1,title="Конфликт")
        with self.assertRaises(DraftDenied):
            self.db.edit_page(tenant=TENANT,project_id=self.project,
                slug="home",expected_revision=2,section_index=0,changes={"type":"table"})

    def test_revert_creates_new_version_and_preserves_history(self):
        self.db.edit_page(tenant=TENANT,project_id=self.project,
                          slug="home",expected_revision=1,title="Изменено")
        restored=self.db.revert(tenant=TENANT,project_id=self.project,
                                target_revision=1,expected_revision=2)
        self.assertEqual(restored["revision"],3)
        self.assertEqual(self.db.load(tenant=TENANT,project_id=self.project)
                         ["pages"][0]["title"],"Главная")
        self.assertEqual(self.db.load(tenant=TENANT,project_id=self.project,revision=2)
                         ["pages"][0]["title"],"Изменено")

    def test_corrupt_head_detected_by_read(self):
        with sqlite3.connect(self.db.path) as conn:
            conn.execute("UPDATE draft_projects SET content_json='{}'")
        with self.assertRaises(DraftDenied):
            self.db.load(tenant=TENANT,project_id=self.project)

    def test_revision_history_is_immutable_via_sql(self):
        with self.assertRaises(sqlite3.IntegrityError):
            with sqlite3.connect(self.db.path) as conn:
                conn.execute("DELETE FROM draft_revisions")

    def test_import_export_new_project_same_tenant_only(self):
        exported=self.db.export_bundle(tenant=TENANT,project_id=self.project)
        dest=str(uuid.uuid4())
        result=self.db.import_bundle(exported,target_tenant=TENANT,
                new_project_id=dest,expected_sha256=sha256(exported).hexdigest())
        self.assertEqual(result["project_id"],dest)
        new=self.db.load(tenant=TENANT,project_id=dest)
        self.assertEqual(new["pages"],self.spec["pages"])
        self.assertEqual(new["project_id"],dest)
        with self.assertRaises(DraftDenied):
            self.db.import_bundle(exported,target_tenant="tenant_foreign",
                new_project_id=str(uuid.uuid4()),
                expected_sha256=sha256(exported).hexdigest())

    def test_mutated_bundle_and_overwrite_denied(self):
        exported=self.db.export_bundle(tenant=TENANT,project_id=self.project)
        with self.assertRaises(DraftDenied):
            self.db.import_bundle(exported+b"x",target_tenant=TENANT,
                new_project_id=str(uuid.uuid4()),expected_sha256=sha256(exported).hexdigest())
        with self.assertRaises(DraftDenied):
            self.db.import_bundle(exported,target_tenant=TENANT,
                new_project_id=self.project,expected_sha256=sha256(exported).hexdigest())

    def test_concurrent_cas_one_winner(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            responses=list(pool.map(lambda i:self._one(i),range(6)))
        self.assertEqual(sum(responses),1)
        self.assertEqual(self.db.current_revision(tenant=TENANT,project_id=self.project)
                         ["revision"],2)

    def _one(self,i):
        try:
            self.db.edit_page(tenant=TENANT,project_id=self.project,
                slug="home",expected_revision=1,title="V"+str(i))
            return 1
        except DraftDenied:return 0

    def test_cross_tenant_access_denied(self):
        with self.assertRaises(DraftDenied):
            self.db.load(tenant="tenant_other",project_id=self.project)
        with self.assertRaises(DraftDenied):
            self.db.create(self.spec,tenant="tenant_other")

class RecordTests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.drafts=LocalDraftStore(Path(t.name)/"builder.sqlite3")
        self.project=spec()["project_id"]
        self.drafts.create(spec(),tenant=TENANT)
        self.rows=LocalRecordStore(self.drafts)

    def customer(self,name="Ада"):
        return self.rows.create(tenant=TENANT,project_id=self.project,model="customers",
                                data={"name":name,"email":"ada@example.org"},
                                idempotency_key=key())

    def test_create_fetch_and_list(self):
        created=self.customer()
        self.assertEqual(created["version"],1)
        result=self.rows.fetch(tenant=TENANT,project_id=self.project,
                               model="customers",row_id=created["row_id"])
        self.assertEqual(result["fields"]["name"],"Ада")
        self.assertEqual(len(self.rows.list(tenant=TENANT,
            project_id=self.project,model="customers")),1)

    def test_reference_requires_existing_same_project_row(self):
        with self.assertRaises(RecordDenied):
            self.rows.create(tenant=TENANT,project_id=self.project,model="requests",
                data={"customer":str(uuid.uuid4()),"summary":"Запрос"},
                idempotency_key=key())
        a=self.customer()
        req=self.rows.create(tenant=TENANT,project_id=self.project,model="requests",
            data={"customer":a["row_id"],"summary":"Заявка","value":100},
            idempotency_key=key())
        self.assertEqual(self.rows.fetch(tenant=TENANT,project_id=self.project,
            model="requests",row_id=req["row_id"])["fields"]["customer"],a["row_id"])
        with self.assertRaises(RecordDenied):
            self.rows.delete(tenant=TENANT,project_id=self.project,model="customers",
                row_id=a["row_id"],expected_version=1,idempotency_key=key())

    def test_update_and_delete_respect_revisions(self):
        a=self.customer()
        edited=self.rows.update(tenant=TENANT,project_id=self.project,model="customers",
            row_id=a["row_id"],expected_version=1,
            changes={"name":"Ада Б."},idempotency_key=key())
        self.assertEqual(edited["version"],2)
        with self.assertRaises(RecordDenied):
            self.rows.update(tenant=TENANT,project_id=self.project,model="customers",
                row_id=a["row_id"],expected_version=1,
                changes={"name":"Конфликт"},idempotency_key=key())
        removed=self.rows.delete(tenant=TENANT,project_id=self.project,model="customers",
            row_id=a["row_id"],expected_version=2,idempotency_key=key())
        self.assertTrue(removed["deleted"])
        self.assertEqual(self.rows.list(tenant=TENANT,project_id=self.project,
                                       model="customers"),[])

    def test_reference_link_changes_and_deletion_after_source_removed(self):
        a=self.customer("A")
        b=self.customer("B")
        req=self.rows.create(tenant=TENANT,project_id=self.project,model="requests",
            data={"customer":a["row_id"],"summary":"A"},idempotency_key=key())
        self.rows.update(tenant=TENANT,project_id=self.project,model="requests",
            row_id=req["row_id"],expected_version=1,
            changes={"customer":b["row_id"]},idempotency_key=key())
        deleted=self.rows.delete(tenant=TENANT,project_id=self.project,
            model="customers",row_id=a["row_id"],expected_version=1,idempotency_key=key())
        self.assertTrue(deleted["deleted"])
        with self.assertRaises(RecordDenied):
            self.rows.delete(tenant=TENANT,project_id=self.project,
                model="customers",row_id=b["row_id"],expected_version=1,idempotency_key=key())

    def test_replay_idempotency_returns_original_and_collision_denied(self):
        first_key=key()
        args=dict(tenant=TENANT,project_id=self.project,model="customers",
                  data={"name":"Повтор"},idempotency_key=first_key)
        first=self.rows.create(**args)
        self.assertEqual(first,self.rows.create(**args))
        with self.assertRaises(RecordDenied):
            self.rows.create(**{**args,"data":{"name":"Подмена"}})
        self.assertEqual(len(self.rows.list(tenant=TENANT,project_id=self.project,
            model="customers")),1)

    def test_unauthorized_tenant_and_model_not_leaked(self):
        a=self.customer()
        with self.assertRaises(DraftDenied):
            self.rows.fetch(tenant="tenant_other",project_id=self.project,
                model="customers",row_id=a["row_id"])
        with self.assertRaises(RecordDenied):
            self.rows.list(tenant=TENANT,project_id=self.project,model="unknown")

    def test_records_block_schema_change_without_migration(self):
        self.customer()
        changed=spec()
        changed["models"][0]["fields"][0]["label"]="Переименовано"
        with self.assertRaises(DraftDenied):
            self.drafts.save(tenant=TENANT,project_id=self.project,
                expected_revision=1,spec=changed)

    def test_preview_html_escapes_record_value(self):
        self.customer("<img src=x onerror=alert(1)>")
        result=render_site(self.drafts.load(tenant=TENANT,project_id=self.project),
            datasets=self.rows.preview_data(tenant=TENANT,project_id=self.project))
        html=result["data.html"].decode("utf-8")
        self.assertNotIn("<img",html)
        self.assertIn("&lt;img",html)

    def test_row_corruption_fails_closed(self):
        a=self.customer()
        with sqlite3.connect(self.drafts.path) as db:
            db.execute("UPDATE builder_rows SET data_json='{}' WHERE row_id=?",
                       (a["row_id"],))
        with self.assertRaises(RecordDenied):
            self.rows.fetch(tenant=TENANT,project_id=self.project,
                            model="customers",row_id=a["row_id"])

class PreviewTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root=Path(temp.name)
        self.spec=spec()

    def test_preview_verified_and_reproducible(self):
        a=write_preview(self.spec,self.root,"preview-a")
        b=write_preview(self.spec,self.root,"preview-b")
        self.assertEqual(a["manifest_sha256"],b["manifest_sha256"])
        checked=verify_preview(self.root/"preview-a",
            expected_spec_sha256=digest(self.spec))
        self.assertTrue(checked["integrity_verified"])
        self.assertFalse(checked["production_published"])

    def test_existing_preview_never_overwritten(self):
        write_preview(self.spec,self.root,"preview-a")
        with self.assertRaises(PreviewDenied):
            write_preview(self.spec,self.root,"preview-a")

    def test_page_mutation_detected(self):
        write_preview(self.spec,self.root,"preview-a")
        page=self.root/"preview-a/index.html"
        page.write_bytes(page.read_bytes()+b"tampered")
        with self.assertRaises(PreviewDenied):
            verify_preview(self.root/"preview-a")

    def test_unlisted_file_detected(self):
        write_preview(self.spec,self.root,"preview-a")
        (self.root/"preview-a/extra.js").write_text("alert(1)")
        with self.assertRaises(PreviewDenied):
            verify_preview(self.root/"preview-a")

    def test_manifest_mutation_detected(self):
        write_preview(self.spec,self.root,"preview-a")
        m=self.root/"preview-a/PREVIEW_MANIFEST.json"
        m.write_bytes(m.read_bytes()+b"\n")
        with self.assertRaises(PreviewDenied):
            verify_preview(self.root/"preview-a")

    def test_bad_name_and_symlink_parent_denied(self):
        with self.assertRaises(PreviewDenied):
            write_preview(self.spec,self.root,"../escape")
        linked=self.root/"link"
        linked.symlink_to(self.root)
        with self.assertRaises(PreviewDenied):
            write_preview(self.spec,linked,"preview-c")

    def test_e2e_data_driven_preview_from_records_and_version(self):
        drafts=LocalDraftStore(self.root/"draft.sqlite3")
        records=LocalRecordStore(drafts)
        drafts.create(self.spec,tenant=TENANT)
        person=records.create(tenant=TENANT,project_id=self.spec["project_id"],
            model="customers",data={"name":"Марина"},idempotency_key=key())
        records.create(tenant=TENANT,project_id=self.spec["project_id"],
            model="requests",data={"customer":person["row_id"],"summary":"Повторный визит",
                                   "value":150},idempotency_key=key())
        drafts.edit_page(tenant=TENANT,project_id=self.spec["project_id"],
            slug="home",expected_revision=1,section_index=0,
            changes={"heading":"Управление клиентами"})
        current=drafts.load(tenant=TENANT,project_id=self.spec["project_id"])
        a=write_preview(current,self.root,"working-preview",
                        datasets=records.preview_data(tenant=TENANT,
                                  project_id=self.spec["project_id"]))
        self.assertEqual(a["files"],3)
        self.assertIn("Управление клиентами",
                      (self.root/"working-preview/index.html").read_text())
        self.assertIn("Повторный визит",
                      (self.root/"working-preview/data.html").read_text())

if __name__=="__main__":
    unittest.main()
