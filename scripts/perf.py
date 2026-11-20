"""Latency harness: fake AtlasClient with artificial network delay, times the
hot read endpoints cold vs warm (cache) via the Flask test client.

    .venv/bin/python scripts/perf.py [latency_ms] [reps]
"""
import sys
import time

sys.path.insert(0, ".")

from atlas86 import atlas as atlas_mod
from atlas86 import config, server

LATENCY = (float(sys.argv[1]) if len(sys.argv) > 1 else 50) / 1000.0
REPS = int(sys.argv[2]) if len(sys.argv) > 2 else 3


class Slow:
    def __init__(self, fn):
        self._fn = fn

    def __call__(self, *a, **kw):
        time.sleep(LATENCY)
        return self._fn(*a, **kw)


def slowify(obj, names):
    for n in names:
        if hasattr(obj, n):
            setattr(obj, n, Slow(getattr(obj, n)))


class FakeJira:
    def __init__(self, cfg):
        slowify(self, ["projects", "jql", "issue", "get", "get_issue_transitions"])

    def get(self, path, **kw):
        return {}

    def projects(self):
        return [{"key": "T", "name": "Test"}]

    def jql(self, jql, fields="*all", limit=None):
        return {"issues": [{
            "key": f"T-{i}",
            "fields": {"summary": f"issue {i}", "updated": "2026-01-01",
                       "status": {"name": "Open"},
                       "issuetype": {"name": "Task"},
                       "assignee": {"displayName": "Ann"}}}
            for i in range(50)]}

    def issue(self, key, fields="*all", expand=None):
        return {"key": key, "fields": {"summary": "s", "labels": ["x"]},
                "renderedFields": {"description": "<p>d</p>",
                                   "comment": {"comments": []}}}

    def get_issue_transitions(self, key):
        return [{"id": "1", "name": "Done"}]


class FakeConf:
    def __init__(self):
        slowify(self, ["get_all_spaces", "get_all_pages_from_space",
                       "cql", "get_page_by_id", "get"])

    def get_all_spaces(self, **kw):
        return {"results": [{"key": "DOC", "name": "Docs"}]}

    def get_all_pages_from_space(self, space, limit=50):
        return [{"id": str(i), "title": f"P{i}", "space": {"key": space},
                 "version": {"when": "2026-01-02"}} for i in range(50)]

    def cql(self, cql, **kw):
        return {"results": []}

    def get_page_by_id(self, page_id, expand=None, **kw):
        return {"id": int(page_id), "title": "Page",
                "space": {"key": "DOC", "name": "Docs"},
                "version": {"number": 3},
                "body": {"view": {"value": "<p>body</p>"}}}

    def get(self, path, **kw):
        return {}


class FakeAtlas:
    def __init__(self, cfg):
        self.jira = FakeJira(cfg)
        self.conf = FakeConf()
        self.cache = atlas_mod.Cache()

    def field_names(self):
        return {}


def main():
    atlas_mod.AtlasClient = FakeAtlas
    app = server.create_app()
    c = app.test_client()
    holder = app.atlas_holder

    def clear_cache():
        cli = holder["client"]
        if cli is not None and hasattr(cli, "cache"):
            cli.cache.clear()
    c.post("/api/config", json={"url": "https://x", "user": "u",
                                "cloud": False, "token": "t"})

    routes = [
        ("home dashboard", "/api/home"),
        ("jira issues list", "/api/jira/issues?jql=project%3DT&limit=50"),
        ("jira issue detail", "/api/jira/issue/T-1"),
        ("jira projects", "/api/jira/projects"),
        ("conf pages", "/api/confluence/pages?space=DOC&limit=50"),
        ("conf page", "/api/confluence/page/1"),
        ("conf spaces", "/api/confluence/spaces"),
    ]

    print(f"simulated upstream latency: {LATENCY*1000:.0f}ms per call, "
          f"{REPS} reps each\n")
    print(f"{'route':<22} {'cold ms':>9} {'warm ms':>9}")
    for name, path in routes:
        c.get("/__cache_bust__")  # noop
        # cold: flush cache each rep
        cold = []
        for _ in range(REPS):
            clear_cache()
            t = time.perf_counter()
            c.get(path)
            cold.append((time.perf_counter() - t) * 1000)
        warm = []
        for _ in range(REPS):
            t = time.perf_counter()
            c.get(path)
            warm.append((time.perf_counter() - t) * 1000)
        print(f"{name:<22} {min(cold):>9.1f} {min(warm):>9.1f}")


if __name__ == "__main__":
    main()
