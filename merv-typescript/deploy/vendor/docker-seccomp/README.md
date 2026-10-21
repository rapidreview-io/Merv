# Docker seccomp baseline for hosted workflow gates

`default.json` is unmodified third-party data from Moby/Docker29.6.0 revision
`70eaf5e`, under the Apache2.0 license in `LICENSE`.

Source: https://raw.githubusercontent.com/moby/moby/70eaf5e/vendor/github.com/moby/profiles/seccomp/default.json

SHA256: `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`.

The hosted release runner checks the Docker version, builtin policy selection and
these bytes, then appends only a `pivot_root` allow rule to a derived file in the
release run directory. Only the disposable synthetic workflow gate uses that
derived policy. Review, Pi, production containers and the hosted image are unchanged.
The default policy denies the pivot operation needed by Codex's nested sandbox;
all other default rules and all assignment sandbox assertions remain in force.

A Docker upgrade requires reviewing/updating this pinned baseline and its guard,
then repeating the exact-image workflow gate. The release does not fetch policy
from the network or select a mutable upstream version.
