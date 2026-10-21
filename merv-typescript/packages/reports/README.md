# Reports

Reports keeps editable report drafts and renders retained reports with their data
and reviewed visuals. `report.read` is a deferred tool with actions `check` and
`review_visual`, using `{"action":"x","x":{...}}`. The latter returns visual
review material; the tool schema describes the subject and visual identifiers.

Draft production stays worker-only: `report.open`, `report.write`, `report.clear`,
`report.approve_visual` and `report.render` keep their flat inputs and workflow
grants. `report.write` is not a general noun-action editor. Leased workers also
retain `report.check` and `report.review_visual` under their pinned policies.
Published definitions, policies and recipes are unchanged.
