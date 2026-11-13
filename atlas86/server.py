import re
from functools import wraps
from urllib.parse import urlparse

from flask import Flask, jsonify, render_template, request

from . import atlas, config
from .convert import html_to_adf, html_to_wiki, sanitize_html

DEFAULT_JQL = "assignee = currentUser() ORDER BY updated DESC"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _display(person):
    return (person or {}).get("displayName")


def _page_brief(p):
    # /rest/api/search wraps each hit in {"content": {...}, "lastModified": ...}
    p, last_mod = (p.get("content") or p), p.get("lastModified")
    space = p.get("space")
    if isinstance(space, dict):
        space = space.get("key")
    version = p.get("version") or {}
    hist = (p.get("history") or {}).get("lastUpdated")
    return {"id": str(p.get("id")), "title": p.get("title"),
            "space": space or p.get("spaceKey"),
            "updated": version.get("when")
            or (hist.get("when") if isinstance(hist, dict) else hist)
            or last_mod}


ATTR_STD = {"priority", "created", "duedate", "labels", "components",
            "fixversions", "resolution"}
ATTR_PAT = ("sprint", "story point", "epic link", "epic name",
            "team", "target start", "target end")


def _norm(n):
    return re.sub(r"[^a-z0-9]", "", (n or "").lower())


def _attr_val(v, sprint=False):
    if v is None or v == "" or v == []:
        return None
    if isinstance(v, list):
        parts = [_attr_val(i, sprint) for i in v]
        return ", ".join(p for p in parts if p) or None
    if isinstance(v, dict):
        for k in ("name", "value", "displayName", "key"):
            if v.get(k):
                return str(v[k])
        return None
    if isinstance(v, str) and sprint:
        m = re.search(r"name=([^,\]]+)", v)  # greenhopper "Sprint@…[…,name=X,…]"
        return m.group(1) if m else v
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _issue_attrs(client, fields):
    try:
        names = client.field_names()
    except Exception:
        names = {}
    out = []
    for fid, val in fields.items():
        label = names.get(fid) or fid
        low = label.lower()
        if _norm(label) not in ATTR_STD and not any(p in low for p in ATTR_PAT):
            continue
        v = _attr_val(val, sprint="sprint" in low)
        if v:
            out.append({"name": label, "value": v})
    return out


def create_app():
    app = Flask(__name__)
    holder = {"cfg": config.load_config(), "client": None}

    def make_client(cfg):
        holder["cfg"] = cfg
        holder["client"] = atlas.AtlasClient(cfg) if config.configured(cfg) else None

    make_client(holder["cfg"])

    @app.before_request
    def _guard():
        # the API holds an Atlassian token: refuse DNS-rebinding (foreign Host)
        # and cross-site browser calls (foreign Origin/Referer on mutations)
        if urlparse(f"//{request.host}").hostname not in LOOPBACK_HOSTS:
            return jsonify(error="refused: bad host"), 403
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            src = request.headers.get("Origin") or request.headers.get("Referer")
            if src and urlparse(src).netloc != request.host:
                return jsonify(error="refused: cross-site origin"), 403

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
                "url": cfg["url"], "user": cfg["user"], "cloud": cfg["cloud"],
                "warn": _insecure_warn(cfg["url"])}

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
        return {"ok": True, "warn": _insecure_warn(url)}

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
            "attributes": _issue_attrs(c, f),
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
        c = holder["client"].conf
        spaces, start = [], 0
        while True:  # get_all_spaces doesn't paginate; loop to a short page
            page = (c.get_all_spaces(start=start, limit=100) or {}
                    ).get("results", [])
            spaces += page
            if len(page) < 100:
                break
            start += 100
        spaces.sort(key=lambda s: (s.get("type") == "personal",
                                   (s.get("name") or "").lower()))
        return [{"key": s.get("key"), "name": s.get("name")}
                for s in spaces]

    @app.get("/api/confluence/pages")
    @api
    def conf_pages():
        c = holder["client"].conf
        space = re.sub(r"[^A-Za-z0-9_]", "", request.args.get("space") or "")
        q = (request.args.get("q") or "").replace('"', "")
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


def _insecure_warn(url):
    if url.startswith("http://") and urlparse(url).hostname not in LOOPBACK_HOSTS:
        return "url is plain http — your token travels in cleartext"
    return None


def main():
    create_app().run(host="127.0.0.1", port=8686)


if __name__ == "__main__":
    main()
