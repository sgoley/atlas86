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
| jira issues list     |    55.4 |     0.3 |
| jira issue detail    |    53.1 |     0.3 |  (issue+transitions now parallel; was 106)
| jira projects        |    51.8 |     0.3 |
| conf pages           |    54.3 |     0.9 |
| conf page            |    54.0 |     0.3 |  (page+ancestors+children+labels+attachments parallel)
| conf spaces          |    50.9 |     0.1 |

## What changed

- `atlas.Cache`: in-process TTL map on AtlasClient (thread-safe).
  TTLs: lists/search 30s, issue/page detail 60s, projects/spaces/editmeta/
  linktypes 120–300s. Any mutation (create/update/delete/comment/transition/
  link/watch/vote/attachment) clears the whole cache — single-user app, writes
  are rare, correctness beats cleverness.
- Frontend lists are virtualized (`vlistRender` in app.js): only the visible
  window ± overscan is in the DOM, so 200-row lists cost the same as 20.
  List limit raised 50 → 200.
- Detail endpoints fan out upstream calls on a ThreadPoolExecutor:
  issue detail = issue+transitions in parallel (cold halved, 106→53ms @50ms);
  confluence page detail = page+ancestors+children+labels+attachments in
  parallel (5 calls, one round-trip of latency instead of five).
- Issue detail fetches epic children via one extra JQL only for Epics.
- j/k list navigation prefetches the selected item's detail (bare fetch, no
  toast) so ENTER opens from the warm cache.
