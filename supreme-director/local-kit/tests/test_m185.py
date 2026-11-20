"""M185 actual signed local review end-to-end and fail-closed tests."""
from __future__ import annotations
import base64
from contextlib import closing
import hashlib
import http.client
import json
from pathlib import Path
import os
import sqlite3
import tempfile
import threading
import unittest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from osgard_m184.storage import DirectorDB, encode
from osgard_m185.review import ReviewDB, safe_evidence, validate_registry, validate_local_vote
from osgard_m185.cli import offline_sign
from osgard_m185.api import serve
BASE = Path(__file__).resolve().parents[1]


class ReviewFixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "private-evidence"
        self.root.mkdir(mode=0o700)
        self.dbpath = self.base / "director.sqlite3"
        self.private = Ed25519PrivateKey.generate()
        self.public = base64.b64encode(self.private.public_key().public_bytes(
            serialization.Encoding.Raw,serialization.PublicFormat.Raw)).decode()
        self.registry = self.base / "trusted.json"
        self.registry.write_text(json.dumps({"schema":"osgard.m185.trusted-reviewers/1","reviewers":[
            {"id":"auditor-remote", "role":"SECURITY_REVIEWER", "ed25519_public_key_b64":self.public}]}))
        DirectorDB(self.dbpath).bootstrap(BASE/"docs/M182_WORKPLAN_180_PROPOSED.json",
             BASE/"templates/CONFLICTS_PROVISIONAL.json",BASE/"templates/CONTRACTS_PROVISIONAL.json")
        self.db = ReviewDB(self.dbpath,self.root)
        self.db.review_bootstrap(self.registry)
        self.asset = self.root/"synthetic-manifest.json"
        self.asset.write_text('{"synthetic":true,"production":false}')
        self.digest = hashlib.sha256(self.asset.read_bytes()).hexdigest()
        self.evidence_id = self.db.register_evidence("M181-CONFLICT-01",self.asset.name,self.digest,"author-local")["id"]

    def case(self, proposer="author-local"):
        return self.db.create_case(self.evidence_id,proposer,"Review local synthetic manifest, not canonical source")["case_id"]

    def vote(self, case, verdict="PASS_LOCAL_EVIDENCE", reason="Synthetic local evidence matches SHA"):
        return self.db.challenge(case,"auditor-remote",verdict,reason)

    def sign(self, payload):
        return base64.b64encode(self.private.sign(encode(payload).encode("utf8"))).decode()


class ReviewUnitTests(ReviewFixture, unittest.TestCase):
    def test_initialize(self):
        d=self.db.doctor();self.assertEqual(d["health"],"LOCAL_INTEGRITY_PASS")
        self.assertEqual(self.db.summary()["independent_acceptance"],0)

    def test_happy_path_signed_vote_and_integrity(self):
        case=self.case();payload=self.vote(case)
        result=self.db.submit(case,"auditor-remote",payload["verdict"],payload["reason"],self.sign(payload))
        self.assertEqual(result["state"],"SIGNED_LOCAL_REVIEW")
        self.assertFalse(result["production_authorized"])
        self.assertFalse(result["independent_product_acceptance"])
        self.assertEqual(self.db.summary()["signed_local_reviews"],1)
        self.assertEqual(self.db.summary()["independent_acceptance"],0)
        self.assertEqual(self.db.doctor()["health"],"LOCAL_INTEGRITY_PASS")
        self.assertEqual(self.db.conflicts()[0]["status"],"UNRESOLVED")

    def test_review_does_not_mark_tasks_accepted(self):
        case=self.case();p=self.vote(case)
        self.db.submit(case,"auditor-remote",p["verdict"],p["reason"],self.sign(p))
        self.assertEqual({x['status'] for x in self.db.tasks()}, {'NOT_ACCEPTED'})
        self.assertEqual({x['status'] for x in self.db.contracts()},{'UNVERIFIED'})

    def test_reviewer_can_reject(self):
        case=self.case();p=self.vote(case,"REJECT_EVIDENCE","Documentation insufficient")
        self.assertEqual(self.db.submit(case,"auditor-remote",p["verdict"],p["reason"],self.sign(p))["verdict"],"REJECT_EVIDENCE")

    def test_reviewer_can_request_changes(self):
        case=self.case();p=self.vote(case,"REQUEST_CHANGES","Need independent source")
        self.assertEqual(self.db.submit(case,"auditor-remote",p["verdict"],p["reason"],self.sign(p))["verdict"],"REQUEST_CHANGES")

    def test_self_review_refused(self):
        case=self.case(proposer="auditor-remote")
        with self.assertRaises(ValueError):self.vote(case)

    def test_case_requires_registered_evidence(self):
        with self.assertRaises(ValueError):self.db.create_case(999999,"author-local","Proof")

    def test_missing_artifact_refused(self):
        self.asset.unlink()
        with self.assertRaises((ValueError,OSError)):self.case()

    def test_changed_artifact_refused_at_review(self):
        case=self.case();p=self.vote(case)
        self.asset.write_text("changed")
        with self.assertRaises(ValueError):self.db.submit(case,"auditor-remote",p["verdict"],p["reason"],self.sign(p))
        self.assertIn('REVIEW_CASE_EVIDENCE_CHANGED_OR_MISSING',self.db.doctor()['findings'])

    def test_changed_artifact_refused_at_challenge(self):
        case=self.case();self.asset.write_text('changed')
        with self.assertRaises(ValueError):self.vote(case)

    def test_forged_signature_refused(self):
        c=self.case();p=self.vote(c)
        for bad in [base64.b64encode(bytes(64)).decode(),base64.b64encode(Ed25519PrivateKey.generate().sign(encode(p).encode())).decode()]:
            with self.subTest(bad=bad[:10]),self.assertRaises(ValueError):
                self.db.submit(c,'auditor-remote',p['verdict'],p['reason'],bad)

    def test_signature_wrong_verdict_refused(self):
        c=self.case();p=self.vote(c)
        with self.assertRaises(ValueError):self.db.submit(c,'auditor-remote','REJECT_EVIDENCE',p['reason'],self.sign(p))

    def test_signature_wrong_reason_refused(self):
        c=self.case();p=self.vote(c)
        with self.assertRaises(ValueError):self.db.submit(c,'auditor-remote',p['verdict'],'changed reason',self.sign(p))

    def test_signature_wrong_case_refused(self):
        c=self.case();d=self.case();p=self.vote(c)
        with self.assertRaises(ValueError):self.db.submit(d,'auditor-remote',p['verdict'],p['reason'],self.sign(p))

    def test_replay_refused(self):
        c=self.case();p=self.vote(c);sig=self.sign(p)
        self.db.submit(c,'auditor-remote',p['verdict'],p['reason'],sig)
        with self.assertRaises(ValueError):self.db.submit(c,'auditor-remote',p['verdict'],p['reason'],sig)

    def test_signatures_checked_by_doctor(self):
        c=self.case();p=self.vote(c);self.db.submit(c,'auditor-remote',p['verdict'],p['reason'],self.sign(p))
        with closing(sqlite3.connect(self.dbpath)) as con:
            con.execute('DROP TRIGGER m185_decisions_no_update')
            con.execute("UPDATE m185_decisions SET signature_b64=? WHERE case_id=?",(base64.b64encode(bytes(64)).decode(),c))
            con.commit()
        self.assertIn('REVIEW_SIGNATURE_INVALID', self.db.doctor()['findings'])

    def test_registered_evidence_is_immutable(self):
        with closing(sqlite3.connect(self.dbpath)) as con:
            with self.assertRaises(sqlite3.IntegrityError):
                con.execute('UPDATE evidence SET sha256=? WHERE id=?',('0'*64,self.evidence_id))
            with self.assertRaises(sqlite3.IntegrityError):
                con.execute('DELETE FROM evidence WHERE id=?',(self.evidence_id,))

    def test_review_tampered_evidence_reference_refused(self):
        c=self.case();p=self.vote(c)
        with closing(sqlite3.connect(self.dbpath)) as con:
            con.execute('DROP TRIGGER m185_evidence_no_update')
            con.execute('UPDATE evidence SET sha256=? WHERE id=?',('0'*64,self.evidence_id))
            con.commit()
        with self.assertRaises(ValueError):
            self.db.submit(c,'auditor-remote',p['verdict'],p['reason'],self.sign(p))

    def test_signed_vote_is_immutable(self):
        c=self.case();p=self.vote(c);self.db.submit(c,'auditor-remote',p['verdict'],p['reason'],self.sign(p))
        with closing(sqlite3.connect(self.dbpath)) as con:
            with self.assertRaises(sqlite3.IntegrityError):con.execute('DELETE FROM m185_decisions WHERE case_id=?',(c,))
            with self.assertRaises(sqlite3.IntegrityError):con.execute('UPDATE m185_cases SET proposer=? WHERE id=?',('evil',c))

    def test_trust_registry_pin_refuses_change(self):
        obj=json.loads(self.registry.read_text());obj['reviewers']=[]
        self.registry.write_text(json.dumps(obj))
        with self.assertRaises(ValueError):self.db.review_bootstrap(self.registry)

    def test_idempotent_trust_setup(self):
        self.assertEqual(self.db.review_bootstrap(self.registry)['status'],'IDEMPOTENT')

    def test_no_trust_key_disables_votes(self):
        with closing(sqlite3.connect(self.dbpath)) as con:
            # This simulates a database with no enrolled reviewers, not a production bypass.
            con.execute('DROP TRIGGER m185_reviewers_no_delete')
            con.execute('DELETE FROM m185_reviewers');con.commit()
        with self.assertRaises(ValueError):self.vote(self.case())

    def test_trust_key_not_private(self):
        self.assertNotIn('private',json.dumps(self.db.trustees()).lower())
        self.assertNotIn('ed25519_public_key_b64',json.dumps(self.db.trustees()))

    def test_actor_reviewer_name_casefold(self):
        with self.assertRaises(ValueError):self.db.create_case(self.evidence_id,'Оператор','No unicode reviewer identity')

    def test_no_trust_attestation_without_key(self):
        obj={"schema":"osgard.m185.trusted-reviewers/1","reviewers":[]}
        self.assertEqual(validate_registry(obj),[])

    def test_registry_duplicate_name(self):
        obj=json.loads(self.registry.read_text());obj['reviewers'].append({**obj['reviewers'][0],"id":"AUDITOR-REMOTE"})
        with self.assertRaises(ValueError):validate_registry(obj)

    def test_registry_duplicate_public_key(self):
        obj=json.loads(self.registry.read_text());obj['reviewers'].append({**obj['reviewers'][0],"id":"different-person"})
        with self.assertRaises(ValueError):validate_registry(obj)

    def test_registry_disallowed_role(self):
        obj=json.loads(self.registry.read_text());obj['reviewers'][0]['role']='ADMIN'
        with self.assertRaises(ValueError):validate_registry(obj)

    def test_registry_extra_keys_refused(self):
        obj=json.loads(self.registry.read_text());obj['reviewers'][0]['admin']=True
        with self.assertRaises(ValueError):validate_registry(obj)

    def test_vote_authority_lie_refused(self):
        p=self.vote(self.case());p['production_authorized']=True
        with self.assertRaises(ValueError):validate_local_vote(p)

    def test_vote_scope_lie_refused(self):
        p=self.vote(self.case());p['scope']='PRODUCTION'
        with self.assertRaises(ValueError):validate_local_vote(p)

    def test_evidence_path_traversal_refused(self):
        with self.assertRaises(ValueError):safe_evidence(self.root,'../outside',self.digest)

    def test_evidence_absolute_path_refused(self):
        with self.assertRaises(ValueError):safe_evidence(self.root,str(self.asset),self.digest)

    def test_evidence_symlink_refused(self):
        (self.root/'link').symlink_to(self.asset)
        with self.assertRaises(ValueError):safe_evidence(self.root,'link',self.digest)

    def test_evidence_empty_refused(self):
        (self.root/'empty').write_bytes(b'')
        with self.assertRaises(ValueError):safe_evidence(self.root,'empty',hashlib.sha256(b'').hexdigest())

    def test_evidence_sha_mismatch_refused(self):
        with self.assertRaises(ValueError):safe_evidence(self.root,self.asset.name,'0'*64)

    def test_unsafe_case_input_refused(self):
        with self.assertRaises(ValueError):self.db.create_case(True,'author-local','invalid evidence id')
        with self.assertRaises(ValueError):self.db.create_case(self.evidence_id,'author-local','')

    def test_unsupported_verdict_refused(self):
        with self.assertRaises(ValueError):self.db.challenge(self.case(),'auditor-remote','PRODUCTION_GO','bad')

    def test_unknown_reviewer_refused(self):
        with self.assertRaises(ValueError):self.db.challenge(self.case(),'random-reviewer','REJECT_EVIDENCE','Reason')

    def test_bad_signature_encoding_refused(self):
        c=self.case()
        for s in ['garbage',base64.b64encode(bytes(10)).decode(),'']:
            with self.subTest(s=s), self.assertRaises(ValueError):
                self.db.submit(c,'auditor-remote','REJECT_EVIDENCE','Reason',s)

    def test_doctor_detects_fake_production(self):
        with closing(sqlite3.connect(self.dbpath)) as con:
            con.execute("UPDATE meta SET value='true' WHERE key='m185_production_approval'");con.commit()
        self.assertEqual(self.db.doctor()['health'],'LOCAL_INTEGRITY_FAIL')

    def test_offline_sign_roundtrip(self):
        p=self.vote(self.case());ch=self.base/'challenge.json';ch.write_text(json.dumps(p))
        pem=self.base/'reviewer.pem';pem.write_bytes(self.private.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        os.chmod(pem,0o600)
        out=self.base/'signed.json'
        result=offline_sign(ch,pem,out)
        self.assertFalse(result['production_authorized'])
        v=json.loads(out.read_text());self.assertEqual(v['challenge'],p)
        self.assertEqual(self.db.submit(p['case_id'],'auditor-remote',p['verdict'],p['reason'],v['signature_b64'])['state'],'SIGNED_LOCAL_REVIEW')

    def test_offline_sign_refuses_wrong_key(self):
        p=self.vote(self.case());ch=self.base/'ch.json';ch.write_text(json.dumps(p))
        other=Ed25519PrivateKey.generate();pem=self.base/'other.pem'
        pem.write_bytes(other.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));os.chmod(pem,0o600)
        with self.assertRaises(ValueError):offline_sign(ch,pem,self.base/'vote.json')

    def test_offline_sign_refuses_overwrite(self):
        p=self.vote(self.case());ch=self.base/'ch.json';ch.write_text(json.dumps(p))
        pem=self.base/'key.pem';pem.write_bytes(self.private.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));os.chmod(pem,0o600)
        out=self.base/'vote.json';out.write_text('old')
        with self.assertRaises(ValueError):offline_sign(ch,pem,out)
        self.assertEqual(out.read_text(),'old')

    def test_multiple_independent_cases(self):
        c1=self.case();c2=self.case();self.assertNotEqual(c1,c2)
        self.assertEqual(len(self.db.cases()),2)


class HTTPReviewTests(ReviewFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.token = 'test-only-token-abcdefghijklmnopqrstuvwxyz'
        self.http, _ = serve(self.dbpath,self.root,BASE/'dashboard/m185',port=0,token=self.token)
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(self.shutdown)

    def shutdown(self):
        self.http.shutdown();self.http.server_close();self.thread.join(timeout=2)

    def request(self,path,method='GET',body=None,token=True,origin=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=6)
        headers={'Host':f'127.0.0.1:{self.http.server_port}'}
        if token:headers['Authorization']='Bearer '+self.token
        if origin:headers['Origin']=origin
        if body is not None:
            headers['Content-Type']='application/json';body=json.dumps(body)
        conn.request(method,path,body=body,headers=headers)
        resp=conn.getresponse();code=resp.status;content=resp.read();conn.close()
        return code,json.loads(content.decode())

    def test_read_cases_authorized(self):
        self.assertEqual(self.request('/api/v1/reviews/cases')[0],200)

    def test_missing_token_denied(self):
        self.assertEqual(self.request('/api/v1/reviews/cases',token=False)[0],401)

    def test_external_origin_denied(self):
        self.assertEqual(self.request('/api/v1/reviews/cases',origin='https://attacker.example')[0],403)

    def test_remote_review_without_signature_denied(self):
        c=self.case()
        status,_=self.request('/api/v1/reviews/submit','POST',{'case_id':c,'reviewer_id':'auditor-remote',
              'verdict':'REJECT_EVIDENCE','reason':'Insufficient evidence','signature_b64':'bad'})
        self.assertEqual(status,400)

    def test_case_http_roundtrip(self):
        status,r=self.request('/api/v1/reviews/cases','POST',{'evidence_id':self.evidence_id,
            'proposer':'author-local','description':'Review a synthetic test record'})
        self.assertEqual(status,201)
        c=r['data']['case_id']
        status,ch=self.request('/api/v1/reviews/challenge','POST',{'case_id':c,'reviewer_id':'auditor-remote',
            'verdict':'PASS_LOCAL_EVIDENCE','reason':'Synthetic evidence bytes match SHA'})
        self.assertEqual(status,200)
        p=ch['data'];self.assertFalse(p['independent_product_acceptance'])
        status,sub=self.request('/api/v1/reviews/submit','POST',{'case_id':c,'reviewer_id':'auditor-remote',
            'verdict':p['verdict'],'reason':p['reason'],'signature_b64':self.sign(p)})
        self.assertEqual(status,201)
        self.assertEqual(sub['data']['state'],'SIGNED_LOCAL_REVIEW')
        self.assertEqual(self.request('/api/v1/doctor')[1]['data']['health'],'LOCAL_INTEGRITY_PASS')

    def test_production_route_missing(self):
        status,_=self.request('/api/v1/release/approve','POST',{'approved':True})
        self.assertEqual(status,404)

    def test_review_no_owner_key_enrollment_route(self):
        status,_=self.request('/api/v1/reviews/reviewers','POST',{'id':'self','private':'key'})
        self.assertEqual(status,404)


if __name__ == '__main__':unittest.main()

class TrustProvisioningTests(ReviewFixture, unittest.TestCase):
    def _empty(self):
        self.base_db = self.base/'initial-empty.sqlite3'
        DirectorDB(self.base_db).bootstrap(BASE/'docs/M182_WORKPLAN_180_PROPOSED.json',
             BASE/'templates/CONFLICTS_PROVISIONAL.json', BASE/'templates/CONTRACTS_PROVISIONAL.json')
        empty_file=self.base/'empty-trust.json'
        empty_file.write_text(json.dumps({'schema':'osgard.m185.trusted-reviewers/1','reviewers':[]}))
        review=ReviewDB(self.base_db,self.root)
        result=review.review_bootstrap(empty_file)
        return review,result['trust_sha256']

    def test_provision_once_from_empty(self):
        review,previous=self._empty()
        r=review.provision_trust(self.registry,previous)
        self.assertEqual(r['trusted_reviewers'],1)
        self.assertEqual(review.doctor()['health'],'LOCAL_INTEGRITY_PASS')
        self.assertEqual(review.summary()['independent_acceptance'],0)

    def test_provision_requires_exact_old_pin(self):
        review,_=self._empty()
        with self.assertRaises(ValueError):review.provision_trust(self.registry,'0'*64)
        self.assertEqual(review.trustees(),[])

    def test_provision_refuses_second_time(self):
        review,previous=self._empty();review.provision_trust(self.registry,previous)
        with self.assertRaises(ValueError):review.provision_trust(self.registry,previous)

    def test_provision_refuses_when_case_exists(self):
        review,previous=self._empty()
        id=review.register_evidence('platform',self.asset.name,self.digest,'author-local')['id']
        review.create_case(id,'author-local','Existing pending case')
        with self.assertRaises(ValueError):review.provision_trust(self.registry,previous)
