# Ledgerline Flash Lab

An independent local Merv project run by DeepSeek V4.1 Flash through Codex CLI.
The project investigates public receipt OCR extraction, inspired by scenario 1.
It uses real public data and real inference, with unscripted independent review.

The research cycle is complete. Start with `report.md`; `paper.md` contains the
reviewed living paper, and `reflection-synthesis.md` contains the approved
reflection. The full review history and cumulative CLI session ledger are exported
as JSON. The local server and inference broker are stopped; their private state is
retained under `run/`.

This first cycle compares prompting interventions. It does not train a model or
measure a fine-tuning arm. Its recommendation must preserve that limitation.

- `brief.md`: frozen study scope and acceptance criteria.
- `run-research.ts`: controller adapted from the repository's live scenario driver.
  It accepts review returns without expecting particular verdicts and drives the
  five reflection lenses, synthesis, and review after the research records finish.
- `inference-broker.ts`: public-data inference access with a fixed model/configuration,
  retained provider receipts, concurrency limit, and request/token bounds.
- `file-tools.ts` and `codex-flash-research`: a local file-transfer adapter using
  the existing Merv uploader and each worker's scoped session credential. Producers
  can upload/download only inside their assigned workspace. Reviewers can inspect
  immutable artifact bytes and archive members without filesystem writes.
- `run/`: private local server state, per-step Flash transcripts, code/data evidence,
  retained API receipts, and completion records. This is deliberately ignored by Git
  because its server directory contains a local credential.
- `controller.log`: launch and workflow progress, excluding credentials.
- `interactive-review.ts`: independent Flash review through the ordinary review
  APIs when automatic assignment construction exceeds the context budget. It
  pauses this project's dispatch, uses a distinct temporary reviewer identity,
  retains the transcript/verdict, revokes the credential, then restores dispatch.
- `independent-audit.py` / `independent-audit.json`: operator verification of the
  scored gateway responses, metrics, paired intervals, and interpretation limits.
- `observations.md`: Merv failures and operator interventions during this run.
- `export-evidence.mjs`: exports hash-verified reflection artifacts, review history,
  and the completed cycle's current paper into readable files beside this README.

From `merv-typescript`, use the verified DeepSeek launcher:

```sh
MERV_CODEX_BIN="$PWD/dev_docs/flash-research-2026-09-18/codex-flash-research" \
node --import tsx dev_docs/flash-research-2026-09-18/run-research.ts \
  --brief dev_docs/flash-research-2026-09-18/brief.md \
  --out dev_docs/flash-research-2026-09-18/run \
  --local --timeout-minutes 90
```

The wrapper supplies the model/provider settings. Do not add a duplicate `--model`.
The controller binds Merv to loopback port 18764 and the inference broker to 18763.
Only one controller may own this directory and these ports at a time.
Network access is required for DeepSeek and public dataset acquisition.

Credentials are read only from their existing private locations; no provider key
is embedded in this directory's scripts or brief. Do not publish the private run
directory. Model metadata warnings from Codex are retained in the launch logs.
