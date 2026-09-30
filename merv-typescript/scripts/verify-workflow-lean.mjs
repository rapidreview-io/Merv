import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../verification/lean/', import.meta.url));
const expected = readFileSync(
  new URL('../verification/lean/lean-toolchain', import.meta.url),
  'utf8',
)
  .trim()
  .split(':v')[1];

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error || result.status !== 0) {
    console.error(result.error?.message ?? result.stderr ?? `${command} failed`);
    process.exit(result.status || 1);
  }
  return result.stdout;
}

const version = run('lake', ['env', 'lean', '--version'], true);
if (!version.includes(`version ${expected},`)) {
  console.error(`Expected Lean ${expected}; received ${version.trim()}`);
  process.exit(1);
}
console.log(version.trim());
run('lake', ['build']);
// Re-elaborate the axiom assertions even when Lake's build cache is warm.
run('lake', ['env', 'lean', '-DwarningAsError=true', 'Audit.lean']);

// Check that the gate itself rejects broken proofs, not merely that today's
// proofs happen to pass. Inject only into disposable copies of the audit file.
const probeDir = mkdtempSync(join(tmpdir(), 'merv-lean-audit-'));
try {
  const source = readFileSync(join(cwd, 'Audit.lean'), 'utf8');
  const probes = [
    ['axiom', 'axiom Merv.AuditProbe : False', 'Disallowed axiom Merv.AuditProbe'],
    ['sorry', 'theorem Merv.AuditProbe : False := by sorry', 'sorry'],
  ];
  for (const [name, declaration, expectedFailure] of probes) {
    const path = join(probeDir, `${name}.lean`);
    writeFileSync(path, source.replace('run_cmd do', `${declaration}\n\nrun_cmd do`));
    const result = spawnSync('lake', ['env', 'lean', '-DwarningAsError=true', path], {
      cwd,
      encoding: 'utf8',
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.error || result.status !== 1 || !output.includes(expectedFailure)) {
      throw new Error(`Axiom audit negative control ${name} failed:\n${output}`);
    }
  }
  console.log('Audit negative controls passed: custom axiom and unfinished proof both rejected');
} finally {
  rmSync(probeDir, { recursive: true, force: true });
}
