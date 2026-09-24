#!/usr/bin/python3
import sys
from pathlib import Path

sys.path.insert(0, '/opt/merv/python')
from merv_sandboxes.runtimes import assignment
from isolation_probe import attest_workflow


def main():
    original = assignment.prepare_assignment_identity

    def checked_identity(**options):
        if sys.argv[1:4] == ['--', str(assignment.CODEX_EXECUTABLE), 'exec']:
            attest_workflow(Path.cwd())
        original(**options)

    assignment.prepare_assignment_identity = checked_identity
    return assignment.main()


if __name__ == '__main__':
    raise SystemExit(main())
