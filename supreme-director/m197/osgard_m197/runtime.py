"""M197: documents, commitments and delivery health for the local Director.

Extends the transaction, tenant isolation, role checks and idempotency in M196.
A local project document is NOT a customer-signed or externally approved artifact.
No network, AI, outbound messaging, payments or production deployment occurs.
"""
from __future__ import annotations

import base64
import binascii
from collections import Counter
from hashlib import sha256
import json

from osgard_m192.runtime import (ROLES, KEY_RE, Invalid, Unauthorized, Conflict,
    canonical, _secret_hash, _uid, _text, _object, _identifier)
from osgard_m193.runtime import _version
from osgard_m195.runtime import _due
from osgard_m196.runtime import Director196, _project, _stage, _project_edit, _record_project

DOC_MIMES = frozenset(('text/plain', 'text/markdown', 'application/pdf'))
DOC_MAX_BYTES = 48 * 1024  # Fits parent API's 128 KiB JSON request cap.
OPS197 = {
    'commerce.projects.card': ROLES,
    'commerce.projects.documents.list': ROLES,
    'commerce.projects.documents.add': {'owner', 'operator'},
    'commerce.projects.documents.revise': {'owner', 'operator'},
    'commerce.projects.documents.content': {'owner', 'operator'},
    'commerce.projects.obligations.list': ROLES,
    'commerce.projects.obligations.add': {'owner', 'operator'},
    'commerce.projects.obligations.resolve': {'owner', 'operator'},
    'commerce.projects.health': ROLES,
}
WRITES197 = frozenset((
    'commerce.projects.documents.add', 'commerce.projects.documents.revise',
    'commerce.projects.obligations.add', 'commerce.projects.obligations.resolve',
))


def _document_bytes(payload, mime):
    if not isinstance(payload, str) or len(payload) > 4 * ((DOC_MAX_BYTES + 2) // 3):
        raise Invalid('document content must be base64 and at most 48 KiB')
    try:
        data = base64.b64decode(payload, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise Invalid('invalid base64 document') from exc
    if not data or len(data) > DOC_MAX_BYTES:
        raise Invalid('document bytes must be 1..49152')
    if mime == 'application/pdf' and not data.startswith(b'%PDF-'):
        raise Invalid('PDF magic header missing')
    if mime != 'application/pdf':
        try:
            data.decode('utf-8')
        except UnicodeDecodeError as exc:
            raise Invalid('text documents must be UTF-8') from exc
    return data


def _filename(value):
    result = _text(value, 'filename', 120)
    if result.startswith('.') or '/' in result or '\\' in result or ':' in result:
        raise Invalid('unsafe document name')
    if result in ('.', '..'):
        raise Invalid('unsafe document name')
    return result


def _check_editable(identity, project):
    _project_edit(identity, project)
    if project['state'] in ('completed', 'cancelled'):
        raise Conflict('closed project is read-only')


def _doc(db, tenant, project, document_id):
    _identifier(document_id, 'document id')
    row = db.execute('''SELECT * FROM delivery_documents
        WHERE tenant_id=? AND project_id=? AND id=?''', (tenant, project, document_id)).fetchone()
    if row is None:
        raise Invalid('document not found')
    return row


def _obligation(db, tenant, project, obligation_id):
    _identifier(obligation_id, 'obligation id')
    row = db.execute('''SELECT * FROM delivery_obligations
        WHERE tenant_id=? AND project_id=? AND id=?''',
        (tenant, project, obligation_id)).fetchone()
    if row is None:
        raise Invalid('obligation not found')
    return row


def _summary(db, tenant, project_id, now):
    stages = list(db.execute('''SELECT id, status, title, due_at FROM delivery_stages
         WHERE tenant_id=? AND project_id=? ORDER BY rank''', (tenant, project_id)))
    obligations = list(db.execute('''SELECT status,due_at FROM delivery_obligations
         WHERE tenant_id=? AND project_id=?''', (tenant, project_id)))
    stages_late = sum(s['status'] != 'done' and s['due_at'] is not None and
                      s['due_at'] < now for s in stages)
    open_obligations = sum(o['status'] == 'open' for o in obligations)
    overdue_obligations = sum(o['status'] == 'open' and o['due_at'] is not None and
                              o['due_at'] < now for o in obligations)
    documents = db.execute('''SELECT COUNT(*) AS n FROM delivery_documents
        WHERE tenant_id=? AND project_id=?''', (tenant, project_id)).fetchone()['n']
    return {'stages_total': len(stages),
            'stages_done': sum(s['status'] == 'done' for s in stages),
            'overdue_stages': stages_late,
            'obligations_total': len(obligations),
            'open_obligations': open_obligations,
            'overdue_obligations': overdue_obligations,
            'documents_total': documents,
            'calculated_at': now,
            'status': 'AT_RISK' if stages_late or overdue_obligations else
                      'OPEN_COMMITMENTS' if open_obligations else 'ON_TRACK',
            'independent_customer_acceptance': False,
            'data_source': 'LOCAL_SQLITE_ONLY'}


class Director197(Director196):
    """Additive SQLite schema: no changes to preceding M192–M196 tables."""
    def initialize(self):
        super().initialize()
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS delivery_documents (
                    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
                    project_id TEXT NOT NULL REFERENCES delivery_projects(id),
                    name TEXT NOT NULL, mime TEXT NOT NULL,
                    version INTEGER NOT NULL CHECK(version>=1),
                    created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS delivery_documents_project
                    ON delivery_documents(tenant_id,project_id,updated_at,id);
                CREATE TABLE IF NOT EXISTS delivery_document_versions (
                    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
                    document_id TEXT NOT NULL REFERENCES delivery_documents(id),
                    version INTEGER NOT NULL CHECK(version>=1),
                    content BLOB NOT NULL, sha256 TEXT NOT NULL,
                    byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 49152),
                    author TEXT NOT NULL, created_at INTEGER NOT NULL,
                    PRIMARY KEY(tenant_id,document_id,version));
                CREATE INDEX IF NOT EXISTS delivery_document_versions_project
                    ON delivery_document_versions(tenant_id,project_id,document_id,version);
                CREATE TRIGGER IF NOT EXISTS delivery_doc_versions_no_update
                    BEFORE UPDATE ON delivery_document_versions
                    BEGIN SELECT RAISE(ABORT,'document versions are immutable'); END;
                CREATE TRIGGER IF NOT EXISTS delivery_doc_versions_no_delete
                    BEFORE DELETE ON delivery_document_versions
                    BEGIN SELECT RAISE(ABORT,'document versions are immutable'); END;
                CREATE TABLE IF NOT EXISTS delivery_obligations (
                    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
                    project_id TEXT NOT NULL REFERENCES delivery_projects(id),
                    stage_id TEXT REFERENCES delivery_stages(id),
                    title TEXT NOT NULL, due_at INTEGER,
                    status TEXT NOT NULL CHECK(status IN ('open','fulfilled','waived')),
                    version INTEGER NOT NULL CHECK(version>=1),
                    created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
                    evidence_sha256 TEXT, waiver_reason TEXT,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    resolved_at INTEGER);
                CREATE INDEX IF NOT EXISTS delivery_obligations_project
                    ON delivery_obligations(tenant_id,project_id,status,due_at);
                CREATE TRIGGER IF NOT EXISTS delivery_m197_no_close_stage
                    BEFORE UPDATE OF status ON delivery_stages
                    WHEN NEW.status='done' AND OLD.status!='done' AND EXISTS (
                      SELECT 1 FROM delivery_obligations o
                      WHERE o.tenant_id=NEW.tenant_id AND o.stage_id=NEW.id
                        AND o.project_id=NEW.project_id AND o.status='open')
                    BEGIN SELECT RAISE(ABORT,'stage has open client obligations'); END;
                CREATE TRIGGER IF NOT EXISTS delivery_m197_no_close_project
                    BEFORE UPDATE OF state ON delivery_projects
                    WHEN NEW.state='completed' AND OLD.state!='completed' AND EXISTS (
                      SELECT 1 FROM delivery_obligations o
                      WHERE o.tenant_id=NEW.tenant_id AND o.project_id=NEW.id
                        AND o.status='open')
                    BEGIN SELECT RAISE(ABORT,'project has open client obligations'); END;
            ''')

    def execute(self, token, op, payload, idem_key=None):
        if op not in OPS197:
            return super().execute(token, op, payload, idem_key)
        if not isinstance(payload, dict):
            raise Invalid('payload must be an object')
        writing = op in WRITES197
        if writing and (not isinstance(idem_key, str) or not KEY_RE.fullmatch(idem_key)):
            raise Invalid('write operation requires idempotency key')
        with self.connect(transaction=True) as db:
            identity = self._identity(db, token)
            if identity['role'] not in OPS197[op]:
                raise Unauthorized('permission denied')
            tenant = identity['tenant_id']
            if writing:
                try:
                    request_hash = _secret_hash(canonical({'op':op,'payload':payload}))
                except (ValueError, TypeError) as exc:
                    raise Invalid('non-JSON request data') from exc
                original = db.execute('''SELECT op, request_sha, response_json FROM requests
                    WHERE tenant_id=? AND idem_key=?''', (tenant,idem_key)).fetchone()
                if original:
                    if original['op'] != op or original['request_sha'] != request_hash:
                        raise Conflict('idempotency key reused for different request')
                    return json.loads(original['response_json'])
            result = self._apply_197(db, identity, op, payload)
            if writing:
                db.execute('INSERT INTO requests VALUES (?,?,?,?,?)',
                           (tenant,idem_key,op,request_hash,canonical(result)))
                db.execute('''INSERT INTO audit(tenant_id,actor,operation,request_sha,recorded_at)
                    VALUES (?,?,?,?,?)''', (tenant, identity['actor'],op,request_hash,self.clock()))
            return result

    def _apply_196(self, db, identity, op, payload):
        # These checks share the SAME BEGIN IMMEDIATE transaction as the M196 write.
        if op in ('commerce.projects.status', 'commerce.projects.stage.status'):
            if payload.get('state') == 'completed':
                project = _project(db,identity['tenant_id'],payload['project_id'])
                _project_edit(identity, project)
                if db.execute('''SELECT 1 FROM delivery_obligations
                    WHERE tenant_id=? AND project_id=? AND status='open' LIMIT 1''',
                    (identity['tenant_id'],project['id'])).fetchone():
                    raise Conflict('open client obligations prevent project completion')
            if payload.get('status') == 'done':
                project = _project(db,identity['tenant_id'],payload['project_id'])
                _project_edit(identity, project)
                if db.execute('''SELECT 1 FROM delivery_obligations
                    WHERE tenant_id=? AND project_id=? AND stage_id=? AND status='open' LIMIT 1''',
                    (identity['tenant_id'],project['id'],payload['stage_id'])).fetchone():
                    raise Conflict('open stage obligations prevent stage completion')
        return super()._apply_196(db,identity,op,payload)

    def _apply_197(self, db, identity, op, p):
        tenant, actor, role = identity['tenant_id'],identity['actor'],identity['role']
        now = self.clock()
        if op in ('commerce.projects.card','commerce.projects.documents.list',
                  'commerce.projects.obligations.list','commerce.projects.health'):
            _object(p,{'project_id'})
            project = _project(db,tenant,p['project_id'])
            summary = _summary(db,tenant,project['id'],now)
            if op.endswith('.health'):
                return {'project_id':project['id'],**summary}
            privileged = role == 'owner' or actor == project['created_by']
            if op.endswith('.card'):
                detail = self._project_view(db,tenant,identity,project['id'])
                detail['delivery_health'] = summary
                if privileged:
                    detail['documents'] = self._document_list(db,tenant,project['id'])
                    detail['obligations'] = self._obligation_list(db,tenant,project['id'])
                else:
                    detail['documents'] = []
                    detail['obligations'] = []
                    detail['details_redacted'] = True
                return detail
            if not privileged:
                raise Unauthorized('only project creator or owner may read client details')
            if op.endswith('.documents.list'):
                return {'items':self._document_list(db,tenant,project['id'])}
            return {'items':self._obligation_list(db,tenant,project['id'])}

        if op == 'commerce.projects.documents.content':
            _object(p,{'project_id','document_id'},{'version'})
            project = _project(db,tenant,p['project_id'])
            _project_edit(identity,project)
            document = _doc(db,tenant,project['id'],p['document_id'])
            version = _version(p['version']) if 'version' in p else document['version']
            row = db.execute('''SELECT * FROM delivery_document_versions
                WHERE tenant_id=? AND project_id=? AND document_id=? AND version=?''',
                (tenant,project['id'],document['id'],version)).fetchone()
            if not row:
                raise Invalid('document version not found')
            content = bytes(row['content'])
            if sha256(content).hexdigest()!=row['sha256'] or len(content)!=row['byte_count']:
                raise Conflict('document integrity mismatch')
            return {'id':document['id'],'name':document['name'],'mime':document['mime'],
                    'version':version,'sha256':row['sha256'],'byte_count':len(content),
                    'base64':base64.b64encode(content).decode('ascii')}

        if op == 'commerce.projects.documents.add':
            _object(p,{'project_id','expected_project_version','name','mime','base64'})
            project = _project(db,tenant,p['project_id']);_check_editable(identity,project)
            if project['version'] != _version(p['expected_project_version']):
                raise Conflict('stale project version')
            name = _filename(p['name']);mime = p['mime']
            if not isinstance(mime, str) or mime not in DOC_MIMES: raise Invalid('document type not allowed')
            content = _document_bytes(p['base64'],mime)
            document_id = _uid()
            db.execute('''INSERT INTO delivery_documents VALUES (?,?,?,?,?,?,?,?,?)''',
                (document_id,tenant,project['id'],name,mime,1,actor,now,now))
            hash_ = sha256(content).hexdigest()
            db.execute('''INSERT INTO delivery_document_versions VALUES (?,?,?,?,?,?,?,?,?)''',
                (tenant,project['id'],document_id,1,content,hash_,len(content),actor,now))
            db.execute('''UPDATE delivery_projects SET version=version+1, updated_at=?
                WHERE tenant_id=? AND id=?''',(now,tenant,project['id']))
            head = _record_project(db,tenant,project['id'],actor,'document_added',
                {'document_id':document_id,'version':1,'sha256':hash_},now)
            return {'id':document_id,'version':1,'sha256':hash_,
                    'project_version':project['version']+1,'event_head':head}

        if op == 'commerce.projects.documents.revise':
            _object(p,{'project_id','document_id','expected_version','base64'})
            project=_project(db,tenant,p['project_id']);_check_editable(identity,project)
            document=_doc(db,tenant,project['id'],p['document_id'])
            if document['version']!=_version(p['expected_version']):
                raise Conflict('stale document version')
            content=_document_bytes(p['base64'],document['mime'])
            new_version=document['version']+1
            hash_=sha256(content).hexdigest()
            current=db.execute('''SELECT sha256 FROM delivery_document_versions
                WHERE tenant_id=? AND document_id=? AND version=?''',
                (tenant,document['id'],document['version'])).fetchone()
            if current['sha256']==hash_:
                raise Conflict('document unchanged; refusing duplicate version')
            db.execute('''INSERT INTO delivery_document_versions VALUES (?,?,?,?,?,?,?,?,?)''',
                (tenant,project['id'],document['id'],new_version,content,hash_,len(content),actor,now))
            db.execute('''UPDATE delivery_documents SET version=?,updated_at=?
                WHERE tenant_id=? AND id=?''',(new_version,now,tenant,document['id']))
            head=_record_project(db,tenant,project['id'],actor,'document_revised',
                {'document_id':document['id'],'version':new_version,'sha256':hash_},now)
            return {'id':document['id'],'version':new_version,'sha256':hash_,'event_head':head}

        if op == 'commerce.projects.obligations.add':
            _object(p,{'project_id','expected_project_version','title'},{'stage_id','due_at'})
            project=_project(db,tenant,p['project_id']);_check_editable(identity,project)
            if project['version']!=_version(p['expected_project_version']):
                raise Conflict('stale project version')
            stage_id=p.get('stage_id')
            if stage_id:
                stage=_stage(db,tenant,stage_id,project['id'])
                if stage['status']=='done':
                    raise Conflict('cannot add obligation to completed stage')
            elif stage_id is not None:
                raise Invalid('invalid stage id')
            title=_text(p['title'],'obligation title',200)
            due=_due(p.get('due_at'),now)
            obligation_id=_uid()
            db.execute('''INSERT INTO delivery_obligations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                (obligation_id,tenant,project['id'],stage_id,title,due,'open',1,
                 actor,actor,None,None,now,now,None))
            db.execute('''UPDATE delivery_projects SET version=version+1,updated_at=?
                WHERE tenant_id=? AND id=?''',(now,tenant,project['id']))
            head=_record_project(db,tenant,project['id'],actor,'obligation_added',
                {'obligation_id':obligation_id,'stage_id':stage_id,'due_at':due},now)
            return {'id':obligation_id,'version':1,'status':'open',
                    'project_version':project['version']+1,'event_head':head}

        if op == 'commerce.projects.obligations.resolve':
            _object(p,{'project_id','obligation_id','expected_version','status'},
                    {'evidence_sha256','waiver_reason'})
            project=_project(db,tenant,p['project_id']);_check_editable(identity,project)
            obligation=_obligation(db,tenant,project['id'],p['obligation_id'])
            if obligation['version']!=_version(p['expected_version']):
                raise Conflict('stale obligation version')
            if obligation['status']!='open':
                raise Conflict('obligation already resolved')
            status=p['status']
            if status not in ('fulfilled','waived'):
                raise Invalid('invalid obligation transition')
            evidence=p.get('evidence_sha256')
            reason=p.get('waiver_reason')
            if status=='fulfilled':
                if not isinstance(evidence,str) or len(evidence)!=64 or any(c not in '0123456789abcdef' for c in evidence):
                    raise Invalid('fulfillment requires evidence SHA-256')
                if reason is not None: raise Invalid('waiver reason forbidden for fulfillment')
                proof = db.execute('''SELECT 1 FROM delivery_document_versions
                    WHERE tenant_id=? AND project_id=? AND sha256=? LIMIT 1''',
                    (tenant,project['id'],evidence)).fetchone()
                if not proof:
                    raise Invalid('fulfillment evidence must match a stored project document version')
            else:
                if role!='owner':raise Unauthorized('only owner may waive client obligation')
                reason=_text(reason,'waiver reason',500)
                if evidence is not None: raise Invalid('evidence SHA forbidden for waiver')
            db.execute('''UPDATE delivery_obligations SET status=?,version=version+1,
                evidence_sha256=?,waiver_reason=?,updated_by=?,updated_at=?,resolved_at=?
                WHERE id=? AND tenant_id=?''',
                (status,evidence,reason,actor,now,now,obligation['id'],tenant))
            head=_record_project(db,tenant,project['id'],actor,'obligation_resolved',
                {'obligation_id':obligation['id'],'from':'open','to':status,
                 'evidence_sha256':evidence,'waiver_reason':reason},now)
            return {'id':obligation['id'],'status':status,'version':obligation['version']+1,
                    'event_head':head}
        raise Invalid('unknown M197 operation')

    def _document_list(self,db,tenant,project_id):
        rows=db.execute('''SELECT d.id,d.project_id,d.name,d.mime,d.version,d.created_by,
            d.created_at,d.updated_at,v.sha256,v.byte_count FROM delivery_documents d
            JOIN delivery_document_versions v ON v.tenant_id=d.tenant_id AND
                v.project_id=d.project_id AND v.document_id=d.id AND v.version=d.version
            WHERE d.tenant_id=? AND d.project_id=? ORDER BY d.updated_at DESC,d.id''',
            (tenant,project_id))
        return [dict(x) for x in rows]

    def _obligation_list(self,db,tenant,project_id):
        rows=db.execute('''SELECT id,project_id,stage_id,title,due_at,status,version,
            created_by,updated_by,evidence_sha256,waiver_reason,created_at,
            updated_at,resolved_at FROM delivery_obligations
            WHERE tenant_id=? AND project_id=? ORDER BY created_at,id''',
            (tenant,project_id))
        return [dict(x) for x in rows]
