import argparse
import json
from pathlib import Path
import tempfile
import unittest
import action_matrix as a
import harness as h

class ActionMatrixTest(unittest.TestCase):
    def test_exact_published_action_coverage(self):
        m=h.read(a.SNAP/'action-matrix.json'); rows={r['id']:r for r in m['rows']}
        expected=set()
        for t in h.read(a.SNAP/'operator-tools.json')['tools']:
            for action in a.actions(a.expand(t['inputSchema'],t['inputSchema'])):
                expected.add(t['name']+(':'+action if action else ''))
        self.assertEqual(expected,{r['id'] for r in rows.values() if r['inMeasuredOperatorListing']})
        self.assertEqual(len(expected),142)
        self.assertEqual(len(rows),len(m['rows']))
        self.assertTrue(all(r['operation'] and r['fixture'] and r['independentEvidence'] for r in rows.values()))
    def test_argument_shapes_and_boundaries(self):
        rows={r['id']:r for r in h.read(a.SNAP/'action-matrix.json')['rows']}
        self.assertIn('get',rows['experiment.read:get']['argumentTemplate'])
        job=rows['sandboxes.job:run']
        self.assertEqual(job['inputStyle'],'flat')
        self.assertEqual(set(job['requiredFields']),{'sandbox_id','command'})
        self.assertNotIn('run',job['argumentTemplate'])
        self.assertEqual(rows['sandboxes.workflow:get']['requiredFields'],['workflow_id'])
        self.assertEqual(rows['sandboxes.access:certificate']['lane'],'ui_or_explicit_worker_grant')
        self.assertIn('actual lease-policy grant',rows['sandboxes.access:certificate']['availability'])
        self.assertFalse(rows['sandboxes.access:certificate']['inMeasuredOperatorListing'])
        self.assertEqual(rows['task.submit_delivery']['lane'],'pi_or_assigned_worker')
        self.assertEqual(rows['pi.send']['lane'],'website_only')
        self.assertEqual(rows['intake.write:verify_plan']['lane'],'bound_intake_pi_only')
        self.assertEqual(rows['report.open']['lane'],'cached_compatibility_only')
        self.assertIn('disabled',rows['feed.write:post']['availability'])
    def test_actual_calls_match_action_not_just_area(self):
        rows=h.read(a.SNAP/'action-matrix.json')['rows']
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'events.jsonl'
            path.write_text('\n'.join(json.dumps(x) for x in [
                {'type':'item.completed','item':{'type':'mcp_tool_call','tool':'project.read','arguments':{'action':'brief'},'status':'completed'}},
                {'type':'assistant','message':{'content':[{'type':'tool_use','name':'mcp__plugin_merv__artifact_write','input':{'action':'create'}}]}},
                {'type':'item.completed','item':{'type':'mcp_tool_call','tool':'experiment.write','arguments':json.dumps({'action':'transition'}),'status':'failed'}},
            ]))
            calls=a.observed_calls([path],rows)
            self.assertEqual([c['id'] for c in calls],['project.read:brief','artifact.write:create','experiment.write:transition'])
            self.assertEqual(calls[1]['status'],'attempted_result_unverified')
            self.assertEqual(calls[2]['status'],'failed_or_unknown')
    def test_worker_stage_cannot_launch_owner_impersonation(self):
        with self.assertRaises(ValueError):a.stage(argparse.Namespace(stage='41-intake-worker'))
    def test_registration_extraction_has_no_gaps(self):
        x=h.read(a.SNAP/'registered-tools.json')
        self.assertEqual(x['gaps'],[])
        self.assertEqual(x['candidateRevision'],'4530bd6224b869ab8989814bf70d979f039d8428')

if __name__=='__main__':unittest.main()
