#!/usr/bin/env python3
"""Run tests that do not require historical binary ZIP/bundle inputs.

This is intentionally not an equivalent substitute for the full M187 suite.
"""
import pathlib
import sys
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]
EXCLUDED={
    'test_bundle_still_missing_original_m180_m181',
}


def main():
    sys.path[:0]=[str(ROOT),str(ROOT/'tests')]
    suite=unittest.defaultTestLoader.discover(str(ROOT/'tests'),pattern='test_m187.py')
    cases=[]
    def walk(items):
        for item in items:
            if isinstance(item,unittest.TestSuite):
                walk(item)
            else:
                cases.append(item)
    walk(suite)
    missing=[x for x in cases if x._testMethodName in EXCLUDED]
    included=[x for x in cases if x._testMethodName not in EXCLUDED]
    if len(missing)!=1 or len(included)!=22:
        raise SystemExit('Unexpected test selection: '+str((len(missing),len(included))))
    print('SOURCE_ONLY: historical Git bundle test excluded (no local M186 bundle)',flush=True)
    result=unittest.TextTestRunner(verbosity=1).run(unittest.TestSuite(included))
    return int(not result.wasSuccessful())

if __name__=='__main__':
    raise SystemExit(main())
