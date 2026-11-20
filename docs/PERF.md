# Performance notes

Harness: `scripts/perf.py` — fake AtlasClient with a fixed artificial upstream
latency (default 50ms/call), Flask test client, min-of-N reps. Run:

    .venv/bin/python scripts/perf.py 50 3

## Before (v0.1.3, no cache)

Every request hit Atlassian serially. At 50ms simulated upstream latency:

| route                | cold ms | warm ms |
| -------------------- | ------- | ------- |
| jira issues list     |    53.4 |    52.1 |
| jira issue detail    |   106.6 |   105.9 |  (issue + transitions = 2 calls)
| jira projects        |    52.0 |    53.6 |
| conf pages           |    51.3 |    53.6 |
| conf page            |    51.2 |    53.9 |
| conf spaces          |    52.1 |    53.1 |

## After (v0.2.0, TTL cache + wider fetch)

Same harness, same latency:

| route                | cold ms | warm ms |
| -------------------- | ------- | ------- |
| jira issues list     |    55.5 |     0.3 |
| jira issue detail    |   106.4 |     0.3 |  (now also children/epic JQL when epic)
| jira projects        |    51.6 |     0.3 |
| conf pages           |    54.5 |     0.2 |
| conf page            |    53.5 |     0.1 |  (now also ancestors/children/labels/attachments)
| conf spaces          |    50.3 |     0.2 |

## What changed

- `atlas.Cache`: in-process TTL map on AtlasClient (thread-safe).
  TTLs: lists/search 30s, issue/page detail 60s, projects/spaces/editmeta/
  linktypes 120–300s. Any mutation (create/update/delete/comment/transition/
  link/watch/vote/attachment) clears the whole cache — single-user app, writes
  are rare, correctness beats cleverness.
- Frontend lists are virtualized (`vlistRender` in app.js): only the visible
  window ± overscan is in the DOM, so 200-row lists cost the same as 20.
  List limit raised 50 → 200.
- Issue detail fetches epic children via one extra JQL only for Epics.
- No request parallelization was needed: the backend already batches what the
  UI needs into single endpoints; the remaining wins are cache hits.
