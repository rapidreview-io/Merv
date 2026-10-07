# Staging checks

One row per run of a script in [staging/](staging/README.md), appended by the script itself. Cost is an estimate: Modal and machine costs as Sandboxes reports them, model tokens at the rates in the README. Full logs stay with whoever ran the check.

| When (UTC) | Check | Result | Runtime | Cost | Image | Details |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-07T01:22Z | provider-check | PASS | 1m38s | $0.02 | `20261007T004243Z-a8d2dc8d-26086213fc0c` | pass 6 · cpu2_ready_s=5.6 t4_ready_s=38.5 cloudflare_ready_s=12.3 |
| 2026-10-07T01:21Z | smoke | FAIL | 6m41s | $0.81 | `fd182b2219ec41aa0d9637cc0a1ef0eea5843935dc3da022929ef26634059ccd` | pass 17, fail 1 · failed: step_rebuild ran without an error · tag=s1 tokens_in=2665988 tokens_out=13905 slow=wf_d2a857774e844f88a935c5cb638b234d backedge=wf_20e942f7bc34489d8dc413c3671cc166 fleet=wf_54ad2d7a7b5b4b81a880e8cba13ee642 hold=wf_b803decdf00444f08c3e84b30c7401c1 |
| 2026-10-07T01:24Z | research-loop | PARTIAL | 8m25s | $0.71 | `20261007T004243Z-a8d2dc8d-26086213fc0c` | pass 8, blocked 1 · blocked: training on Modal through the Sandboxes tools · project=hosted task=wf_e4cd21970bd94ac29e4b5996fa124bc3 experiment=wf_7fa7a1f2c1ca4df1ada9c97c14d7e7a0 accuracy=0.925 tag=r1 sessions=6 tokens_in=2061696 tokens_out=19416 reached=task:in_progress@0s;exp:planned@1s;task:in_review@92s;task:done@138s;exp:design_review@245s;exp:running@321s;exp:experiment_review@413s;exp:complete@505s |
| 2026-10-07T01:28Z | smoke | PASS | 6m22s | $0.74 | `20261007T004243Z-a8d2dc8d-26086213fc0c` | pass 18 · tag=s2 tokens_in=2376620 tokens_out=14210 backedge=wf_ee9e2c9448f44f47b91659d9af729a6f fleet=wf_0eeba008375f480683aa8aa262f4beae slow=wf_22e39794786f44fc905a1d8e4ce45861 hold=wf_9143fe82167443829985cceb947c01d6 |
