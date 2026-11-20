import importlib.util
import pathlib
import unittest

PATH = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "validate_plan.py"
spec = importlib.util.spec_from_file_location("m187_plan_validation", PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class OriginalPlanIntegrityTests(unittest.TestCase):
    def test_original_sha_and_180_tasks(self):
        result = module.validate()
        self.assertEqual(result["result"], "PASS")
        self.assertEqual(result["tasks"], 180)
        self.assertEqual(result["original_tasks_accepted"], 0)
    def test_six_teams(self):
        self.assertEqual(set(module.validate()["teams"]), set(module.TEAMS))
        self.assertTrue(all(v == 30 for v in module.validate()["teams"].values()))
    def test_dependencies_and_priorities(self):
        result = module.validate()
        self.assertEqual(result["dependency_references"], 294)
        self.assertEqual(result["priorities"], {"P0": 60, "P1": 90, "P2": 30})
    def test_no_production_claims(self):
        self.assertIs(module.validate()["production_release_authorized"], False)

if __name__ == "__main__":
    unittest.main()
