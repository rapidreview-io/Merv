import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../verification/recovery/', import.meta.url));
const binary = process.env.MERV_RECOVERY_LEAN_BINARY || 'lean';
const version = readFileSync(join(cwd, 'lean-toolchain'), 'utf8').trim().split(':v')[1];
const run = (args) => spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 120_000 });
const checked = (result) => {
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
assert.ok(checked(run(['--version'])).includes(`version ${version},`), 'Wrong Lean version');
process.stdout.write(checked(run(['-DwarningAsError=true', 'Recovery.lean'])));

const directory = mkdtempSync(join(tmpdir(), 'merv-recovery-proof-'));
try {
  const source = readFileSync(join(cwd, 'Recovery.lean'), 'utf8');
  for (const [name, declaration, expected] of [
    ['axiom', 'axiom Merv.Recovery.unsound : False', 'Disallowed axiom'],
    ['sorry', 'theorem Merv.Recovery.unfinished : False := by sorry', 'sorry'],
  ]) {
    const path = join(directory, `${name}.lean`);
    writeFileSync(path, source.replace('run_cmd do', `${declaration}\nrun_cmd do`));
    const result = run(['-DwarningAsError=true', path]);
    if (result.error) throw result.error;
    assert.equal(result.status, 1, `${name} negative control was not rejected`);
    assert.ok(`${result.stdout}\n${result.stderr}`.includes(expected));
  }
  console.log('Negative controls passed: custom axiom and unfinished proof rejected');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
