"""Operator audit of retained responses; does not invoke the producer evaluator."""
from pathlib import Path
import collections, hashlib, json, random, tarfile, unicodedata

HERE = Path(__file__).resolve().parent
RUN = HERE / 'run'
WORK = RUN / 'workspaces/prompt-generalization'
DATA_HASH = '83aadff3506f963c8569fa3d44cbe8f3ae213db733f9b0724227439d706edb9d'
blob = RUN / 'server/blobs/project_245947d7687247819a19330e3c09e916' / DATA_HASH[:2] / DATA_HASH
assert hashlib.sha256(blob.read_bytes()).hexdigest() == DATA_HASH
with tarfile.open(blob, 'r:gz') as archive:
    raw = archive.extractfile('kit/dataset_receipts.json').read()
    data = json.loads(raw)['records']
by_id = {r['receipt_id']: r for r in data}
gateway = {r['number']: r for r in map(json.loads, (RUN / 'inference/receipts.jsonl').read_text().splitlines())}
fields = ('company', 'date', 'address', 'total')
norm = lambda s: ' '.join(unicodedata.normalize('NFKC', s).split()).casefold()
sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
freeze = json.loads((WORK / 'artifacts/prompts_frozen.json').read_text())
score = {}
matched = set()
for name, split in [('run_log_dev.jsonl', 'development'), ('run_log_holdout.jsonl', 'holdout')]:
    for row in map(json.loads, (WORK / 'out' / name).read_text().splitlines()):
        ref = row['broker_receipt']; actual = gateway[ref['number']]
        request, response = actual['request'], actual['response']
        assert actual['status'] == row['http_status'] == 200
        assert ref['digest'] == actual['digest'] == sha(json.dumps(request, separators=(',', ':'), ensure_ascii=False))
        assert request['model'] == response['model'] == 'deepseek-flash'
        assert (request['temperature'], request['max_tokens'], request['thinking'], request['response_format']) == (0, 768, {'type':'disabled'}, {'type':'json_object'})
        rec = by_id[row['receipt_id']]
        assert row['split'] == rec['split'] == split
        user = 'Receipt OCR text:\n' + ' '.join(rec['ocr_words'].split('\n'))
        assert request['messages'][1] == {'role':'user', 'content':user}
        assert sha(user) == row['input_sha256']
        assert sha(request['messages'][0]['content']) == row['system_sha256'] == freeze['frozen_prompt_sha256_from_plan'][row['arm']]
        assert response['choices'][0]['message']['content'] == row['raw_content']
        assert response['usage'] == row['usage']
        prediction = json.loads(row['raw_content'])
        valid = set(prediction) == set(fields) and all(isinstance(prediction[f],str) for f in fields)
        cells = [int(valid and norm(prediction[f]) == norm(rec['gold'][f])) for f in fields]
        key = (split, row['arm'], row['receipt_id'])
        assert key not in score
        score[key] = {'cells':cells, 'invalid':not valid, 'tokens':response['usage']['total_tokens']}
        matched.add(ref['number'])
metrics = {}
for split, arm in sorted({(s,a) for s,a,_ in score}):
    rows = [v for (s,a,_),v in score.items() if (s,a)==(split,arm)]
    assert len(rows) == (24 if split=='development' else 80)
    metrics[split+'_'+arm] = {'receipts':len(rows), 'correct_cells':sum(sum(v['cells']) for v in rows),
        'whole_exact':sum(sum(v['cells'])==4 for v in rows), 'invalid':sum(v['invalid'] for v in rows),
        'tokens':sum(v['tokens'] for v in rows),
        'per_field_correct':{f:sum(v['cells'][i] for v in rows) for i,f in enumerate(fields)}}
assert len(matched) == 232
ids = [r['receipt_id'] for r in data if r['split']=='holdout']
deltas = {i:sum(score['holdout','P2',i]['cells'])-sum(score['holdout','P0',i]['cells']) for i in ids}
groups = collections.defaultdict(list)
for i in ids: groups[norm(by_id[i]['gold']['company'])].append(i)
def interval(units, expand):
    rng = random.Random(20260918)
    samples = []
    for _ in range(10000):
        chosen = [i for u in [rng.choice(units) for _ in units] for i in expand(u)]
        samples.append(sum(deltas[i] for i in chosen)/(4*len(chosen)))
    samples.sort()
    return [samples[250], samples[9750]]
splits = {s:{norm(r['gold']['company']) for r in data if r['split']==s} for s in ('demonstration','development','holdout')}
assert all(not splits[a]&splits[b] for a,b in [('demonstration','development'),('demonstration','holdout'),('development','holdout')])
result = {'origin':'Independent operator audit; original API responses; no model reruns and no producer scoring code used.',
    'dataset_sha256':hashlib.sha256(raw).hexdigest(), 'matched_scored_provider_receipts':len(matched),
    'gateway_calls':len(gateway), 'metrics':metrics, 'paired_delta':sum(deltas.values())/(4*len(ids)),
    'receipt_bootstrap_95':interval(ids, lambda i:[i]), 'company_bootstrap_95':interval(sorted(groups), lambda g:groups[g]),
    'company_groups':len(groups), 'company_disjoint_splits':True,
    'interpretation_caution':'The model_miss category means a gold string was found in OCR. This does not establish that the BIO label identifies the correct semantic field. Label/OCR causes cannot be excluded without independent semantic adjudication. No fine-tuning comparison was run.'}
(HERE/'independent-audit.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
