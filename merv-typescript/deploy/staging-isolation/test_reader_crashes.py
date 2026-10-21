import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

class Readers(unittest.TestCase):
 def test_sigkill_between_reader_recreations_rolls_forward_on_same_images(self):
  for boundary in (1,2):
   with self.subTest(boundary=boundary),tempfile.TemporaryDirectory() as d:
    root=Path(d);before=b'SANDBOXES_PROVIDERS=[{"name":"staging"},{"name":"customer"}]\nSANDBOXES_RUNTIME_RELEASES=[{"provider":"customer"}]\n'
    after=b'SANDBOXES_PROVIDERS=[{"name":"customer"}]\nSANDBOXES_RUNTIME_RELEASES=[{"provider":"customer"}]\n'
    for name in ('shared','main','merv-typescript-control-1','sandboxes-control-1'):(root/(name+'.env')).write_bytes(before)
    (root/'target.env').write_bytes(after)
    command=[sys.executable,str(Path(__file__).with_name('reader-crash-fixture.py')),d]
    result=subprocess.run([*command,str(boundary)],capture_output=True)
    self.assertEqual(result.returncode,-9,result.stderr)
    self.assertEqual((root/'shared.env').read_bytes(),after)
    self.assertTrue((root/('effect-'+str(boundary)+'.json')).exists())
    for _ in range(2):
     resumed=subprocess.run([*command,'0'],capture_output=True)
     self.assertEqual(resumed.returncode,0,resumed.stderr)
     for name in ('merv-typescript-control-1','sandboxes-control-1'):self.assertEqual((root/(name+'.env')).read_bytes(),after)
if __name__=='__main__':unittest.main()
