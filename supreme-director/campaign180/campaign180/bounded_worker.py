"""A deliberately tiny, fixed-operation evaluator launched with python -I -S -B.

Only interpreter-owned arithmetic/hash operations are available. No imports
from repo, plugins, shell, URLs, callbacks or user-supplied executable code.
Do not widen this allowlist without a separate security review.
"""
import hashlib
import json
import sys
import time

MAX_INPUT=16384
MAX_OUTPUT=8192
MAX_I64=2**63-1

def fail(code):
    raw=json.dumps({"status":"denied","code":code},separators=(",",":")).encode()
    sys.stdout.buffer.write(raw)
    return 2

def run(data):
    if type(data) is not dict or set(data)!={"operation","value"}:
        raise ValueError("SCHEMA")
    op=value_op=data["operation"]
    value=data["value"]
    if op=="sum_i64":
        if type(value) is not list or not 1<=len(value)<=128:
            raise ValueError("VALUES")
        total=0
        for n in value:
            if type(n) is not int or not -MAX_I64<=n<=MAX_I64:
                raise ValueError("INTEGER")
            total+=n
            if abs(total)>MAX_I64:raise ValueError("OVERFLOW")
        return total
    if op=="sha256_text":
        if type(value) is not str or len(value.encode("utf-8"))>8192:
            raise ValueError("TEXT")
        return hashlib.sha256(value.encode("utf-8")).hexdigest()
    if op=="utf8_length":
        if type(value) is not str or len(value.encode("utf-8"))>8192:
            raise ValueError("TEXT")
        return len(value.encode("utf-8"))
    if op=="sleep_ms":
        if type(value) is not int or not 0<=value<=10000:
            raise ValueError("DURATION")
        time.sleep(value/1000)
        return value
    raise ValueError("OPERATION")

def main():
    raw=sys.stdin.buffer.read(MAX_INPUT+1)
    if len(raw)>MAX_INPUT:return fail("INPUT_LIMIT")
    try:
        data=json.loads(raw,parse_constant=lambda _:(_ for _ in ()).throw(ValueError()))
        output=run(data)
        response=json.dumps({"status":"ok","output":output},
                            sort_keys=True,separators=(",",":"),ensure_ascii=True).encode()
        if len(response)>MAX_OUTPUT:return fail("OUTPUT_LIMIT")
        sys.stdout.buffer.write(response)
        return 0
    except (ValueError,TypeError,OverflowError):
        return fail("INVALID_OPERATION")

if __name__=="__main__":
    raise SystemExit(main())
