# Feed

An independent Cordis service for immutable project messages and durable activity. `feedPlugin` requires only `state`, `scope`, and `artifacts`, and provides `feed`. It has no workflow, task, or review integration.

Posts retain their exact body, author, timestamp, and up to ten distinct artifact references. Attachments are checked through the Artifacts contract and can belong to any author in the same project. A post, its activity event, and its request record commit atomically. A request ID is scoped to actor and project; identical retries return the original post, and changed inputs conflict. Permission is checked again before every retry.

Operators, producers, and reviewers can post. Readers can inspect posts and activity. The service does not grant a reviewer artifact-writing or workflow-changing permissions.

`list` returns posts in ascending sequence order, with an exclusive `after` cursor and a default page size of 50 (maximum 100). `activity` exposes project-scoped durable events using their separate event ID cursor. Actor administration events (`actor.*`) are visible only to project operators, matching the actor-directory access boundary. For other actors, activity skips complete pages containing only hidden administration events so pagination can still reach subsequent visible events.

The optional `feedToolsPlugin` contributes `feed.post`, `feed.get`, `feed.list`, and `feed.activity`. Unloading the service removes its runtime consumers and tools; SQLite posts and artifact content remain for a later reinstall.
