"""Test-only PTY bridge for native clients requiring interactive OAuth input."""
import os
import pty
import select
import sys

pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [])
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            os.write(master, data)
finally:
    os.close(master)
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
