import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import harness as h

class HarnessTest(unittest.TestCase):
    def test_redaction(self):
        raw='Bearer secret-value "access_token":"hidden" https://example.test/a?X-Amz-Signature=private sk-abcdef eyJabc.def.ghi'
        safe=h.redact(raw)
        for secret in ('secret-value','hidden','private','sk-abcdef','eyJabc.def.ghi'): self.assertNotIn(secret,safe)
    def test_split_secret_never_persisted(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'log'
            code,reason=h.capture([sys.executable,'-c',"import sys,time;sys.stdout.write('Bearer sec');sys.stdout.flush();time.sleep(.05);print('ret')"],os.environ,d,p,2)
            self.assertEqual((code,reason),(0,None)); self.assertNotIn('secret',p.read_text())
    def test_nested_json_secret_fields(self):
        for key in h.SECRET_KEYS:
            for depth in range(4):
                secret = 'synthetic-private-value'
                nested = json.dumps({key:secret, 'projectId':'project_123'})
                for _ in range(depth): nested=json.dumps({'text':nested})
                event={'message':{'content':[{'type':'text','text':nested}]},'thread_id':'thread_456'}
                safe=h.redact(json.dumps(event))
                self.assertNotIn(secret,safe)
                self.assertEqual(json.loads(safe)['thread_id'],'thread_456')
                self.assertIn('project_123',safe)
        # JSON unicode escapes must not conceal field names or token prefixes.
        raw=json.dumps({'text':json.dumps({'access_token':'synthetic-private'})}).replace('access_token',r'access\u005ftoken')
        self.assertNotIn('synthetic-private',h.redact(raw))
    def test_merv_token_shapes_preserve_record_ids(self):
        ids=['project_'+'A'*43, 'workflow_'+'B'*43, 'review_123',
             '01a15ca8-678b-7c20-9581-3208a3479359', 'A'*43]
        for prefix in ('mo_','mrfr_','mk_','mi_'):
            token=prefix+'A'*41+'_-'
            raw=json.dumps({'message':{'content':[{'type':'text','text':json.dumps({'access_token':token})}]}})
            self.assertNotIn(token,h.redact(raw))
            self.assertNotIn(token,h.redact('credential: ('+token+')'))
        for record in ids: self.assertEqual(h.redact(record),record)
    def test_escaped_json_in_prose(self):
        nested=json.dumps({'refresh_token':'synthetic-private'})
        for _ in range(4):
            self.assertNotIn('synthetic-private',h.redact('tool output: '+nested))
            nested=json.dumps(nested)
    def test_split_merv_tokens_in_nested_output(self):
        for prefix, ending in ((prefix, ending) for prefix in ('mo_','mrfr_','mk_','mi_') for ending in ('', '\n')):
            with self.subTest(prefix=prefix, newline=bool(ending)), tempfile.TemporaryDirectory() as d:
                token=prefix+'A'*43
                raw=json.dumps({'message':{'content':[{'type':'text','text':json.dumps({'access_token':token, 'projectId':'project_123'})}]}})
                split=raw.index(token)+len(prefix)+17
                # Synthetic output only. Explicit flush forces separate writes;
                # exercise both newline-delimited events and the EOF remainder.
                script='import sys,time;sys.stdout.write('+repr(raw[:split])+');sys.stdout.flush();time.sleep(.05);sys.stdout.write('+repr(raw[split:]+ending)+');sys.stdout.flush()'
                log=Path(d)/'log'
                code,reason=h.capture([sys.executable,'-c',script],os.environ,d,log,2)
                self.assertEqual((code,reason),(0,None))
                saved=log.read_text();self.assertNotIn(token,saved)
                self.assertIn('project_123',saved);json.loads(saved)
    def test_timeout_and_descendant_cleanup(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'log'; marker=Path(d)/'escaped'
            script=f"import subprocess,time;subprocess.Popen([{sys.executable!r},'-c',\"import time;from pathlib import Path;time.sleep(2);Path({str(marker)!r}).touch()\"]);time.sleep(30)"
            _,reason=h.capture([sys.executable,'-c',script],os.environ,d,p,.1)
            self.assertEqual(reason,'timeout');time.sleep(2.1); self.assertFalse(marker.exists())
    def test_output_cap(self):
        with tempfile.TemporaryDirectory() as d:
            _,reason=h.capture([sys.executable,'-c',"print('x'*10000)"],os.environ,d,Path(d)/'log',2,100)
            self.assertEqual(reason,'output_limit')
    def test_event_parsers(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'log'
            p.write_text('\n'.join(json.dumps(v) for v in [
                {'type':'thread.started','thread_id':'codex-id'},
                {'type':'item.completed','item':{'type':'mcp_tool_call','server':'merv','tool':'project.read','status':'completed'}},
                {'type':'system','session_id':'claude-id'},
                {'type':'assistant','message':{'content':[{'type':'tool_use','name':'mcp__merv__project_read'}]}},
                {'type':'user','message':{'content':[{'type':'tool_result','is_error':True}]}},
            ]))
            e=h.events(p);self.assertEqual(e['sessionIds'],['claude-id','codex-id']);self.assertEqual(len(e['calls']),2);self.assertEqual(e['errors'],['tool_result_error'])
    def test_no_bypass_and_resume(self):
        for client in ('codex','claude'):
            args=h.command(client,'exact-session')
            self.assertIn('exact-session',args)
            self.assertFalse(any('bypass' in x or 'allowedTools' in x or 'approve'==x for x in args))
    def test_attestation_requires_all_checks_and_local_proof(self):
        with tempfile.TemporaryDirectory() as d:
            ledger=Path(d)/'r.json'; evidence=Path(d)/'e.json'
            h.write(ledger,{'checks':{'actual':None},'exitCode':0,'reason':'evidence_review_required','errors':[]})
            h.write(evidence,{'status':'pass','checks':{},'reviewer':'person','cleanup':{'status':'done'}})
            with self.assertRaises(ValueError): h.attest(argparse.Namespace(ledger=str(ledger),evidence=str(evidence)))
            h.write(evidence,{'status':'pass','checks':{'actual':{'status':'pass','observation':'yes','proofPaths':['/etc/hosts']}},'reviewer':'person','cleanup':{'status':'done'}})
            with self.assertRaises(ValueError): h.attest(argparse.Namespace(ledger=str(ledger),evidence=str(evidence)))
    def test_attestation_and_changed_evidence_summary(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); proof=root/'codex'/'proof';proof.mkdir(parents=True)
            h.write(root/'run.json',{'runId':'test'})
            log=proof/'fresh-chat-001.jsonl';log.write_text('verified server receipt')
            ledger=proof/'fresh-chat-001.json'
            h.write(ledger,{'runId':'test','scenario':'fresh-chat','client':'codex','checks':{'actual':None},'exitCode':0,'reason':'evidence_review_required','errors':[],'status':'blocked'})
            evidence=root/'e.json'
            h.write(evidence,{'status':'pass','reviewer':'independent-person','workflowIds':[],'receiptIds':['receipt-1'],'cleanup':{'status':'done'},'checks':{'actual':{'status':'pass','observation':'Compared retained receipt with server record','proofPaths':[str(log)]}}})
            h.attest(argparse.Namespace(ledger=str(ledger),evidence=str(evidence)))
            h.summary(argparse.Namespace(root=str(root)))
            rows=h.read(root/'summary.json')['scenarios']
            self.assertEqual(next(x for x in rows if x['client']=='codex' and x['scenario']=='fresh-chat')['status'],'pass')
            self.assertEqual(h.read(root/'summary.json')['status'],'blocked')
            log.write_text('changed')
            h.summary(argparse.Namespace(root=str(root)))
            rows=h.read(root/'summary.json')['scenarios']
            self.assertEqual(next(x for x in rows if x['client']=='codex' and x['scenario']=='fresh-chat')['reason'],'evidence_changed')
    def test_rerun_requires_recorded_resume(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);proof=root/'codex'/'proof';proof.mkdir(parents=True)
            h.write(root/'run.json',{})
            h.write(proof/'task-001.json',{'sessionIds':['known']})
            args=argparse.Namespace(root=str(root),client='codex',scenario='task',resume=None,dry_run=True)
            with self.assertRaises(ValueError): h.run(args)
            args.resume='unknown'
            with self.assertRaises(ValueError): h.run(args)
    def test_fixture_is_honest_and_deterministic(self):
        first=subprocess.check_output([sys.executable,str(h.HERE/'fixtures/seeded_mean.py')])
        second=subprocess.check_output([sys.executable,str(h.HERE/'fixtures/seeded_mean.py')])
        self.assertEqual(first,second); d=json.loads(first)
        self.assertEqual(d['sum'],918)
        self.assertEqual(d['difference_numerator']/d['denominator'],d['mean']**2)
        self.assertIn('No held-out',d['limitation'])

if __name__=='__main__': unittest.main()
