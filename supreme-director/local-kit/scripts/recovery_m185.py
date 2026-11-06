"""Synthetic SQLite signed-review restore drill, same evidence root, no second host."""
from __future__ import annotations
import base64
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE))
from osgard_m184.storage import DirectorDB,encode
from osgard_m185.review import ReviewDB

def run():
    with tempfile.TemporaryDirectory() as folder:
        root=Path(folder);evidence=root/'evidence';evidence.mkdir()
        primary=root/'primary.sqlite3';restored=root/'restored.sqlite3'
        DirectorDB(primary).bootstrap(BASE/'docs/M182_WORKPLAN_180_PROPOSED.json',
            BASE/'templates/CONFLICTS_PROVISIONAL.json',BASE/'templates/CONTRACTS_PROVISIONAL.json')
        private=Ed25519PrivateKey.generate();pub=private.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)
        registry=root/'trust.json';registry.write_text(json.dumps({
            'schema':'osgard.m185.trusted-reviewers/1','reviewers':[{
            'id':'disaster-reviewer','role':'QA_REVIEWER',
            'ed25519_public_key_b64':base64.b64encode(pub).decode()}]}))
        db=ReviewDB(primary,evidence);db.review_bootstrap(registry)
        file=evidence/'synthetic.txt';file.write_bytes(b'OSGARD M185 synthetic recovery bytes; NOT SOURCE')
        target_hash=hashlib.sha256(file.read_bytes()).hexdigest()
        ev=db.register_evidence('platform',file.name,target_hash,'source-engineer')['id']
        case=db.create_case(ev,'source-engineer','Synthetic recovery exercise only')['case_id']
        vote=db.challenge(case,'disaster-reviewer','PASS_LOCAL_EVIDENCE','Only the synthetic byte digest is checked')
        signature=base64.b64encode(private.sign(encode(vote).encode())).decode()
        db.submit(case,'disaster-reviewer',vote['verdict'],vote['reason'],signature)
        with closing(sqlite3.connect(primary)) as source,closing(sqlite3.connect(restored)) as dest:
            source.backup(dest)
        recovered=ReviewDB(restored,evidence)
        okay=recovered.doctor()
        before=recovered.summary()
        file.write_bytes(b'ATTACK: changed synthetic content')
        bad=recovered.doctor()
        file.write_bytes(b'OSGARD M185 synthetic recovery bytes; NOT SOURCE')
        after=recovered.doctor()
        report={'schema':'osgard.m185.synthetic-recovery/1',
           'database_recovered_from_online_backup': True,
           'signed_vote_preserved':before['signed_local_reviews']==1,
           'signed_vote_originally_created_with_ephemeral_test_key':True,
           'healthy_after_restore':okay['health']=='LOCAL_INTEGRITY_PASS',
           'tamper_detected':'REVIEW_CASE_EVIDENCE_CHANGED_OR_MISSING' in bad['findings'],
           'healthy_after_byte_restore':after['health']=='LOCAL_INTEGRITY_PASS',
           'production_authorized':False,'independent_product_approval':False,
           'second_host_executed':False,'actual_m181_archive_examined':False}
        result=all([report['signed_vote_preserved'],report['healthy_after_restore'],report['tamper_detected'],report['healthy_after_byte_restore']])
        out=BASE/'evidence/m185/SYNTHETIC_RECOVERY_RESULT.json'
        out.write_text(json.dumps(report,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
        print(json.dumps({'pass':result,'report':str(out)}))
        return 0 if result else 2

if __name__=='__main__':raise SystemExit(run())
