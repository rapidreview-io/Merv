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
