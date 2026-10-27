# @merv/metrics

Personal-agent tools below use `{"action":"x","x":{...}}`.
Leased workers keep the alias names and inputs granted by their pinned workflows.
See the [tool overview](../../README.md#agent-tools).

Metrics puts a self-hosted [Trackio](https://huggingface.co/docs/trackio) server (Hugging Face's
wandb-compatible tracker) behind Merv. Training code logs to it with the ordinary Trackio client;
people see the curves on an experiment's Metrics tab and on the project Metrics page; agents read
runs, analyse them with SQL or scripts and look at the charts as pictures. It is optional: nothing loads it by default,
and Experiments never imports it.

## Where it sits

| Entry                 | Requires                                     | Adds                                                                               |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `@merv/metrics`       | API, Scope, Experiments, Sessions, Artifacts | `ctx.metrics`; the `/trackio` proxy and `POST /metrics/session`                    |
| `@merv/metrics/tools` | Metrics, Tools                               | `metrics.read` (runs, run, series, look, query), `metrics.write` (connect, export) |
| `@merv/metrics/ui`    | Metrics, UI                                  | The project Metrics page (no rail row; reached from an experiment's Metrics tab)   |

Trackio runs as its own process (`trackio/serve.py`, pinned in `trackio/requirements.txt`) on an
internal network, never published. Trackio has no per-project access control, so `/trackio` is
the only way in and does its own authorisation (`proxy.ts`):

- **Write tokens** (`metrics.write connect`, 12 h) are HMAC-signed for one project, experiment and
  attempt. They may write metrics, system metrics, alerts and media for that project only, and read
  it. `bulk_log` configs are tagged `_merv_experiment` / `_merv_attempt`, which is how Merv knows an
  attempt's runs (nothing else records it), and `_Group` is set to the experiment's name, so the
  dashboard's Group by sorts runs by experiment. A run belongs to the experiment attempt that first
  logged it: a write to another attempt's run, by id or by name, is refused, because Trackio
  replaces a run's config wherever a write carries one.
- **View cookies** (`POST /metrics/session`, 30 min, one per project) let a member's browser load
  the dashboard; every data request rechecks project membership.
- Requests name the project exactly as the token does, by name only; positional bodies, mutations
  (`delete_run`, `rename_run`, …), registries and unknown routes are refused. Media paths stay
  single segments inside the project's media directory, and uploaded files are served in an opaque-origin sandbox (scripts may draw a figure, never as Merv)
  because they come from training code and are served from Merv's origin.

## Experiments

experiment@46 grants the reads to every assignment and `connect` / `export` to the running
producer, and its brief says to log with Trackio when the tools are available. `export` retains
the attempt's runs as one JSON artifact, which the producer attaches as a qualitative result, so
reviewers judge retained evidence rather than a dashboard that can still change.

## Deploying

`deploy/compose.yml` runs a `trackio` service on an internal network only Main joins; its data is
the `trackio_data` volume. `deploy/release.mjs` builds its image before stopping the previous Main.
It idles until `/etc/merv/trackio.env` (root, 0600) holds `TRACKIO_WRITE_TOKEN`, the only secret
it receives. `deploy/render-config.mjs` loads the three plugin entries when
`MERV_METRICS_TRACKIO_URL` (`http://trackio:7860`) is set in `/etc/merv/typescript.env`, with
`MERV_METRICS_WRITE_TOKEN` (the same token) and `MERV_METRICS_SECRET` (the HMAC key, ≥32
characters). Without them Merv runs as before and Trackio stays idle. Locally,
`npm run demo:ui` loads them when `MERV_METRICS_UPSTREAM`, `MERV_METRICS_SECRET` and
`MERV_METRICS_WRITE_TOKEN` are set.
