import os
import stat

import pytest

from atlas86 import atlas as atlas_mod
from atlas86 import config, server


class FakeJira:
    def __init__(self, cfg):
        self.cfg = cfg

    def projects(self):
        return [{"key": "T", "name": "Test"}]

    def jql(self, jql, fields="*all", limit=None):
        return {"issues": [{
            "key": "T-1",
            "fields": {
                "summary": "s", "updated": "2026-01-01",
                "status": {"name": "Open"},
                "issuetype": {"name": "Bug"},
                "assignee": {"displayName": "Ann"},
            },
        }]}

    def issue(self, key, fields="*all", expand=None):
        return {"key": key, "fields": {"summary": "s"},
                "renderedFields": {"description": "<p>d</p>",
                                   "comment": {"comments": [
                                       {"author": {"displayName": "Bo"},
                                        "created": "c", "body": "<p>hi</p>"}]}}}

    def get_issue_transitions(self, key):
        return [{"id": "31", "name": "Done"}]


class FakeConf:
    def get_all_spaces(self):
        return {"results": [{"key": "DOC", "name": "Docs"}]}

    def get_all_pages_from_space(self, space, limit=50):
        return [{"id": "42", "title": "Page", "space": {"key": space},
                 "version": {"when": "2026-01-02"}}]

    def cql(self, cql, limit=None):
        return {"results": [{"id": "7", "title": "Hit", "spaceKey": "DOC",
                             "version": {"when": "2026-01-03"}}]}

    def get_page_by_id(self, page_id, expand=None):
        return {"id": int(page_id), "title": "Page",
                "space": {"key": "DOC", "name": "Docs"},
                "version": {"number": 3},
                "body": {"view": {"value": "<p>body</p>"}}}


class FakeAtlas:
    instances = []

    def __init__(self, cfg):
        self.cfg = cfg
        self.jira = FakeJira(cfg)
        self.conf = FakeConf()
        FakeAtlas.instances.append(self)


@pytest.fixture
def client(tmp_path, monkeypatch):
    env = tmp_path / ".atlas86.env"
    monkeypatch.setattr(config, "ENV_FILE", env)
    for var in config.VARS:
        monkeypatch.delenv(var, raising=False)
    FakeAtlas.instances.clear()
    monkeypatch.setattr(atlas_mod, "AtlasClient", FakeAtlas)
    return server.create_app().test_client()


def test_unconfigured_returns_400(client):
    r = client.get("/api/jira/projects")
    assert r.status_code == 400
    assert r.get_json() == {"error": "not configured"}
    assert client.get("/api/health").get_json()["configured"] is False


def test_config_roundtrip_never_returns_token(client, tmp_path):
    r = client.post("/api/config", json={
        "url": "https://x.atlassian.net/", "user": "me@x.com",
        "cloud": True, "token": "sekrit"})
    assert r.get_json() == {"ok": True}

    cfg = client.get("/api/config").get_json()
    assert cfg == {"url": "https://x.atlassian.net", "user": "me@x.com",
                   "cloud": True, "has_token": True}
    health = client.get("/api/health").get_json()
    assert health["configured"] is True and health["url"].endswith("atlassian.net")

    for resp in (client.get("/api/config"), client.get("/api/health"),
                 client.get("/api/jira/projects")):
        assert "sekrit" not in resp.get_data(as_text=True)

    assert stat.S_IMODE(os.stat(config.ENV_FILE).st_mode) == 0o600
    assert FakeAtlas.instances and FakeAtlas.instances[-1].cfg["cloud"] is True


def test_jira_issues_list(client):
    client.post("/api/config", json={"url": "https://x", "user": "u",
                                      "cloud": False, "token": "t"})
    r = client.get("/api/jira/issues?jql=project%3DT&limit=5")
    assert r.status_code == 200
    data = r.get_json()
    assert data["jql"] == "project=T"
    assert data["issues"][0]["key"] == "T-1"
    assert data["issues"][0]["assignee"] == "Ann"


def test_confluence_page(client):
    client.post("/api/config", json={"url": "https://x", "user": "u",
                                      "cloud": False, "token": "t"})
    r = client.get("/api/confluence/page/42")
    assert r.status_code == 200
    data = r.get_json()
    assert data["id"] == "42" and data["title"] == "Page"
    assert data["space"] == "DOC" and data["space_name"] == "Docs"
    assert data["version"] == 3 and data["body_html"] == "<p>body</p>"
