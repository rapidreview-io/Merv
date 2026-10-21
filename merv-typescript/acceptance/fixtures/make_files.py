#!/usr/bin/env python3
"""Create tiny deterministic acceptance files; no external dependencies or network."""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import zlib

out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
result=subprocess.check_output([sys.executable,str(Path(__file__).with_name('seeded_mean.py'))])
(out/'seeded-result.json').write_bytes(result)
def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
# 16x16 RGB: red left half, blue right half; useful for actual pixel and crop checks.
raw=b''.join(b'\0'+b'\xff\0\0'*8+b'\0\0\xff'*8 for _ in range(16))
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',16,16,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
(out/'red-blue.png').write_bytes(png)
(out/'README.txt').write_text('Seed 1729, n=64. Run python3 seeded_mean.py. Same-sample algebraic comparison only; no held-out or population claim.\n')
manifest={name:{'bytes':len((out/name).read_bytes()),'sha256':hashlib.sha256((out/name).read_bytes()).hexdigest()} for name in ['seeded-result.json','red-blue.png','README.txt']}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(out/'manifest.json')
