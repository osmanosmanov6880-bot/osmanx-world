"""Wave 16: actual SQLite record search, safe CSV and atomic bulk import tests."""
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from wsgiref.util import setup_testing_defaults

from campaign180.app_runtime import LocalAppRuntime, RULE_SCHEMA
from campaign180.app_policy import AppAccessDenied
from campaign180.record_bulk import RecordBulkDenied
from campaign180.local_http import LocalConsole

REPO = Path(__file__).resolve().parents[3]
DEMO = REPO / "supreme-director/campaign180/examples/demo-site.json"
TENANT = "tenant_demo"
OWNER = "owner-abc"
VIEWER = "viewer-abc"
OPERATOR = "operator-abc"
TOKEN = "CSVLOCAL_E2E_abcdefghijklmnopqrstuvwxyz_1234567890"
PORT = 8767


def operation_key():
    return "import-" + uuid.uuid4().hex


class BulkSetup(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.database = Path(tmp.name) / "app.sqlite3"
        self.spec = json.loads(DEMO.read_text(encoding="utf-8"))
        self.project = self.spec["project_id"]
        self.runtime = LocalAppRuntime(str(self.database))
        self.runtime.drafts.create(self.spec, tenant=TENANT)
        self.runtime.policy.bootstrap_owner(
            tenant=TENANT, project_id=self.project, actor=OWNER, now=1799971200
        )

    def opts(self, actor=OWNER, model="customers"):
        return {"tenant": TENANT, "project_id": self.project,
                "actor": actor, "model": model}

    def create(self, name, *, email=None, actor=OWNER):
        data = {"name": name}
        if email is not None:
            data["email"] = email
        return self.runtime.create_row(
            **self.opts(actor=actor), data=data, idempotency_key=operation_key()
        )

    def query(self, **extra):
        return self.runtime.query_rows(**{**self.opts(), **extra})

    def export(self, **extra):
        return self.runtime.export_csv(**{**self.opts(), **extra})

    def inspect(self, csv_text, **extra):
        return self.runtime.inspect_csv_import(**{
            **self.opts(), "csv_text": csv_text, "expected_revision": 1,
            **extra,
        })

    def apply(self, csv_text, plan=None, **extra):
        if plan is None:
            plan = self.inspect(csv_text)
        return self.runtime.apply_csv_import(**{
            **self.opts(), "expected_revision": 1,
            "csv_text": csv_text,
            "expected_plan_sha256": plan["expected_plan_sha256"],
            "idempotency_key": operation_key(), **extra,
        })


class SearchTests(BulkSetup):
    def test_casefold_cyrillic_search_and_stable_pages(self):
        for name in ("Марина", "марИНА", "Рустам", "ОСМАН"):
            self.create(name)
        result = self.query(search="мАРИНа", limit=1)
        self.assertEqual(result["total"], 2)
        self.assertTrue(result["has_more"])
        second = self.query(search="мАРИНа", limit=1, offset=1)
        self.assertNotEqual(result["rows"][0]["row_id"], second["rows"][0]["row_id"])
        self.assertFalse(second["has_more"])
        self.assertEqual(self.query(search="НЕТ")["total"], 0)

    def test_field_search_does_not_match_wrong_columns(self):
        self.create("Катя", email="hello@example.org")
        self.assertEqual(self.query(search="hello", field="email")["total"], 1)
        self.assertEqual(self.query(search="hello", field="name")["total"], 0)
        with self.assertRaises(RecordBulkDenied):
            self.query(search="hello", field="__proto__")

    def test_bad_page_bounds_and_control_characters_are_rejected(self):
        for kwargs in ({"limit": 0}, {"limit": 101}, {"limit": True},
                       {"offset": -1}, {"search": "x" * 81},
                       {"search": "hi\nworld"}, {"field": ["name"]}):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(RecordBulkDenied):
                    self.query(**kwargs)

    def test_deleted_rows_not_in_search_or_export(self):
        result = self.create("Удалённая")
        self.runtime.delete_row(
            **self.opts(), row_id=result["row_id"],
            expected_version=result["version"],
            idempotency_key=operation_key(),
        )
        self.assertEqual(self.query()["total"], 0)
        self.assertEqual(self.export()["exported"], 0)

    def test_tampered_stored_row_blocks_entire_search(self):
        self.create("Целая")
        with self.runtime.drafts._tx() as db:
            db.execute("UPDATE builder_rows SET content_digest=? WHERE tenant=?",
                       ("bad", TENANT))
        with self.assertRaises(ValueError):
            self.query()

    def test_cross_tenant_and_viewer_permissions(self):
        self.create("Своё")
        self.runtime.policy.add_member(
            tenant=TENANT, project_id=self.project, owner_actor=OWNER,
            member_actor=VIEWER, role="viewer", now=1799971201
        )
        self.assertEqual(self.runtime.query_rows(
            **self.opts(actor=VIEWER))["total"], 1)
        with self.assertRaises(AppAccessDenied):
            self.runtime.query_rows(**self.opts(actor=OWNER), tenant="other-tenant")
        with self.assertRaises(ValueError):
            self.runtime.query_rows(**self.opts(actor=OWNER),
                                    project_id=str(uuid.uuid4()))

    def test_csv_export_quotes_and_defuses_spreadsheet_formula(self):
        self.create("=2+2", email="valid@example.org")
        self.create("Тест, с запятой")
        result = self.export()
        self.assertEqual(result["exported"], 2)
        self.assertTrue(result["spreadsheet_formula_escaped"])
        self.assertIn("'=2+2", result["csv_text"])
        self.assertIn('"Тест, с запятой"', result["csv_text"])
        self.assertEqual(len(result["sha256"]), 64)
        self.assertTrue(result["local_only"])

    def test_export_truncates_at_exact_cap(self):
        for index in range(103):
            self.create("Клиент " + str(index))
        result = self.export()
        self.assertEqual(result["exported"], 100)
        self.assertEqual(result["total_filtered"], 103)
        self.assertTrue(result["truncated"])


class ImportTests(BulkSetup):
    def test_inspect_has_no_side_effects_and_commit_is_atomic(self):
        csv_text = "name,email\nАда,ada@example.org\nИван,ivan@example.org\n"
        plan = self.inspect(csv_text)
        self.assertEqual(plan["count"], 2)
        self.assertEqual(self.query()["total"], 0)
        result = self.apply(csv_text, plan)
        self.assertEqual(result["imported"], 2)
        self.assertTrue(result["persisted_locally"])
        self.assertEqual(self.query()["total"], 2)
        self.assertEqual(len(result["rows"]), 2)

    def test_import_idempotency_and_reused_key_collision(self):
        csv_text = "name\nКлиент CSV\n"
        plan = self.inspect(csv_text)
        key = operation_key()
        first = self.apply(csv_text, plan, idempotency_key=key)
        second = self.apply(csv_text, plan, idempotency_key=key)
        self.assertEqual(first, second)
        self.assertEqual(self.query()["total"], 1)
        other_csv = "name\nДругой клиент\n"
        with self.assertRaises(ValueError):
            self.apply(other_csv, self.inspect(other_csv), idempotency_key=key)
        self.assertEqual(self.query()["total"], 1)

    def test_invalid_csv_fails_before_any_mutation(self):
        bad = (
            "name,name\nАда,Иван\n",
            "email\nada@example.org\n",
            "name,unknown\nАда,secret\n",
            "name\n",
            "name\nИван,сюрприз\n",
            'name\n"unclosed\n',
            "name\n" + "\n".join("Name" + str(i) for i in range(51)),
            "name,email\nАда,no-email\n",
            "name\n" + "A" * 1001 + "\n",
        )
        for text in bad:
            with self.subTest(fragment=text[:30]):
                with self.assertRaises(ValueError):
                    self.inspect(text)
        self.assertEqual(self.query()["total"], 0)

    def test_stale_plan_and_changed_csv_refused(self):
        original = "name\nКлиент\n"
        plan = self.inspect(original)
        with self.assertRaises(RecordBulkDenied):
            self.apply("name\nДругой\n", plan)
        fresh = self.runtime.get_spec(
            tenant=TENANT, project_id=self.project, actor=OWNER)
        spec = fresh["spec"]
        spec["description"] = "Новая версия"
        self.runtime.drafts.save(tenant=TENANT, project_id=self.project,
                                 expected_revision=1, spec=spec)
        with self.assertRaises(RecordBulkDenied):
            self.apply(original, plan)
        self.assertEqual(self.query()["total"], 0)

    def test_reference_validation_and_link_insertion(self):
        customer = self.create("Первый")
        valid = ("customer,summary,value\n" +
                 customer["row_id"] + ",Заявка,1700\n")
        inspected = self.inspect(valid, model="requests")
        self.assertEqual(inspected["count"], 1)
        receipt = self.apply(valid, inspected, model="requests")
        with self.runtime.drafts._db() as db:
            link = db.execute("""SELECT target_row_id FROM builder_links
                WHERE tenant=? AND project_id=? AND model='requests'
                AND row_id=?""",
                (TENANT, self.project, receipt["rows"][0]["row_id"])).fetchone()
        self.assertEqual(link["target_row_id"], customer["row_id"])
        missing = "customer,summary\n" + str(uuid.uuid4()) + ",Плохая ссылка\n"
        with self.assertRaises(ValueError):
            self.inspect(missing, model="requests")
        self.assertEqual(self.query(model="requests")["total"], 1)

    def test_boolean_and_integer_parsing_is_strict(self):
        customer = self.create("Первый")
        value = "customer,summary,value\n" + customer["row_id"] + ",Смета,-15\n"
        self.apply(value, model="requests")
        item = self.query(model="requests")["rows"][0]
        self.assertEqual(item["fields"]["value"], -15)
        with self.assertRaises(RecordBulkDenied):
            self.inspect("customer,summary,value\n" +
                         customer["row_id"] + ",Нет,1.5\n", model="requests")

    def test_workflow_fires_on_each_imported_row_and_receipt_tracks_runs(self):
        rule = {
            "schema": RULE_SCHEMA, "name": "Из импорта",
            "model": "customers", "trigger": "record.created", "condition": None,
            "action": {"type": "set_field", "field": "email",
                       "value": "auto@example.org"},
        }
        self.runtime.add_workflow(**self.opts(), rule=rule)
        receipt = self.apply("name\nCSV 1\nCSV 2\n")
        self.assertEqual(receipt["imported"], 2)
        self.assertEqual(receipt["workflow_runs"], 2)
        self.assertEqual(self.query()["total"], 2)
        self.assertTrue(all(r["fields"]["email"] == "auto@example.org"
                            for r in self.query()["rows"]))

    def test_corrupted_workflow_rolls_back_entire_batch(self):
        rule = {
            "schema": RULE_SCHEMA, "name": "Проверка отката",
            "model": "customers", "trigger": "record.created", "condition": None,
            "action": {"type": "set_field", "field": "email",
                       "value": "auto@example.org"},
        }
        workflow = self.runtime.add_workflow(**self.opts(), rule=rule)
        with self.runtime.drafts._tx() as db:
            db.execute("UPDATE app_workflows SET spec_digest=? WHERE workflow_id=?",
                       ("tampered", workflow["workflow_id"]))
        csv_text = "name\nБез фиксации\nИ ещё\n"
        plan = self.inspect(csv_text)
        with self.assertRaises(ValueError):
            self.apply(csv_text, plan)
        self.assertEqual(self.query()["total"], 0)

    def test_roles_and_revocation_override_receipt_replay(self):
        for actor, role in ((VIEWER, "viewer"), (OPERATOR, "operator")):
            self.runtime.policy.add_member(
                tenant=TENANT, project_id=self.project, owner_actor=OWNER,
                member_actor=actor, role=role, now=1799971201
            )
        with self.assertRaises(AppAccessDenied):
            self.inspect("name\nЗапрещено\n", actor=VIEWER)
        text = "name\nРазрешено\n"
        plan = self.inspect(text, actor=OPERATOR)
        key = operation_key()
        self.apply(text, plan, actor=OPERATOR, idempotency_key=key)
        self.runtime.policy.revoke_member(
            tenant=TENANT, project_id=self.project,
            owner_actor=OWNER, member_actor=OPERATOR, now=1799971202
        )
        with self.assertRaises(AppAccessDenied):
            self.apply(text, plan, actor=OPERATOR, idempotency_key=key)
        self.assertEqual(self.query()["total"], 1)

    def test_json_http_query_inspect_and_apply(self):
        web = LocalConsole(self.database, tenant=TENANT, project_id=self.project,
                           actor=OWNER, token=TOKEN, port=PORT)

        def call(route, body, token=TOKEN):
            env = {}
            setup_testing_defaults(env)
            raw = json.dumps(body, ensure_ascii=False).encode()
            env.update({"PATH_INFO": route, "REQUEST_METHOD": "POST",
                        "HTTP_HOST": "127.0.0.1:" + str(PORT),
                        "REMOTE_ADDR": "127.0.0.1", "QUERY_STRING": "",
                        "CONTENT_TYPE": "application/json",
                        "CONTENT_LENGTH": str(len(raw)),
                        "wsgi.input": BytesIO(raw),
                        "HTTP_AUTHORIZATION": "Bearer " + token})
            status = []
            result = b"".join(web(env, lambda code, headers: status.append(code)))
            return status[0], json.loads(result)

        route = "/api/v1/models/customers"
        code, _ = call(route + "/query", {"limit": 10}, token="invalid")
        self.assertTrue(code.startswith("401"))
        csv_text = "name,email\nHTTP импорт,http@example.org\n"
        code, checked = call(route + "/csv-import/inspect",
                             {"expected_revision": 1, "csv_text": csv_text})
        self.assertTrue(code.startswith("200"), (code, checked))
        code, submitted = call(route + "/csv-import/apply", {
            "expected_revision": 1, "csv_text": csv_text,
            "expected_plan_sha256": checked["expected_plan_sha256"],
            "idempotency_key": operation_key(),
        })
        self.assertTrue(code.startswith("201"), (code, submitted))
        code, result = call(route + "/query", {"search": "HTTP"})
        self.assertTrue(code.startswith("200"))
        self.assertEqual(result["total"], 1)
        code, exported = call(route + "/csv-export", {"limit": 100})
        self.assertTrue(code.startswith("200"))
        self.assertIn("HTTP импорт", exported["csv_text"])
        code, forged = call(route + "/csv-import/inspect", {
            "expected_revision": 1, "csv_text": csv_text,
            "actor": OWNER, "tenant": TENANT,
        })
        self.assertTrue(code.startswith("400"))
        self.assertNotIn("csv_text", forged)

if __name__ == "__main__":
    unittest.main()
