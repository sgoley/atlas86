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

## v0.4.0 re-run (same harness, fake updated for raw-REST detail fan-out)

| route                | cold ms | warm ms |
| -------------------- | ------- | ------- |
| home dashboard       |    56.0 |     0.6 |  (4 parallel JQL buckets, one round-trip)
| jira issues list     |    53.7 |     0.4 |
| jira issue detail    |    53.1 |     0.3 |  (issue+transitions+remotelink parallel)
| jira projects        |    55.2 |     0.3 |
| conf pages           |    53.7 |     0.4 |
| conf page            |    52.4 |     0.4 |  (+ diagram-source fetches, capped at 3)
| conf spaces          |    52.5 |     0.3 |

New reads added this tranche and their cache TTLs: `/api/home` 60s,
`/api/jira/project/<k>/versions` 120s, conf page comments 60s. All warm
reads stay sub-millisecond; cold reads cost one upstream round-trip because
every multi-call endpoint fans out on a thread pool.

## v0.5.0 re-run (same harness)

| route                | cold ms | warm ms |
| -------------------- | ------- | ------- |
| home dashboard       |    55.7 |     0.3 |
| jira issues list     |    51.0 |     0.2 |
| jira issue detail    |    55.0 |     0.1 |  (changelog rides the same issue call, +0 upstream)
| jira sprint report   |    50.8 |     0.1 |
| jira projects        |    50.8 |     0.1 |
| conf pages           |    53.3 |     0.1 |
| conf page            |    55.7 |     0.1 |  (+ watch-status call, still one round-trip)
| conf spaces          |    53.3 |     0.1 |

Issue history (`expand=changelog`) adds zero upstream calls — it piggybacks
on the existing `issue()` fetch. Sprint report is a single agile GET.
Conf page detail gained a `user/watch/content` status check, still parallel
with the other five fetches. Bulk edit is N sequential PUTs by design (≤50
keys, write path, cache cleared anyway).
