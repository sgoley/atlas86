from functools import wraps

from flask import Flask, jsonify, render_template, request

from . import atlas, config
from .convert import html_to_adf, html_to_wiki, sanitize_html

DEFAULT_JQL = "assignee = currentUser() ORDER BY updated DESC"


def _display(person):
    return (person or {}).get("displayName")


def _page_brief(p):
    space = p.get("space")
    if isinstance(space, dict):
        space = space.get("key")
    version = p.get("version") or {}
    return {"id": str(p.get("id")), "title": p.get("title"),
            "space": space or p.get("spaceKey"),
            "updated": version.get("when") or (p.get("history") or {}).get("lastUpdated")}


def create_app():
    app = Flask(__name__)
    holder = {"cfg": config.load_config(), "client": None}

    def make_client(cfg):
        holder["cfg"] = cfg
        holder["client"] = atlas.AtlasClient(cfg) if config.configured(cfg) else None

    make_client(holder["cfg"])

    def api(fn):
        @wraps(fn)
        def w(*a, **kw):
            if holder["client"] is None:
                return jsonify(error="not configured"), 400
            try:
                return fn(*a, **kw)
            except Exception as e:
                return jsonify(error=str(e) or e.__class__.__name__), 502
        return w

    def body():
        return request.get_json(force=True, silent=True) or {}

    @app.get("/api/health")
    def health():
        cfg = config.load_config()
        return {"ok": True, "configured": config.configured(cfg),
                "url": cfg["url"], "user": cfg["user"], "cloud": cfg["cloud"]}

    @app.get("/api/config")
    def get_config():
        cfg = config.load_config()
        return {"url": cfg["url"], "user": cfg["user"], "cloud": cfg["cloud"],
                "has_token": bool(cfg["token"])}

    @app.post("/api/config")
    def set_config():
        b = body()
        old = config.load_config()
        token = b.get("token") or old["token"]
        url = (b.get("url") or "").strip().rstrip("/")
        user = b.get("user") or ""
        cloud = b.get("cloud")
        cloud = cloud if isinstance(cloud, bool) else str(cloud).lower() in ("1", "true", "yes", "on")
        config.save_config(url, user, token, cloud)
        make_client(config.load_config())
        return {"ok": True}

    # ---------- Jira ----------

    @app.get("/api/jira/projects")
    @api
    def jira_projects():
        return [{"key": p.get("key"), "name": p.get("name")}
                for p in (holder["client"].jira.projects() or [])]

    @app.get("/api/jira/issues")
    @api
    def jira_issues():
        jql = request.args.get("jql") or DEFAULT_JQL
        limit = request.args.get("limit", type=int)
        data = holder["client"].jira.jql(jql, fields="*all", limit=limit) or {}
        issues = []
        for i in data.get("issues", []):
            f = i.get("fields") or {}
            issues.append({
                "key": i.get("key"),
                "summary": f.get("summary"),
                "status": (f.get("status") or {}).get("name"),
                "issuetype": (f.get("issuetype") or {}).get("name"),
                "assignee": _display(f.get("assignee")),
                "updated": f.get("updated"),
            })
        return {"jql": jql, "issues": issues}

    @app.get("/api/jira/issue/<key>")
    @api
    def jira_issue(key):
        c = holder["client"]
        issue = c.jira.issue(key, fields="*all", expand="renderedFields") or {}
        f = issue.get("fields") or {}
        rf = issue.get("renderedFields") or {}
        comments = [{"author": _display(cm.get("author")),
                     "created": cm.get("created"),
                     "body_html": cm.get("body") or ""}
                    for cm in (rf.get("comment") or {}).get("comments", [])]
        transitions = [{"id": t.get("id"), "name": t.get("name")}
                       for t in (c.jira.get_issue_transitions(key) or [])]
        return {
            "key": issue.get("key") or key,
            "summary": f.get("summary"),
            "status": (f.get("status") or {}).get("name"),
            "issuetype": (f.get("issuetype") or {}).get("name"),
            "assignee": _display(f.get("assignee")),
            "reporter": _display(f.get("reporter")),
            "updated": f.get("updated"),
            "description_html": rf.get("description") or "",
            "comments": comments,
            "transitions": transitions,
        }

    def _jira_write_fields(b):
        html = sanitize_html(b.get("description_html") or "")
        if holder["cfg"]["cloud"]:
            return {"description": html_to_adf(html)}
        return {"description": html_to_wiki(html)}

    @app.post("/api/jira/issue")
    @api
    def jira_issue_create():
        b = body()
        fields = {"project": {"key": b["project"]}, "summary": b["summary"],
                  "issuetype": {"name": b["issuetype"]}}
        fields.update(_jira_write_fields(b))
        c = holder["client"]
        if holder["cfg"]["cloud"]:
            res = c.jira.post("rest/api/3/issue", data={"fields": fields}) or {}
        else:
            res = c.jira.issue_create(fields) or {}
        return {"key": res.get("key")}

    @app.put("/api/jira/issue/<key>")
    @api
    def jira_issue_update(key):
        b = body()
        c = holder["client"]
        fields = {}
        if b.get("summary") is not None:
            fields["summary"] = b["summary"]
        if "description_html" in b:
            fields.update(_jira_write_fields(b))
        if fields:
            if holder["cfg"]["cloud"]:
                c.jira.put(f"rest/api/3/issue/{key}", data={"fields": fields})
            else:
                c.jira.issue_update(key, fields)
        if b.get("transition_id") not in (None, ""):
            c.jira.set_issue_status_by_transition_id(key, b["transition_id"])
        return {"ok": True}

    @app.post("/api/jira/issue/<key>/comment")
    @api
    def jira_comment(key):
        html = sanitize_html((body().get("body_html")) or "")
        c = holder["client"]
        if holder["cfg"]["cloud"]:
            c.jira.post(f"rest/api/3/issue/{key}/comment",
                        data={"body": html_to_adf(html)})
        else:
            c.jira.issue_add_comment(key, html_to_wiki(html))
        return {"ok": True}

    @app.delete("/api/jira/issue/<key>")
    @api
    def jira_issue_delete(key):
        holder["client"].jira.delete_issue(key)
        return {"ok": True}

    # ---------- Confluence ----------

    @app.get("/api/confluence/spaces")
    @api
    def conf_spaces():
        data = holder["client"].conf.get_all_spaces() or {}
        return [{"key": s.get("key"), "name": s.get("name")}
                for s in data.get("results", [])]

    @app.get("/api/confluence/pages")
    @api
    def conf_pages():
        c = holder["client"].conf
        space = request.args.get("space") or ""
        q = request.args.get("q") or ""
        limit = request.args.get("limit", type=int) or 50
        if q:
            cql = f'type=page AND title~"{q}"'
            if space:
                cql += f' AND space="{space}"'
            data = c.cql(cql, limit=limit) or {}
            raw = data.get("results", [])
        elif space:
            raw = c.get_all_pages_from_space(space, limit=limit) or []
        else:
            # shortcut: "all spaces" isn't a get_all_pages_from_space call;
            # CQL is the only way to list pages across spaces.
            raw = (c.cql("type=page", limit=limit) or {}).get("results", [])
        return {"pages": [_page_brief(p) for p in raw]}

    @app.get("/api/confluence/page/<page_id>")
    @api
    def conf_page(page_id):
        p = holder["client"].conf.get_page_by_id(
            page_id, expand="body.view,version,space") or {}
        space = p.get("space") or {}
        return {
            "id": str(p.get("id")),
            "title": p.get("title"),
            "space": space.get("key"),
            "space_name": space.get("name"),
            "version": (p.get("version") or {}).get("number"),
            "body_html": ((p.get("body") or {}).get("view") or {}).get("value") or "",
        }

    @app.post("/api/confluence/page")
    @api
    def conf_page_create():
        b = body()
        res = holder["client"].conf.create_page(
            b["space"], b["title"], sanitize_html(b.get("body_html") or ""),
            parent_id=b.get("parent_id") or None, representation="storage") or {}
        return {"id": str(res.get("id"))}

    @app.put("/api/confluence/page/<page_id>")
    @api
    def conf_page_update(page_id):
        b = body()
        holder["client"].conf.update_page(
            page_id, b["title"], sanitize_html(b.get("body_html") or ""))
        return {"ok": True}

    @app.delete("/api/confluence/page/<page_id>")
    @api
    def conf_page_delete(page_id):
        holder["client"].conf.remove_page(page_id)
        return {"ok": True}

    @app.get("/")
    def index():
        return render_template("index.html")

    return app


def main():
    create_app().run(host="127.0.0.1", port=8686)


if __name__ == "__main__":
    main()
