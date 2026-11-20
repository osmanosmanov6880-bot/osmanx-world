"""TITAN-X12: transactional one-effect local outbox and fenced delivery receipts.

The outbox is created atomically by the durable-queue effect trigger.
The API only grants a fenced DELIVERY CLAIM and stores an ACK; it never
calls external systems. External exactly-once effects require downstream
idempotency support, not present in the canonical upstream repository.
"""
from __future__ import annotations
from dataclasses import dataclass
import secrets
from .contracts import TENANT_RE
from .queue import DurableLocalQueue,QueueDenied,_WORKER

@dataclass(frozen=True)
class EffectLease:
    tenant_id:str
    task_id:str
    delivery_key:str
    worker_id:str
    fence:int
    deadline:int
    token:str

class LocalEffectOutbox:
    def __init__(self,queue:DurableLocalQueue):
        if type(queue) is not DurableLocalQueue:
            raise QueueDenied("Trusted shared local queue required")
        self.queue=queue

    def reserve(self,*,tenant_id:str,worker_id:str,now:int,
                lease_seconds:int=30)->EffectLease|None:
        self.queue._time(now)
        if (type(tenant_id) is not str or not TENANT_RE.fullmatch(tenant_id)
            or type(worker_id) is not str or not _WORKER.fullmatch(worker_id)
            or type(lease_seconds) is not int or not 1<=lease_seconds<=300):
            raise QueueDenied("Invalid local outbox claim")
        with self.queue._tx() as db:
            db.execute("""UPDATE local_effect_outbox SET state='ready',
                lease_owner=NULL,lease_until=NULL,token=NULL
                WHERE tenant=? AND state='leased' AND lease_until<=?""",
                (tenant_id,now))
            row=db.execute("""SELECT * FROM local_effect_outbox
                WHERE tenant=? AND state='ready' ORDER BY created_seq LIMIT 1""",
                (tenant_id,)).fetchone()
            if row is None:return None
            token=secrets.token_hex(32)
            fence=row["fence"]+1
            deadline=now+lease_seconds
            changed=db.execute("""UPDATE local_effect_outbox
                SET state='leased',fence=?,lease_owner=?,lease_until=?,token=?
                WHERE tenant=? AND task_id=? AND state='ready'""",
                (fence,worker_id,deadline,token,tenant_id,row["task_id"])).rowcount
            if changed!=1:raise QueueDenied("Lost local effect reservation")
            return EffectLease(tenant_id,row["task_id"],row["delivery_key"],
                worker_id,fence,deadline,token)

    def confirm(self,lease:EffectLease,*,now:int,result_sha256:str)->str:
        self.queue._time(now)
        if type(lease) is not EffectLease or type(result_sha256) is not str or not (
            len(result_sha256)==64 and all(c in "0123456789abcdef" for c in result_sha256)):
            raise QueueDenied("Valid local receipt SHA and exact lease required")
        with self.queue._tx() as db:
            row=db.execute("""SELECT * FROM local_effect_outbox
                WHERE tenant=? AND task_id=?""",
                (lease.tenant_id,lease.task_id)).fetchone()
            if (row is None or row["delivery_key"]!=lease.delivery_key
                or row["fence"]!=lease.fence or row["token"]!=lease.token
                or row["lease_owner"]!=lease.worker_id):
                raise QueueDenied("Stale or forged outbox fence")
            if row["state"]=="delivered":
                if row["ack_sha256"]!=result_sha256:
                    raise QueueDenied("Cannot replace acknowledged local effect")
                return "ACK_ALREADY_RECORDED"
            if (row["state"]!="leased" or row["lease_until"]!=lease.deadline
                or row["lease_until"]<=now):
                raise QueueDenied("Expired effect delivery lease")
            count=db.execute("""UPDATE local_effect_outbox
                SET state='delivered',ack_sha256=?,lease_owner=NULL,
                lease_until=NULL,token=NULL
                WHERE tenant=? AND task_id=? AND fence=? AND token=?
                AND state='leased'""",
                (result_sha256,lease.tenant_id,lease.task_id,lease.fence,
                 lease.token)).rowcount
            if count!=1:raise QueueDenied("Concurrent local effect acknowledgement")
            return "ACK_RECORDED_LOCAL_ONLY"

    def inspect(self,*,tenant_id:str,task_id:str)->dict|None:
        if type(tenant_id) is not str or not TENANT_RE.fullmatch(tenant_id):
            raise QueueDenied("Exact tenant required")
        with self.queue._tx() as db:
            row=db.execute("""SELECT delivery_key,state,fence,ack_sha256
                FROM local_effect_outbox WHERE tenant=? AND task_id=?""",
                (tenant_id,task_id)).fetchone()
            return None if row is None else {**dict(row),
                "external_effect_proven":False,"payload_exposed":False}
