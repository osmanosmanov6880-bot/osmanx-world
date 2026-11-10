"""Strict deterministic reference adapters for NINE contract slots.

No network calls, AI, real payments, external modules, accounts, or product
integration occur. This is a contract test simulator, not proof of upstream.
"""
from __future__ import annotations
import hashlib
import json
import re

SCHEMA = 'osgard.m186.reference-contract/1'
ENVELOPE_SCHEMA = 'osgard.m186.reference-envelope/1'
SCENARIOS = {'LEARNING_PLATFORM', 'CREATOR_WORKSPACE', 'CITY_RESEARCH'}
OPERATORS = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{2,39}\Z')
CONTRACTS = (
    ('CONTRACT-01', 'TITAN', 'NEXUS', (), {'authorized': bool, 'scope': str, 'identity_proven': bool}),
    ('CONTRACT-02', 'NEXUS', 'COMMERCE', (1,), {'intent': str, 'intelligence': str, 'external_sources': int}),
    ('CONTRACT-03', 'COMMERCE', 'EXPERIENCE', (2,), {'quote_points': int, 'currency': str, 'payment_enabled': bool}),
    ('CONTRACT-04', 'EXPERIENCE', 'GENESIS', (2, 3), {'screens': list, 'quality_status': str}),
    ('CONTRACT-05', 'GENESIS', 'ORBITAL', (4,), {'asset_placeholders': list, 'generated_media': int}),
    ('CONTRACT-06', 'ORBITAL', 'TITAN', (1, 5), {'risk_level': str, 'independent_audit': bool}),
    ('CONTRACT-07', 'NEXUS', 'COMMERCE', (2, 3), {'intent_quote_consistent': bool, 'real_quote': bool}),
    ('CONTRACT-08', 'EXPERIENCE', 'GENESIS', (4, 5), {'slot_asset_consistent': bool, 'real_assets': int}),
    ('CONTRACT-09', 'ORBITAL', 'TITAN', (1, 6, 7, 8), {'flow': str, 'real_integrations': int, 'production_authorized': bool}),
)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def hexdigest(value):
    return hashlib.sha256(canonical(value).encode('utf8')).hexdigest()


def validate_request(request):
    if type(request) is not dict or set(request) != {'scenario','operator','budget_points','risk_profile','inject_fault_at'}:
        raise ValueError('exact reference request keys required')
    if request['scenario'] not in SCENARIOS:
        raise ValueError('unknown reference scenario')
    if type(request['operator']) is not str or not OPERATORS.fullmatch(request['operator']):
        raise ValueError('operator must be a non-personal stable ASCII identifier')
    if type(request['budget_points']) is not int or not 100 <= request['budget_points'] <= 1_000_000:
        raise ValueError('synthetic budget bounds')
    if request['risk_profile'] != 'PUBLIC_DEMO_ONLY':
        raise ValueError('only public non-sensitive reference inputs permitted')
    fault = request['inject_fault_at']
    if fault is not None and fault not in {s[0] for s in CONTRACTS}:
        raise ValueError('fault id must be a declared contract')
    return dict(request)


def catalog_template():
    return {'schema': SCHEMA, 'authority': 'SYNTHETIC_REFERENCE_ONLY', 'real_upstreams': 0,
            'production_authorized': False, 'contracts': [
                {'id': sid, 'producer': producer, 'consumer': consumer, 'depends_on': [f'CONTRACT-{d:02d}' for d in deps],
                 'required_output': sorted(fields), 'verification': 'REFERENCE_ONLY'}
                for sid, producer, consumer, deps, fields in CONTRACTS]}


def validate_catalog(obj):
    if type(obj) is not dict or canonical(obj) != canonical(catalog_template()):
        raise ValueError('reference contract catalog mismatch, refuses untrusted adapter spec')
    return True


def _payload(idx, request, outputs):
    scenario = request['scenario']
    budget = request['budget_points']
    if idx == 1: return {'authorized': True, 'scope': 'SIMULATOR_ONLY', 'identity_proven': False}
    if idx == 2: return {'intent': scenario, 'intelligence': 'RULE_BASED_SYNTHETIC', 'external_sources': 0}
    if idx == 3: return {'quote_points': budget, 'currency': 'TEST_POINTS', 'payment_enabled': False}
    if idx == 4: return {'screens': ['DISCOVER','WORKSPACE','REVIEW'], 'quality_status': 'DESIGN_REFERENCE_NOT_USABILITY_TESTED'}
    if idx == 5: return {'asset_placeholders': ['cover-placeholder','card-placeholder'], 'generated_media': 0}
    if idx == 6: return {'risk_level': 'REFERENCE_MEDIUM' if budget >= 500_000 else 'REFERENCE_LOW', 'independent_audit': False}
    if idx == 7: return {'intent_quote_consistent': outputs[2]['intent'] == scenario and outputs[3]['quote_points'] == budget, 'real_quote': False}
    if idx == 8: return {'slot_asset_consistent': len(outputs[4]['screens']) == 3 and len(outputs[5]['asset_placeholders']) == 2, 'real_assets': 0}
    if idx == 9: return {'flow': 'LOCAL_REFERENCE_COMPLETE', 'real_integrations': 0, 'production_authorized': False}
    raise ValueError('unknown reference adapter')


def validate_envelope(envelope, stage):
    sid, producer, consumer, deps, field_kinds = stage
    if type(envelope) is not dict or set(envelope) != {'schema','contract_id','producer','consumer','context','input_sha256','payload'}:
        raise ValueError('unrecognized envelope')
    if (envelope['schema'] != ENVELOPE_SCHEMA or envelope['contract_id'] != sid or
        envelope['producer'] != producer or envelope['consumer'] != consumer or
        envelope['context'] != 'SYNTHETIC_REFERENCE_ONLY'):
        raise ValueError('incorrect contract routing or reference scope')
    h = envelope['input_sha256']
    if type(h) is not str or re.fullmatch('[0-9a-f]{64}', h) is None:
        raise ValueError('input SHA missing')
    payload = envelope['payload']
    if type(payload) is not dict or set(payload) != set(field_kinds):
        raise ValueError('unexpected output payload shape')
    for key, kind in field_kinds.items():
        if type(payload[key]) is not kind:
            raise ValueError('output field type mismatch')
        if kind is str and (not payload[key] or len(payload[key]) > 128):
            raise ValueError('output string size')
        if kind is list and (len(payload[key]) > 8 or any(type(x) is not str or len(x) > 70 for x in payload[key])):
            raise ValueError('output list shape')
    if sid == 'CONTRACT-01' and (payload['scope'] != 'SIMULATOR_ONLY' or payload['identity_proven'] is not False):
        raise ValueError('reference identity authority cannot be escalated')
    if sid == 'CONTRACT-02' and (payload['intelligence'] != 'RULE_BASED_SYNTHETIC' or payload['external_sources'] != 0):
        raise ValueError('reference intelligence authority cannot be escalated')
    if sid == 'CONTRACT-03' and (payload['payment_enabled'] is not False or payload['currency'] != 'TEST_POINTS'):
        raise ValueError('reference billing cannot execute payments')
    if sid == 'CONTRACT-05' and payload['generated_media'] != 0:
        raise ValueError('reference mode cannot claim generated real media')
    if sid == 'CONTRACT-06' and payload['independent_audit'] is not False:
        raise ValueError('reference risk check cannot claim independent audit')
    if sid == 'CONTRACT-07' and payload['real_quote'] is not False:
        raise ValueError('reference quote is not a payable offer')
    if sid == 'CONTRACT-08' and payload['real_assets'] != 0:
        raise ValueError('reference assets cannot claim real assets')
    if sid == 'CONTRACT-09' and (payload['real_integrations'] != 0 or payload['production_authorized'] is not False or
                                   payload['flow'] != 'LOCAL_REFERENCE_COMPLETE'):
        raise ValueError('reference release authority cannot be escalated')
    return True


def execute_reference(request):
    request = validate_request(request)
    results = {}
    steps = []
    for idx, stage in enumerate(CONTRACTS, 1):
        sid, producer, consumer, deps, _ = stage
        inputs = {'request': request, 'dependencies': {f'CONTRACT-{d:02d}': results[d] for d in deps}}
        inp_sha = hexdigest(inputs)
        payload = _payload(idx, request, results)
        if request['inject_fault_at'] == sid:
            payload = {'invalid_fault_injection': True}
        envelope = {'schema': ENVELOPE_SCHEMA, 'contract_id': sid, 'producer': producer,
                    'consumer': consumer, 'context': 'SYNTHETIC_REFERENCE_ONLY',
                    'input_sha256': inp_sha, 'payload': payload}
        try:
            validate_envelope(envelope, stage)
            status, reason = 'PASS_REFERENCE', 'STRICT_REFERENCE_SCHEMA_OK'
        except ValueError:
            status, reason = 'BLOCKED_SCHEMA', 'REFERENCE_CONTRACT_SCHEMA_REJECTED'
        steps.append({'index': idx, 'contract_id': sid, 'producer': producer, 'consumer': consumer,
                      'status': status, 'reason': reason, 'input_sha256': inp_sha,
                      'output_sha256': hexdigest(envelope), 'envelope': envelope})
        if status != 'PASS_REFERENCE': break
        results[idx] = payload
    return {'outcome': 'REFERENCE_FLOW_COMPLETE' if len(steps) == 9 and all(s['status'] == 'PASS_REFERENCE' for s in steps) else 'BLOCKED_REFERENCE_CONTRACT',
            'scenario': request['scenario'], 'steps': steps,
            'real_product_integrations': 0, 'verified_production_contracts': 0,
            'original_task_acceptance': 0, 'production_authorized': False}
