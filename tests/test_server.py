import io
import os
import stat
from urllib.parse import quote

import pytest

from atlas86 import atlas as atlas_mod
from atlas86 import config, server


class FakeJira:
    def __init__(self, cfg):
        self.cfg = cfg
        self.calls = []

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
        return {"key": key,
                "fields": {"summary": "s",
                           "priority": {"name": "High"},
                           "labels": ["a", "b"],
                           "duedate": "2026-02-01",
                           "components": [{"name": "Core"}],
                           "fixVersions": [{"name": "v1"}],
                           "attachment": [{"id": "9", "filename": "f.png",
                                           "mimeType": "image/png", "size": 3}],
                           "issuelinks": [{"id": "55", "type": {"name": "Blocks"},
                                           "outwardIssue": {"key": "T-2",
                                                            "fields": {"summary": "other",
                                                                       "status": {"name": "Open"}}}}],
                           "subtasks": [{"key": "T-1a", "fields": {"summary": "sub",
                                                                   "status": {"name": "Done"}}}],
                           "parent": {"key": "T-9", "fields": {"summary": "epic"}},
                           "watches": {"watchCount": 2, "isWatching": True},
                           "votes": {"votes": 3, "hasVoted": False},
                           "timetracking": {"timeSpent": "1h"},
                           "customfield_10016": 5.0,
                           "customfield_10020": [
                               "com.atlassian.Sprint@1[id=9,name=Sprint 42,state=ACTIVE]"]},
                "renderedFields": {"description": "<p>d</p>",
                                   "comment": {"comments": [
                                       {"author": {"displayName": "Bo"},
                                        "created": "c", "body": "<p>hi</p>"}]}}}

    def get(self, path, **kw):
        self.calls.append(("GET", path, kw))
        if "editmeta" in path:
            return {"fields": {"priority": {"name": "Priority", "required": False,
                                            "allowedValues": [{"name": "High"},
                                                              {"name": "Low"}]},
                               "duedate": {"name": "Due Date"}}}
        if "user/search" in path:
            return [{"accountId": "acc1", "displayName": "Ann",
                     "name": "ann", "emailAddress": "a@x.com"}]
        if "/attachment/9" in path and "content" not in path:
            return {"id": "9", "filename": "f.png", "mimeType": "image/png",
                    "content": "/rest/api/2/attachment/content/9"}
        if path.endswith("/worklog") or "/worklog?" in path:
            return {"worklogs": [{"id": "1", "author": {"displayName": "Bo"},
                                  "timeSpent": "1h", "timeSpentSeconds": 3600,
                                  "started": "2026-01-05T09:00:00.000+0000",
                                  "comment": {"type": "doc", "version": 1,
                                              "content": [{"type": "paragraph",
                                                "content": [{"type": "text",
                                                             "text": "did stuff"}]}]}}]}
        if path.endswith("/remotelink"):
            return [{"id": "77", "object": {"url": "https://ex.com/p",
                                           "title": "Ext Page"}}]
        return {}

    def post(self, path, data=None, **kw):
        self.calls.append(("POST", path, data))
        return {}

    def put(self, path, data=None, **kw):
        self.calls.append(("PUT", path, data))
        return {}

    def delete(self, path, **kw):
        self.calls.append(("DELETE", path))
        return {}

    def issue_update(self, key, fields):
        self.calls.append(("issue_update", key, fields))
        return {}

    def issue_create(self, fields):
        self.calls.append(("issue_create", fields))
        return {"key": "T-100"}

    def delete_issue(self, key):
        self.calls.append(("delete_issue", key))

    def set_issue_status_by_transition_id(self, key, tid):
        self.calls.append(("transition", key, tid))

    def get_issue_transitions(self, key):
        return [{"id": "31", "name": "Done", "to": {"name": "Done"}}]

    def get_issue_link_types(self):
        return [{"id": "10000", "name": "Blocks",
                 "inward": "is blocked by", "outward": "blocks"}]

    def create_issue_link(self, data):
        self.calls.append(("link", data))
        return {}

    def add_attachment_object(self, key, fobj):
        self.calls.append(("attach", key, fobj.read()))
        return [{"id": "10"}]

    def get_all_agile_boards(self, **kw):
        return {"values": [{"id": 1, "name": "Scrum", "type": "scrum",
                            "location": {"projectKey": "T"}}]}

    def get_all_sprints_from_board(self, bid, **kw):
        return {"values": [{"id": 7, "name": "Sprint 1", "state": "active"}]}

    def get_sprint_issues(self, sid, start, limit):
        return {"issues": [{"key": "T-1",
                            "fields": {"summary": "s",
                                       "status": {"id": "1", "name": "To Do"},
                                       "issuetype": {"name": "Story"},
                                       "assignee": {"displayName": "Ann"},
                                       "priority": {"name": "High"},
                                       "customfield_10016": 3.0}}]}

    def get_issues_for_backlog(self, bid):
        return {"issues": [{"key": "T-2",
                            "fields": {"summary": "backlog item",
                                       "status": {"id": "1", "name": "To Do"},
                                       "issuetype": {"name": "Task"},
                                       "assignee": None,
                                       "customfield_10016": 2.0}}]}

    def get_agile_board_configuration(self, bid):
        return {"id": bid, "name": "Scrum",
                "columnConfig": {"columns": [
                    {"name": "To Do", "statuses": [{"id": "1", "name": "To Do"}]},
                    {"name": "Done", "statuses": [{"id": "2", "name": "Done"}]}]}}

    def add_issues_to_sprint(self, sid, issues):
        self.calls.append(("sprint_add", sid, issues))
        return {}

    def move_issues_to_backlog(self, keys):
        self.calls.append(("backlog_move", keys))
        return {}

    def update_rank(self, issues, before, fid):
        self.calls.append(("rank", issues, before, fid))
        return {}

    def create_sprint(self, name, board_id, start_date=None,
                      end_date=None, goal=None):
        self.calls.append(("sprint_create", name, board_id))
        return {"id": 9}

    def update_partially_sprint(self, sid, data):
        self.calls.append(("sprint_state", sid, data))
        return {}


class FakeConf:
    def __init__(self):
        self.calls = []

    def get_all_spaces(self, **kw):
        return {"results": [{"key": "DOC", "name": "Docs"}]}

    def get_all_pages_from_space(self, space, limit=50):
        return [{"id": "42", "title": "Page", "space": {"key": space},
                 "version": {"when": "2026-01-02"}}]

    def cql(self, cql, **kw):
        self.calls.append(("cql", cql))
        return {"results": [{"content": {"id": "7", "title": "Hit",
                                        "spaceKey": "DOC"},
                             "lastModified": "2026-01-03"}]}

    def get_page_by_id(self, page_id, expand=None, **kw):
        return {"id": int(page_id), "title": "Page",
                "space": {"key": "DOC", "name": "Docs"},
                "version": {"number": 3},
                "ancestors": [{"id": "2", "title": "Mid"}],
                "body": {"view": {"value": "<p>body</p>"},
                         "storage": {"value":
                            '<ac:structured-macro ac:name="drawio">'
                            '<ri:attachment ri:filename="arch.drawio"/>'
                            '</ac:structured-macro>'}}}

    def get_page_ancestors(self, page_id):
        return [{"id": "1", "title": "Root"}, {"id": "2", "title": "Mid"}]

    def get_child_pages(self, page_id):
        return [{"id": "43", "title": "Child", "type": "page"}]

    def get_page_labels(self, page_id, **kw):
        return {"results": [{"prefix": "global", "name": "runbook"}]}

    def get_attachments_from_content(self, page_id, **kw):
        return {"results": [{"id": "5", "title": "doc.pdf",
                             "metadata": {"mediaType": "application/pdf"},
                             "extensions": {"fileSize": 10},
                             "version": {"number": 1},
                             "_links": {"download":
                                        "/download/attachments/42/doc.pdf?version=1"}},
                            {"id": "6", "title": "arch.drawio",
                             "metadata": {"mediaType": "application/xml"},
                             "extensions": {"fileSize": 900},
                             "version": {"number": 1},
                             "_links": {"download":
                                        "/download/attachments/42/arch.drawio?version=1"}},
                            {"id": "7", "title": "arch.png",
                             "metadata": {"mediaType": "image/png"},
                             "extensions": {"fileSize": 4000},
                             "version": {"number": 1},
                             "_links": {"download":
                                        "/download/attachments/42/arch.png?version=1"}}]}

    def get(self, path, **kw):
        self.calls.append(("GET", path, kw))
        if path.startswith("/download/"):
            return b"%PDF-fake"
        if "version" in path:
            return {"results": [{"number": 3, "when": "2026-01-02T00:00:00Z",
                                 "by": {"displayName": "Ann"}, "message": "edit"}]}
        if "restriction" in path:
            return {"restrictions": {"read": {"results": [
                {"operation": {"target": {"type": "group",
                                          "displayName": "admins"}}}]}}}
        return {}

    def set_page_label(self, page_id, label):
        self.calls.append(("label_add", page_id, label))

    def remove_page_label(self, page_id, label):
        self.calls.append(("label_del", page_id, label))

    def move_page(self, space_key, page_id, target_id=None,
                  target_title=None, position=None):
        self.calls.append(("move", space_key, page_id, target_id, position))

    def create_page(self, space, title, body, parent_id=None,
                    representation=None, **kw):
        self.calls.append(("copy", space, title, parent_id))
        return {"id": "99"}

    def attach_content(self, content, name, **kw):
        self.calls.append(("attach", name, content))
        return {}


class FakeAtlas:
    instances = []

    def __init__(self, cfg):
        self.cfg = cfg
        self.jira = FakeJira(cfg)
        self.conf = FakeConf()
        FakeAtlas.instances.append(self)

    def field_names(self):
        return {"priority": "Priority", "labels": "Labels",
                "customfield_10016": "Story Points",
                "customfield_10020": "Sprint",
                "customfield_10030": "Rank"}


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
    assert r.get_json() == {"ok": True, "warn": None}

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


def test_guard_refuses_foreign_host_and_origin(client):
    assert client.get("/api/health", headers={"Host": "evil.com"}).status_code == 403
    r = client.post("/api/config", json={"url": "https://x"},
                    headers={"Origin": "https://evil.com"})
    assert r.status_code == 403
    r = client.post("/api/config", json={"url": "https://x"},
                    headers={"Origin": "http://localhost"})
    assert r.status_code == 200


def test_config_warns_on_plain_http_url(client):
    r = client.post("/api/config", json={
        "url": "http://jira.internal", "user": "u", "token": "t"})
    assert "cleartext" in r.get_json()["warn"]
    assert "cleartext" in client.get("/api/health").get_json()["warn"]


def test_confluence_search_escapes_quotes(client):
    client.post("/api/config", json={"url": "https://x", "user": "u",
                                      "cloud": False, "token": "t"})
    r = client.get('/api/confluence/pages?q=a%22b%20OR%201%3D1&space=DOC')
    assert r.status_code == 200
    page = r.get_json()["pages"][0]  # /rest/api/search wraps hits in "content"
    assert page["id"] == "7" and page["title"] == "Hit"
    assert page["space"] == "DOC" and page["updated"] == "2026-01-03"


def test_jira_issue_attributes(client):
    client.post("/api/config", json={"url": "https://x", "user": "u",
                                      "cloud": True, "token": "t"})
    r = client.get("/api/jira/issue/T-1")
    attrs = {a["name"]: a["value"] for a in r.get_json()["attributes"]}
    assert attrs["Priority"] == "High"
    assert attrs["Labels"] == "a, b"
    assert attrs["Story Points"] == "5"
    assert attrs["Sprint"] == "Sprint 42"


def test_confluence_page(client):
    client.post("/api/config", json={"url": "https://x", "user": "u",
                                      "cloud": False, "token": "t"})
    r = client.get("/api/confluence/page/42")
    assert r.status_code == 200
    data = r.get_json()
    assert data["id"] == "42" and data["title"] == "Page"
    assert data["space"] == "DOC" and data["space_name"] == "Docs"
    assert data["version"] == 3 and data["body_html"] == "<p>body</p>"


def _configured(client):
    client.post("/api/config", json={"url": "https://x", "user": "u",
                                      "cloud": False, "token": "t"})


def test_jira_issue_detail_full_fields(client):
    _configured(client)
    d = client.get("/api/jira/issue/T-1").get_json()
    assert d["priority"]["name"] == "High"
    assert d["labels"] == ["a", "b"]
    assert d["components"] == ["Core"] and d["fixVersions"] == ["v1"]
    assert d["duedate"] == "2026-02-01"
    assert d["epic"] == "T-9"
    assert d["parent"]["key"] == "T-9"
    assert d["watches"]["watchCount"] == 2 and d["watches"]["isWatching"] is True
    assert d["votes"]["votes"] == 3 and d["votes"]["hasVoted"] is False
    assert d["timetracking"]["timeSpent"] == "1h"
    assert d["attachments"][0]["filename"] == "f.png"
    assert d["attachments"][0]["url"] == "/api/jira/attachment/9"
    assert d["links"][0]["key"] == "T-2" and d["links"][0]["type"] == "Blocks"
    assert d["subtasks"][0]["key"] == "T-1a"
    assert d["transitions"][0]["to"] == "Done"
    attrs = {a["name"]: a["value"] for a in d["attributes"]}
    assert attrs["Story Points"] == "5" and attrs["Sprint"] == "Sprint 42"


def test_jira_field_edit(client):
    _configured(client)
    r = client.put("/api/jira/issue/T-1", json={"fields": {
        "priority": "Low", "duedate": "2026-03-01",
        "labels": "x, y", "components": "Core, UI",
        "assignee": {"accountId": "acc1"}}})
    assert r.get_json() == {"ok": True}
    cli = FakeAtlas.instances[-1]
    upd = [c for c in cli.jira.calls if c[0] == "issue_update"]
    assert upd, "issue_update not called"
    fields = upd[-1][2]
    assert fields["priority"] == {"name": "Low"}
    assert fields["duedate"] == "2026-03-01"
    assert fields["labels"] == ["x", "y"]
    assert fields["components"] == [{"name": "Core"}, {"name": "UI"}]
    assert fields["assignee"] == {"accountId": "acc1"}


def test_jira_editmeta_and_users(client):
    _configured(client)
    meta = client.get("/api/jira/issue/T-1/editmeta").get_json()
    assert meta["fields"]["priority"]["allowedValues"][0]["name"] == "High"
    users = client.get("/api/jira/users?q=an").get_json()
    assert users[0]["accountId"] == "acc1"


def test_jira_watchers_vote_link_delete(client):
    _configured(client)
    assert client.post("/api/jira/issue/T-1/watchers",
                       json={}).get_json() == {"ok": True}
    assert client.delete("/api/jira/issue/T-1/watchers").get_json() == {"ok": True}
    assert client.post("/api/jira/issue/T-1/vote",
                       json={}).get_json() == {"ok": True}
    types = client.get("/api/jira/issue/T-1/linktypes").get_json()
    assert types[0]["name"] == "Blocks"
    assert client.post("/api/jira/issue/T-1/link", json={
        "type": "Blocks", "other": "T-3",
        "direction": "outward"}).get_json() == {"ok": True}
    assert client.delete("/api/jira/issue/T-1/link/55").get_json() == {"ok": True}
    cli = FakeAtlas.instances[-1]
    kinds = [c[0] for c in cli.jira.calls]
    assert "link" in kinds
    link_call = [c for c in cli.jira.calls if c[0] == "link"][-1]
    assert link_call[1]["outwardIssue"] == {"key": "T-1"}
    assert link_call[1]["inwardIssue"] == {"key": "T-3"}


def test_jira_attachment_roundtrip(client):
    _configured(client)
    r = client.get("/api/jira/attachment/9")
    assert r.status_code == 200
    assert r.mimetype == "image/png"
    assert "f.png" in r.headers["Content-Disposition"]
    up = client.post("/api/jira/issue/T-1/attachment",
                     data={"file": (io.BytesIO(b"PNG"), "f.png")},
                     content_type="multipart/form-data")
    assert up.get_json() == {"ok": True}
    cli = FakeAtlas.instances[-1]
    assert any(c[0] == "attach" and c[1] == "T-1" for c in cli.jira.calls)


def test_jira_bulk_transition(client):
    _configured(client)
    r = client.post("/api/jira/transition",
                    json={"keys": ["T-1", "T-2"], "transition_id": "31"})
    assert r.get_json() == {"ok": True, "errors": []}
    cli = FakeAtlas.instances[-1]
    assert sum(1 for c in cli.jira.calls if c[0] == "transition") == 2


def test_jira_boards_sprints(client):
    _configured(client)
    boards = client.get("/api/jira/boards?project=T").get_json()
    assert boards[0]["name"] == "Scrum" and boards[0]["id"] == 1
    sprints = client.get("/api/jira/boards/1/sprints").get_json()
    assert sprints[0]["name"] == "Sprint 1"
    issues = client.get("/api/jira/sprints/7/issues").get_json()
    assert issues[0]["key"] == "T-1" and issues[0]["points"] == "3"
    assert issues[0]["status"] == "To Do"


def test_confluence_page_extras(client):
    _configured(client)
    d = client.get("/api/confluence/page/42").get_json()
    assert d["ancestors"][0]["title"] == "Root"
    assert d["children"][0]["id"] == "43"
    assert d["labels"] == ["runbook"]
    assert d["attachments"][0]["filename"] == "doc.pdf"
    assert d["attachments"][0]["url"].startswith("/api/confluence/attachment?dl=")
    hist = client.get("/api/confluence/page/42/history").get_json()
    assert hist[0]["number"] == 3 and hist[0]["by"] == "Ann"


def test_confluence_cql_and_attachment(client):
    _configured(client)
    r = client.get("/api/confluence/cql?cql=type%3Dpage")
    assert r.get_json()["pages"][0]["id"] == "7"
    dl = quote("/download/attachments/42/doc.pdf?version=1", safe="")
    r = client.get("/api/confluence/attachment?dl=" + dl)
    assert r.status_code == 200
    assert r.get_data() == b"%PDF-fake"
    bad = client.get("/api/confluence/attachment?dl=/etc/passwd")
    assert bad.status_code == 400
    up = client.post("/api/confluence/page/42/attachment",
                     data={"file": (io.BytesIO(b"PDF"), "doc.pdf")},
                     content_type="multipart/form-data")
    assert up.get_json() == {"ok": True}


def test_jira_backlog_and_rank(client):
    _configured(client)
    bl = client.get("/api/jira/boards/1/backlog").get_json()
    assert bl[0]["key"] == "T-2" and bl[0]["points"] == "2"
    cfg = client.get("/api/jira/boards/1/configuration").get_json()
    assert cfg["columns"][0]["name"] == "To Do"
    assert cfg["columns"][0]["statuses"][0]["id"] == "1"

    r = client.post("/api/jira/sprints/7/issues", json={"keys": ["T-2"]})
    assert r.get_json() == {"ok": True}
    r = client.post("/api/jira/backlog/issues", json={"keys": ["T-2"]})
    assert r.get_json() == {"ok": True}
    r = client.post("/api/jira/issues/rank",
                    json={"keys": ["T-2"], "before": "T-1"})
    assert r.get_json() == {"ok": True}
    calls = FakeAtlas.instances[-1].jira.calls
    assert ("sprint_add", "7", ["T-2"]) in calls
    assert ("backlog_move", ["T-2"]) in calls
    assert any(c[0] == "rank" and c[2] == "T-1" and c[3] == "customfield_10030"
               for c in calls)


def test_jira_sprint_lifecycle(client):
    _configured(client)
    r = client.post("/api/jira/sprints",
                    json={"name": "Sprint 2", "board_id": 1})
    assert r.get_json() == {"id": 9}
    r = client.post("/api/jira/sprints/7/state", json={"state": "active"})
    assert r.get_json() == {"ok": True}
    r = client.post("/api/jira/sprints/7/state", json={"state": "bogus"})
    assert r.status_code == 400
    calls = FakeAtlas.instances[-1].jira.calls
    assert ("sprint_create", "Sprint 2", 1) in calls
    assert ("sprint_state", "7", {"state": "active"}) in calls


def test_jira_worklog_and_remlink(client):
    _configured(client)
    d = client.get("/api/jira/issue/T-1/worklog").get_json()
    w = d["worklogs"][0]
    assert w["timeSpent"] == "1h" and w["comment"] == "did stuff"
    assert w["author"] == "Bo"

    # server/DC config -> plain-text comment
    r = client.post("/api/jira/issue/T-1/worklog",
                    json={"timeSpent": "2h", "started": "2026-01-06",
                          "comment": "more"})
    assert r.get_json() == {"ok": True}
    posts = [c for c in FakeAtlas.instances[-1].jira.calls
             if c[0] == "POST" and "worklog" in str(c[1])]
    assert posts[-1][2]["comment"] == "more"
    assert posts[-1][2]["timeSpent"] == "2h"

    # cloud config -> comment must be ADF doc
    client.post("/api/config", json={"url": "https://x", "user": "u",
                                      "cloud": True, "token": "t"})
    client.post("/api/jira/issue/T-1/worklog",
                json={"timeSpent": "1h", "comment": "cloud note"})
    posts = [c for c in FakeAtlas.instances[-1].jira.calls
             if c[0] == "POST" and "worklog" in str(c[1])]
    assert posts[-1][2]["comment"]["type"] == "doc"

    # detail payload includes remote links
    it = client.get("/api/jira/issue/T-1").get_json()
    assert it["remote_links"][0]["title"] == "Ext Page"

    r = client.post("/api/jira/issue/T-1/remlink",
                    json={"url": "https://ex.com/x", "title": "X"})
    assert r.get_json() == {"ok": True}
    r = client.delete("/api/jira/issue/T-1/remlink/77")
    assert r.get_json() == {"ok": True}


def test_jira_subtask_parent(client):
    _configured(client)
    r = client.post("/api/jira/issue", json={
        "project": "T", "summary": "sub", "issuetype": "Sub-task",
        "parent": "T-1"})
    assert r.get_json() == {"key": "T-100"}
    created = [c for c in FakeAtlas.instances[-1].jira.calls
               if c[0] == "issue_create"]
    assert created[-1][1]["parent"] == {"key": "T-1"}


def test_confluence_labels_move_copy_restrictions_diagrams(client):
    _configured(client)
    r = client.post("/api/confluence/page/42/label", json={"name": "new"})
    assert r.get_json() == {"ok": True}
    r = client.delete("/api/confluence/page/42/label?name=runbook")
    assert r.get_json() == {"ok": True}
    r = client.put("/api/confluence/page/42/move",
                   json={"space": "DOC", "parent_id": "2"})
    assert r.get_json() == {"ok": True}
    r = client.post("/api/confluence/page/42/copy",
                    json={"title": "Page (copy)", "space": "DOC"})
    assert r.get_json() == {"id": "99"}
    restr = client.get("/api/confluence/page/42/restrictions").get_json()
    assert restr[0]["type"] == "group" and restr[0]["name"] == "admins"

    conf = FakeAtlas.instances[-1].conf.calls
    assert ("label_add", "42", "new") in conf
    assert ("label_del", "42", "runbook") in conf
    assert ("move", "DOC", "42", "2", "append") in conf
    assert any(c[0] == "copy" and c[3] == "2" for c in conf)  # parent = last ancestor

    d = client.get("/api/confluence/page/42").get_json()
    assert d["diagrams"][0]["name"] == "arch.drawio"
    assert d["diagrams"][0]["image"] is True
    assert "arch.png" in d["diagrams"][0]["url"]
