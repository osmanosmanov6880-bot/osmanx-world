"""Offline tests for the new M182 tool; NOT inherited M181 regression."""
from __future__ import annotations

from contextlib import redirect_stdout, redirect_stderr
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

from osgard_m182 import core
from osgard_m182.cli import bootstrap, main, to_markdown


TEAMS = core.TEAMS


def board_fixture():
    rows = []
    for i in range(180):
        parents = []
        if i >= 1:
            parents.append(f"T-{i-1:03d}")
        if 2 <= i <= 116:  # 179 + 115 = 294 edges, acyclic
            parents.append(f"T-{i-2:03d}")
        rows.append({"id": f"T-{i:03d}", "team": TEAMS[i // 30], "parents": parents})
    return {"source_authority": "M181_ORIGINAL_VERIFIED", "tasks": rows}


def conflicts_fixture():
    return {"conflicts": [
        {"id": f"C-{i:02d}", "severity": "P0" if i < 17 else "P1",
         "path": f"src/conflict_{i:02d}.py", "left_sha256": "a" * 64, "right_sha256": "b" * 64,
         "resolution": "MANUAL_MERGE", "author": "author", "reviewer": "reviewer",
         "review_pr_url": f"https://github.com/org/repo/pull/{i+1}", "review_commit_sha": "c" * 40}
        for i in range(28)]}


def contracts_fixture():
    return {"contracts": [
        {"id": f"K-{i}", "producer": "TITAN", "consumer": "NEXUS",
         "schema_sha256": "d" * 64,
         "test_run_url": f"https://github.com/org/repo/actions/runs/{i+1}"} for i in range(9)]}


def upstreams_fixture():
    return {"teams": [
        {"team": team, "repository_url": f"https://github.com/org/{team.lower()}",
         "head_sha": "a" * 40, "owner": "maintainer",
         "owner_approval_pr": f"https://github.com/org/{team.lower()}/pull/1"} for team in TEAMS]}


class FileInputs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)

    def put(self, name, obj):
        p = self.dir / name
        p.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
        return p

    def make_zip(self, specs=None, compression=zipfile.ZIP_STORED):
        p = self.dir / "source.zip"
        with zipfile.ZipFile(p, "w", compression=compression) as z:
            for name, data in (specs if specs is not None else [("src/app.py", b"print(1)\n")]):
                if isinstance(name, zipfile.ZipInfo):
                    z.writestr(name, data)
                else:
                    z.writestr(name, data)
        return p


class PathSafety(unittest.TestCase):
    pass


BAD_NAMES = {
    "absolute_linux": "/home/user/a.txt",
    "parent": "a/../b.py",
    "parent_only": "..",
    "dot": "src/./a.py",
    "two_slashes": "src//a.py",
    "backslash": "src\\a.py",
    "drive": "C:/root/key",
    "control": "a\x01b",
    "nul": "a\x00b",
    "reserved_con": "con.txt",
    "reserved_lpt": "dir/lpt9.md",
    "stream": "dir/file:ads",
    "trailing_dot": "dir/file.",
    "trailing_space": "file ",
    "tilde": "~/bad",
    "non_normalized": "a/e\u0301.txt",
    "empty": "",
    "slash_only": "/",
    "subdir_dot": "a/b/..",
    "long_name": "a" * 1025,
}
GOOD_NAMES = {
    "one_component": "README.md",
    "source_nested": "src/TITAN/app/main.py",
    "unicode_nfc": "docs/Прогресс.md",
    "directory": "src/TITAN/",
    "mixed_dots": "pkg/_hidden.test.py",
    "safe_dashes": "a-b/c_d/9.txt",
}


def add_path_tests():
    for label, name in BAD_NAMES.items():
        def one(self, name=name):
            self.assertFalse(core.safe_member_name(name)[0])
        setattr(PathSafety, "test_bad_" + label, one)
    for label, name in GOOD_NAMES.items():
        def one(self, name=name):
            self.assertTrue(core.safe_member_name(name)[0])
        setattr(PathSafety, "test_good_" + label, one)

add_path_tests()


class ArchiveSafety(FileInputs):
    def test_missing_archive_fails_closed(self):
        report = core.inspect_zip(self.dir / "no.zip")
        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["findings"][0]["code"], "M181_ARCHIVE_MISSING")

    def test_matching_sha_valid_archive(self):
        p = self.make_zip()
        r = core.inspect_zip(p, core.sha256_file(p))
        self.assertEqual(r["status"], "LOCAL_VERIFIED")
        self.assertEqual(r["file_count"], 1)
        self.assertEqual(r["members"][0]["sha256"], core.hashlib.sha256(b"print(1)\n").hexdigest())

    def test_mismatched_sha_blocks_without_reading(self):
        p = self.make_zip([("../escape", b"x")])
        report = core.inspect_zip(p, "0" * 64)
        self.assertEqual([i["code"] for i in report["findings"]], ["SHA256_MISMATCH"])

    def test_invalid_pin_blocks(self):
        p = self.make_zip()
        self.assertEqual(core.inspect_zip(p, "sha")["findings"][0]["code"], "PIN_INVALID")

    def test_bad_format(self):
        p = self.dir / "source.zip"
        p.write_bytes(b"not a zip")
        r = core.inspect_zip(p, core.sha256_file(p))
        self.assertEqual(r["status"], "BLOCKED")
        self.assertEqual(r["findings"][0]["code"], "ARCHIVE_READ_ERROR")

    def test_symlink_source_archive_blocks(self):
        p = self.make_zip()
        link = self.dir / "symlink.zip"
        link.symlink_to(p)
        self.assertEqual(core.inspect_zip(link, core.sha256_file(p))["findings"][0]["code"], "ARCHIVE_TYPE_OR_SIZE")

    def test_zip_directory(self):
        p = self.make_zip([("src/", b""), ("src/test.txt", b"x")])
        r = core.inspect_zip(p, core.sha256_file(p))
        self.assertEqual((r["file_count"], r["directory_count"]), (1, 1))

    def test_zip_traversal(self):
        p = self.make_zip([("../../secret", b"X")])
        r = core.inspect_zip(p, core.sha256_file(p))
        self.assertIn("UNSAFE_PATH", [i["code"] for i in r["findings"]])

    def test_zip_duplicate_same_case(self):
        with mock.patch("warnings.warn"):
            p = self.make_zip([("a.txt", b"1"), ("a.txt", b"2")])
        r = core.inspect_zip(p, core.sha256_file(p))
        self.assertIn("DUPLICATE_PATH", [i["code"] for i in r["findings"]])

    def test_zip_duplicate_casefold(self):
        p = self.make_zip([("A.txt", b"1"), ("a.TXT", b"2")])
        r = core.inspect_zip(p, core.sha256_file(p))
        self.assertIn("DUPLICATE_PATH", [i["code"] for i in r["findings"]])

    def test_zip_symlink_entry(self):
        info = zipfile.ZipInfo("src/link")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        p = self.make_zip([(info, b"/etc/passwd")])
        r = core.inspect_zip(p, core.sha256_file(p))
        self.assertIn("SPECIAL_MEMBER", [i["code"] for i in r["findings"]])

    def test_zip_special_device(self):
        info = zipfile.ZipInfo("dev/tty")
        info.create_system = 3
        info.external_attr = (stat.S_IFCHR | 0o666) << 16
        p = self.make_zip([(info, b"X")])
        r = core.inspect_zip(p, core.sha256_file(p))
        self.assertIn("SPECIAL_MEMBER", [i["code"] for i in r["findings"]])

    def test_zip_file_used_as_parent(self):
        p = self.make_zip([("src", b"1"), ("src/app.py", b"2")])
        r = core.inspect_zip(p, core.sha256_file(p))
        self.assertIn("FILE_DIR_COLLISION", [i["code"] for i in r["findings"]])

    def test_zip_empty(self):
        p = self.dir / "source.zip"
        with zipfile.ZipFile(p, "w"):
            pass
        self.assertIn("EMPTY_ZIP", [x["code"] for x in core.inspect_zip(p, core.sha256_file(p))["findings"]])

    def test_zip_bomb_ratio(self):
        p = self.make_zip([("zeros.bin", b"0" * (2 * 1024 * 1024))], zipfile.ZIP_DEFLATED)
        self.assertIn("COMPRESSION_RATIO", [x["code"] for x in core.inspect_zip(p, core.sha256_file(p))["findings"]])

    def test_member_limit(self):
        p = self.make_zip([("a", b"x"), ("b", b"x")])
        with mock.patch.object(core, "MAX_MEMBERS", 1):
            self.assertIn("MEMBER_LIMIT", [x["code"] for x in core.inspect_zip(p, core.sha256_file(p))["findings"]])

    def test_member_size_limit(self):
        p = self.make_zip([("big", b"123")])
        with mock.patch.object(core, "MAX_MEMBER_BYTES", 2):
            self.assertIn("MEMBER_SIZE", [x["code"] for x in core.inspect_zip(p, core.sha256_file(p))["findings"]])

    def test_uncompressed_total_limit(self):
        p = self.make_zip([("big", b"123")])
        with mock.patch.object(core, "MAX_TOTAL_UNCOMPRESSED", 2):
            self.assertIn("TOTAL_SIZE", [x["code"] for x in core.inspect_zip(p, core.sha256_file(p))["findings"]])

    def test_zip_file_size_limit(self):
        p = self.make_zip([("big", b"123")])
        with mock.patch.object(core, "MAX_ZIP_BYTES", 2):
            self.assertIn("ARCHIVE_TYPE_OR_SIZE", [x["code"] for x in core.inspect_zip(p, core.sha256_file(p))["findings"]])

    def test_crc_tamper_detected(self):
        p = self.make_zip([("file", b"M182-UNIQUE-CONTENT")])
        blob = p.read_bytes()
        self.assertIn(b"M182-UNIQUE-CONTENT", blob)
        p.write_bytes(blob.replace(b"M182-UNIQUE-CONTENT", b"M182-CORRUPT-CONTNT", 1))
        r = core.inspect_zip(p, core.sha256_file(p))
        self.assertEqual(r["status"], "BLOCKED")
        self.assertIn("ARCHIVE_READ_ERROR", [i["code"] for i in r["findings"]])


class JSONAndBoard(FileInputs):
    def test_duplicate_json_keys_rejected(self):
        p = self.dir / "dup.json"
        p.write_text('{"tasks":[],"tasks":[]}', encoding="utf-8")
        self.assertIn("BOARD_MISSING_OR_INVALID", [i["code"] for i in core.verify_board(p)["findings"]])

    def test_invalid_json_rejected(self):
        p = self.dir / "bad.json"
        p.write_text("{", encoding="utf-8")
        self.assertEqual(core.verify_board(p)["status"], "BLOCKED")

    def test_invalid_root_rejected(self):
        self.assertEqual(core.verify_board(self.put("board.json", []))["status"], "BLOCKED")

    def test_missing_board_rejected(self):
        self.assertEqual(core.verify_board(self.dir / "missing.json")["status"], "BLOCKED")

    def test_valid_180_graph_local_structure(self):
        r = core.verify_board(self.put("board.json", board_fixture()))
        self.assertEqual((r["status"], r["edge_count"]), ("LOCAL_STRUCTURE_PASS", 294))

    def test_179_tasks_rejected(self):
        obj = board_fixture(); obj["tasks"].pop()
        self.assertEqual(core.verify_board(self.put("board.json", obj))["status"], "BLOCKED")

    def test_missing_dependencies_rejected(self):
        obj = board_fixture(); del obj["tasks"][40]["parents"]
        self.assertIn("BOARD_DEPENDENCIES", [i["code"] for i in core.verify_board(self.put("board.json", obj))["findings"]])

    def test_duplicate_task_id_rejected(self):
        obj = board_fixture(); obj["tasks"][1]["id"] = obj["tasks"][0]["id"]
        self.assertIn("BOARD_ID", [i["code"] for i in core.verify_board(self.put("board.json", obj))["findings"]])

    def test_unknown_parent_rejected(self):
        obj = board_fixture(); obj["tasks"][1]["parents"] = ["NONEXISTENT"]
        self.assertIn("BOARD_UNKNOWN_PARENT", [i["code"] for i in core.verify_board(self.put("board.json", obj))["findings"]])

    def test_self_parent_rejected(self):
        obj = board_fixture(); obj["tasks"][1]["parents"][0] = obj["tasks"][1]["id"]
        self.assertIn("BOARD_SELF_DEP", [i["code"] for i in core.verify_board(self.put("board.json", obj))["findings"]])

    def test_cycle_rejected(self):
        obj = board_fixture(); obj["tasks"][0]["parents"] = [obj["tasks"][179]["id"]]
        self.assertIn("BOARD_CYCLE", [i["code"] for i in core.verify_board(self.put("board.json", obj))["findings"]])

    def test_incorrect_edge_count_rejected(self):
        obj = board_fixture(); obj["tasks"][120]["parents"] = []
        self.assertIn("BOARD_EDGE_COUNT", [i["code"] for i in core.verify_board(self.put("board.json", obj))["findings"]])

    def test_wrong_team_rejected(self):
        obj = board_fixture(); obj["tasks"][0]["team"] = "FAKE_TEAM"
        self.assertIn("BOARD_TEAM", [i["code"] for i in core.verify_board(self.put("board.json", obj))["findings"]])

    def test_bad_team_distribution(self):
        obj = board_fixture(); obj["tasks"][30]["team"] = "TITAN"
        self.assertIn("BOARD_TEAM_COUNT", [i["code"] for i in core.verify_board(self.put("board.json", obj))["findings"]])

    def test_unknown_provenance_rejected(self):
        obj = board_fixture(); obj["source_authority"] = "PROVISIONAL_NOT_M181"
        self.assertIn("BOARD_ORIGIN", [i["code"] for i in core.verify_board(self.put("board.json", obj))["findings"]])

    def test_duplicate_parent_rejected(self):
        obj = board_fixture(); obj["tasks"][30]["parents"] = ["T-029", "T-029"]
        self.assertIn("BOARD_DEPENDENCIES", [i["code"] for i in core.verify_board(self.put("board.json", obj))["findings"]])

    def test_board_nonobject_task_rejected(self):
        obj = board_fixture(); obj["tasks"][0] = None
        self.assertIn("BOARD_TASK_TYPE", [i["code"] for i in core.verify_board(self.put("board.json", obj))["findings"]])


class ConflictChecks(FileInputs):
    def check(self, obj):
        return core.verify_conflicts(self.put("conflicts.json", obj))

    def test_no_file(self):
        self.assertEqual(core.verify_conflicts(self.dir / "x")["status"], "BLOCKED")

    def test_full_metadata_not_equal_independent_review(self):
        codes = [f["code"] for f in self.check(conflicts_fixture())["findings"]]
        self.assertEqual(codes, ["CONFLICT_ONLINE_REVIEW"])

    def test_missing_conflict(self):
        d=conflicts_fixture(); d["conflicts"].pop()
        self.assertIn("CONFLICT_CARDINALITY", [x["code"] for x in self.check(d)["findings"]])

    def test_severity_wrong(self):
        d=conflicts_fixture(); d["conflicts"][0]["severity"]="P1"
        self.assertIn("CONFLICT_CARDINALITY", [x["code"] for x in self.check(d)["findings"]])

    def test_missing_filepath(self):
        d=conflicts_fixture(); d["conflicts"][0]["path"]=None
        self.assertIn("CONFLICT_PATH", [x["code"] for x in self.check(d)["findings"]])

    def test_missing_hash(self):
        d=conflicts_fixture(); d["conflicts"][0]["left_sha256"]=None
        self.assertIn("CONFLICT_DIGEST", [x["code"] for x in self.check(d)["findings"]])

    def test_unresolved(self):
        d=conflicts_fixture(); d["conflicts"][0]["resolution"]="UNRESOLVED"
        self.assertIn("CONFLICT_UNRESOLVED", [x["code"] for x in self.check(d)["findings"]])

    def test_self_review_rejected(self):
        d=conflicts_fixture(); d["conflicts"][0]["reviewer"]="author"
        self.assertIn("CONFLICT_INDEPENDENCE", [x["code"] for x in self.check(d)["findings"]])

    def test_missing_review_commit(self):
        d=conflicts_fixture(); d["conflicts"][0]["review_commit_sha"]=None
        self.assertIn("CONFLICT_EXTERNAL_PROOF", [x["code"] for x in self.check(d)["findings"]])

    def test_duplicate_conflict_id(self):
        d=conflicts_fixture(); d["conflicts"][1]["id"]=d["conflicts"][0]["id"]
        self.assertIn("CONFLICT_ID", [x["code"] for x in self.check(d)["findings"]])


class ContractAndUpstreamChecks(FileInputs):
    def test_contracts_missing(self):
        self.assertEqual(core.verify_contracts(None)["status"], "BLOCKED")

    def test_contracts_full_metadata_still_block(self):
        r=core.verify_contracts(self.put("contracts.json", contracts_fixture()))
        self.assertEqual([x["code"] for x in r["findings"]], ["CONTRACT_EXTERNAL_E2E"])

    def test_contracts_count(self):
        d=contracts_fixture();d["contracts"].pop()
        r=core.verify_contracts(self.put("contracts.json", d))
        self.assertIn("CONTRACT_COUNT", [x["code"] for x in r["findings"]])

    def test_contracts_unpinned(self):
        d=contracts_fixture();d["contracts"][0]["schema_sha256"]="abc"
        r=core.verify_contracts(self.put("contracts.json", d))
        self.assertIn("CONTRACT_SCHEMA_PIN", [x["code"] for x in r["findings"]])

    def test_contracts_duplicate(self):
        d=contracts_fixture();d["contracts"][1]["id"]=d["contracts"][0]["id"]
        r=core.verify_contracts(self.put("contracts.json", d))
        self.assertIn("CONTRACT_ID", [x["code"] for x in r["findings"]])

    def test_upstreams_missing(self):
        self.assertEqual(core.verify_upstreams(None)["status"], "BLOCKED")

    def test_upstreams_metadata_still_requires_live_check(self):
        r=core.verify_upstreams(self.put("upstreams.json", upstreams_fixture()))
        self.assertEqual([x["code"] for x in r["findings"]], ["UPSTREAM_ONLINE_VERIFICATION"])

    def test_upstream_fake_repository(self):
        d=upstreams_fixture();d["teams"][0]["repository_url"]="https://evil.invalid/repo"
        r=core.verify_upstreams(self.put("upstreams.json", d))
        self.assertIn("UPSTREAM_UNRESOLVED", [x["code"] for x in r["findings"]])

    def test_upstream_fake_head(self):
        d=upstreams_fixture();d["teams"][0]["head_sha"]="short"
        r=core.verify_upstreams(self.put("upstreams.json", d))
        self.assertIn("UPSTREAM_HEAD_UNVERIFIED", [x["code"] for x in r["findings"]])

    def test_upstream_missing_owner(self):
        d=upstreams_fixture();d["teams"][0]["owner"]=""
        r=core.verify_upstreams(self.put("upstreams.json", d))
        self.assertIn("UPSTREAM_OWNER", [x["code"] for x in r["findings"]])

    def test_upstream_duplicate_team(self):
        d=upstreams_fixture();d["teams"][1]["team"]=d["teams"][0]["team"]
        r=core.verify_upstreams(self.put("upstreams.json", d))
        self.assertIn("UPSTREAM_DUPLICATE", [x["code"] for x in r["findings"]])

    def test_upstream_missing_team(self):
        d=upstreams_fixture();d["teams"].pop()
        r=core.verify_upstreams(self.put("upstreams.json", d))
        self.assertIn("UPSTREAM_TEAM_COUNT", [x["code"] for x in r["findings"]])


class CLIAndEvidence(FileInputs):
    def test_bootstrap_exact_quantities(self):
        filenames=bootstrap(self.dir / "out")
        self.assertEqual(len(filenames), 4)
        d=json.loads((self.dir/"out/TASK_BOARD_PROVISIONAL.json").read_text(encoding="utf-8"))
        self.assertEqual(len(d["tasks"]), 180)
        self.assertEqual(len({r["id"] for r in d["tasks"]}), 180)
        c=json.loads((self.dir/"out/CONFLICTS_PROVISIONAL.json").read_text(encoding="utf-8"))
        self.assertEqual(sum(r["severity"] == "P0" for r in c["conflicts"]), 17)
        self.assertEqual(len(c["conflicts"]), 28)
        self.assertEqual(len(json.loads((self.dir/"out/CONTRACTS_PROVISIONAL.json").read_text())["contracts"]), 9)
        self.assertEqual(len(json.loads((self.dir/"out/UPSTREAMS_PROVISIONAL.json").read_text())["teams"]), 6)

    def test_templates_do_not_pass_board(self):
        bootstrap(self.dir / "out")
        r=core.verify_board(self.dir / "out/TASK_BOARD_PROVISIONAL.json")
        self.assertEqual(r["status"], "BLOCKED")
        self.assertIn("BOARD_ORIGIN", [x["code"] for x in r["findings"]])

    def test_bootstrap_not_overwrite(self):
        bootstrap(self.dir / "out")
        with self.assertRaises(FileExistsError):
            bootstrap(self.dir / "out")

    def test_audit_missing_all_no_go(self):
        r=core.audit()
        self.assertEqual(r["release_decision"], "PRODUCTION_NO_GO")
        self.assertEqual(r["independently_accepted_tasks"], 0)
        self.assertGreaterEqual(len(r["blockers"]), 6)

    def test_audit_valid_metadata_still_no_go(self):
        p=self.make_zip()
        r=core.audit(archive=p, expected_sha256=core.sha256_file(p),
                     board=self.put("board.json", board_fixture()),
                     conflicts=self.put("conflicts.json", conflicts_fixture()),
                     contracts=self.put("contracts.json", contracts_fixture()),
                     upstreams=self.put("upstreams.json", upstreams_fixture()))
        self.assertEqual(r["checks"]["archive"]["status"], "LOCAL_VERIFIED")
        self.assertEqual(r["checks"]["task_board"]["status"], "LOCAL_STRUCTURE_PASS")
        self.assertEqual(r["release_decision"], "PRODUCTION_NO_GO")

    def test_dump_no_overwrite(self):
        p=self.dir/"evidence.json"
        core.dump_json(p, {"pass": False})
        with self.assertRaises(FileExistsError):
            core.dump_json(p, {"pass": True})
        self.assertEqual(json.loads(p.read_text()), {"pass": False})

    def test_markdown_has_no_go_and_blockers(self):
        md=to_markdown(core.audit())
        self.assertIn("PRODUCTION_NO_GO", md)
        self.assertIn("M181_ARCHIVE_MISSING", md)
        self.assertIn("INDEPENDENT_HUMAN_AND_STAGING_GATE", md)

    def test_cli_exit_no_go_code_two(self):
        with redirect_stdout(io.StringIO()):
            code=main(["audit", "--json-out", str(self.dir/"report.json"),
                       "--md-out", str(self.dir/"report.md")])
        self.assertEqual(code, 2)
        self.assertTrue((self.dir/"report.md").exists())

    def test_cli_exit_three_if_evidence_exists(self):
        (self.dir/"report.json").write_text("old",encoding="utf-8")
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code=main(["audit", "--json-out", str(self.dir/"report.json"),
                       "--md-out", str(self.dir/"report.md")])
        self.assertEqual(code, 3)
        self.assertEqual((self.dir/"report.json").read_text(), "old")

    def test_cli_bootstrap_status_zero(self):
        with redirect_stdout(io.StringIO()):
            code=main(["bootstrap", "--dir", str(self.dir/"new")])
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()

class PinnedArchiveDiff(FileInputs):
    def test_one_changed(self):
        a=self.make_zip([("app.py", b"one")])
        b=self.dir/"other.zip"
        with zipfile.ZipFile(b,"w") as z:
            z.writestr("app.py", b"two")
        r=core.compare_archives(a,b,core.sha256_file(a),core.sha256_file(b))
        self.assertEqual((r["status"],len(r["modified"])),("LOCAL_DIFF_ONLY",1))
        self.assertEqual(r["modified"][0]["path"],"app.py")

    def test_added_file(self):
        a=self.make_zip()
        b=self.dir/"other.zip"
        with zipfile.ZipFile(b,"w") as z:
            z.writestr("src/app.py",b"print(1)\n")
            z.writestr("src/added.py",b"X")
        r=core.compare_archives(a,b,core.sha256_file(a),core.sha256_file(b))
        self.assertEqual(len(r["added"]),1)
        self.assertEqual(r["unchanged"],1)

    def test_removed_file(self):
        a=self.make_zip([("one",b"1"),("two",b"2")])
        b=self.dir/"other.zip"
        with zipfile.ZipFile(b,"w") as z:
            z.writestr("one",b"1")
        r=core.compare_archives(a,b,core.sha256_file(a),core.sha256_file(b))
        self.assertEqual(len(r["removed"]),1)

    def test_both_pins_required(self):
        a=self.make_zip()
        b=self.dir/"other.zip"
        with zipfile.ZipFile(b,"w") as z:
            z.writestr("src/app.py",b"print(1)\n")
        r=core.compare_archives(a,b,core.sha256_file(a),"0"*64)
        self.assertEqual(r["status"],"BLOCKED")
        self.assertEqual(r["modified"],[])

    def test_traversal_in_one_archive_blocks_diff(self):
        a=self.make_zip([("../evil",b"A")])
        b=self.dir/"other.zip"
        with zipfile.ZipFile(b,"w") as z:
            z.writestr("safe",b"B")
        r=core.compare_archives(a,b,core.sha256_file(a),core.sha256_file(b))
        self.assertEqual(r["status"],"BLOCKED")

    def test_empty_untrusted_archive_blocks(self):
        a=self.make_zip()
        r=core.compare_archives(a,self.dir/"missing.zip",core.sha256_file(a),"a"*64)
        self.assertEqual(r["status"],"BLOCKED")

    def test_cli_compare_succeeds_as_local_diff_only(self):
        a=self.make_zip()
        b=self.dir/"other.zip"
        with zipfile.ZipFile(b,"w") as z:
            z.writestr("src/app.py",b"print(1)\n")
        with redirect_stdout(io.StringIO()):
            rc=main(["compare","--left",str(a),"--left-sha256",core.sha256_file(a),
                     "--right",str(b),"--right-sha256",core.sha256_file(b),
                     "--json-out",str(self.dir/"diff.json")])
        self.assertEqual(rc,0)
        self.assertEqual(json.loads((self.dir/"diff.json").read_text())["status"],"LOCAL_DIFF_ONLY")

    def test_cli_compare_bad_sha_exit_two(self):
        a=self.make_zip()
        with redirect_stdout(io.StringIO()):
            rc=main(["compare","--left",str(a),"--left-sha256",core.sha256_file(a),
                     "--right",str(a),"--right-sha256","f"*64,
                     "--json-out",str(self.dir/"diff.json")])
        self.assertEqual(rc,2)


class AdditionalAbuseCases(FileInputs):
    def test_bidi_invisible_name_rejected(self):
        self.assertFalse(core.safe_member_name("src/a\u202epy")[0])

    def test_json_symlink_rejected(self):
        target=self.put("real.json", board_fixture())
        sym=self.dir/"link.json"; sym.symlink_to(target)
        self.assertEqual(core.verify_board(sym)["status"], "BLOCKED")

    def test_conflict_severity_list_does_not_crash(self):
        c=conflicts_fixture(); c["conflicts"][0]["severity"]=["P0"]
        p=self.put("conflicts.json", c)
        r=core.verify_conflicts(p)
        self.assertIn("CONFLICT_SEVERITY", [x["code"] for x in r["findings"]])

    def test_conflict_bad_review_sha_rejected(self):
        c=conflicts_fixture(); c["conflicts"][0]["review_commit_sha"]="short"
        p=self.put("conflicts.json", c)
        r=core.verify_conflicts(p)
        self.assertIn("CONFLICT_EXTERNAL_PROOF", [x["code"] for x in r["findings"]])

    def test_conflict_non_github_review_rejected(self):
        c=conflicts_fixture(); c["conflicts"][0]["review_pr_url"]="https://untrusted.invalid/pull/1"
        p=self.put("conflicts.json", c)
        r=core.verify_conflicts(p)
        self.assertIn("CONFLICT_EXTERNAL_PROOF", [x["code"] for x in r["findings"]])

    def test_conflict_json_bad_object_rejected(self):
        c=conflicts_fixture(); c["conflicts"][0]=[]
        p=self.put("conflicts.json", c)
        r=core.verify_conflicts(p)
        self.assertIn("CONFLICT_TYPE", [x["code"] for x in r["findings"]])

    def test_contract_missing_evidence_rejected(self):
        c=contracts_fixture(); c["contracts"][0]["test_run_url"]=None
        r=core.verify_contracts(self.put("contracts.json", c))
        self.assertIn("CONTRACT_EVIDENCE", [x["code"] for x in r["findings"]])

    def test_upstream_unknown_team_no_acceptance(self):
        u=upstreams_fixture();u["teams"][0]["team"]="NOT_A_TEAM"
        r=core.verify_upstreams(self.put("upstreams.json", u))
        self.assertEqual(r["status"],"BLOCKED")

    def test_upstream_untrusted_json_symlink(self):
        u=self.put("upstreams.json", upstreams_fixture())
        sym=self.dir/"link.json";sym.symlink_to(u)
        self.assertEqual(core.verify_upstreams(sym)["status"],"BLOCKED")

    def test_archive_windows_reserved_entry(self):
        p=self.make_zip([("con.txt",b"X")])
        r=core.inspect_zip(p,core.sha256_file(p))
        self.assertIn("UNSAFE_PATH", [x["code"] for x in r["findings"]])
