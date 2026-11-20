import io
import json
import re
from concurrent.futures import ThreadPoolExecutor
from functools import wraps
from urllib.parse import quote, urlparse

from flask import Flask, Response, jsonify, render_template, request

from . import atlas, config
from .convert import adf_to_text, html_to_adf, html_to_wiki, sanitize_html

DEFAULT_JQL = "assignee = currentUser() ORDER BY updated DESC"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

# fields the detail view renders structurally; everything else lands in attributes
STRUCT_FIELDS = {"summary", "status", "issuetype", "assignee", "reporter",
                 "description", "comment", "attachment", "issuelinks",
                 "subtasks", "watches", "votes", "timetracking", "worklog",
                 "project", "parent", "created", "updated", "resolutiondate",
                 "lastViewed", "progress", "aggregateprogress", "workratio",
                 "issuerestriction", "security"}

# friendly name -> Jira edit payload builder (PUT /issue fields)
_EDIT_VAL = {
    "priority": lambda v: {"name": str(v)},
    "duedate": lambda v: str(v)[:10],
    "labels": lambda v: [x.strip() for x in
                         (v if isinstance(v, list) else str(v).split(","))
                         if x.strip()],
    "components": lambda v: [{"name": x.strip()} for x in
                             (v if isinstance(v, list) else str(v).split(","))
                             if x.strip()],
    "fixversions": lambda v: [{"name": x.strip()} for x in
                              (v if isinstance(v, list) else str(v).split(","))
                              if x.strip()],
    "environment": lambda v: str(v),
    "summary": lambda v: str(v),
}


def _display(person):
    return (person or {}).get("displayName")


def _parallel(fns):
    """Run zero-arg thunks concurrently; each returns its own result/None."""
    if not fns:
        return []
    with ThreadPoolExecutor(max_workers=len(fns)) as ex:
        return list(ex.map(lambda f: f(), fns))


def _ver(client):
    return "3" if getattr(client, "cloud", False) else "2"


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


# ---------- generic field -> text ----------

def _field_text(v, depth=0):
    if v is None or v == "" or v == [] or depth > 4:
        return None
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (int, float)):
        return str(int(v)) if float(v).is_integer() else str(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        if s.startswith("com.atlassian.greenhopper") or "Sprint@" in s[:60]:
            m = re.search(r"name=([^,\]]+)", s)
            return m.group(1) if m else s[:120]
        if s.startswith("{") and '"type"' in s[:40]:
            try:
                return adf_to_text(json.loads(s)) or s[:120]
            except Exception:
                return s[:120]
        return s if len(s) <= 240 else s[:237] + "..."
    if isinstance(v, dict):
        if v.get("type") and "content" in v:  # ADF node
            return adf_to_text(v) or None
        for k in ("name", "value", "displayName", "key", "summary", "title"):
            if v.get(k):
                return _field_text(v[k], depth + 1)
        parts = [_field_text(x, depth + 1) for x in v.values()]
        joined = ", ".join(p for p in parts if p)
        return joined[:240] or None
    if isinstance(v, list):
        parts = []
        for i in v:
            t = _field_text(i, depth + 1)
            if t and t not in parts:
                parts.append(t)
        joined = ", ".join(parts)
        return joined[:240] or None
    return str(v)[:240]


def _diagram_previews(storage_html, attachments):
    """Best-effort: find image attachments referenced by diagram macros in
    storage format and pair them with their download URLs. Drawio/gliffy
    source files get a same-basename image sibling when one exists."""
    if not storage_html or not attachments:
        return []
    wanted = set()
    # filenames referenced inside diagram macro blocks
    for m in re.finditer(
            r'<ac:structured-macro[^>]*ac:name="(?:drawio|gliffy|diagram|plantuml[^"]*)"[^>]*>(.*?)</ac:structured-macro>',
            storage_html, re.I | re.S):
        wanted.update(re.findall(r'ri:filename="([^"]+)"', m.group(1)))
    # also catch self-closing/loose attachment refs on drawio pages
    if not wanted and re.search(r'drawio|gliffy', storage_html, re.I):
        wanted.update(re.findall(r'ri:filename="([^"]+)"', storage_html))
    by_name = {a["filename"]: a for a in attachments if a.get("filename")}
    stem = lambda n: re.sub(r'\.(drawio|gliffy|xml|png|svg|jpe?g)$', '', n, flags=re.I)
    out, seen = [], set()
    for name in wanted:
        a = by_name.get(name)
        # prefer a rendered sibling image over the diagram source file
        if a and not (a.get("mime") or "").startswith("image/"):
            base = stem(name)
            for ext in (".png", ".svg", ".jpg", ".jpeg"):
                cand = by_name.get(base + ext)
                if cand:
                    a = cand
                    break
        if not a and name not in by_name:
            base = stem(name)
            for ext in (".png", ".svg", ".jpg", ".jpeg"):
                cand = by_name.get(base + ext)
                if cand:
                    a = cand
                    break
        if not a or not a.get("url") or name in seen:
            continue
        seen.add(name)
        mime = a.get("mime") or ""
        out.append({"name": name, "url": a["url"],
                    "image": mime.startswith("image/") or
                    (a.get("filename") or "").lower().endswith(
                        (".png", ".svg", ".jpg", ".jpeg"))})
    return out[:20]


_FIELD_LABELS = {"duedate": "Due Date", "fixVersions": "Fix Versions",
                 "components": "Components", "priority": "Priority",
                 "labels": "Labels", "environment": "Environment"}


def _issue_attrs(client, fields):
    try:
        names = client.field_names()
    except Exception:
        names = {}
    out = []
    for fid, val in fields.items():
        if fid in STRUCT_FIELDS:
            continue
        label = names.get(fid) or _FIELD_LABELS.get(fid) or fid
        v = _field_text(val)
        if v:
            out.append({"name": label, "value": v})
    return out


def _attachments_meta(attachments):
    out = []
    for a in attachments or []:
        out.append({
            "id": str(a.get("id")),
            "filename": a.get("filename") or a.get("name"),
            "size": a.get("size") or a.get("fileSize"),
            "mime": a.get("mimeType") or (a.get("metadata") or {}).get("mediaType"),
            "created": a.get("created"),
            "author": _display(a.get("author")),
        })
    return out


def _issue_links(fields):
    out = []
    for l in fields.get("issuelinks") or []:
        t = l.get("type") or {}
        for side, key in (("outward", "outwardIssue"), ("inward", "inwardIssue")):
            other = l.get(key)
            if not other:
                continue
            of = other.get("fields") or {}
            out.append({"id": str(l.get("id")), "type": t.get("name"),
                        "direction": side,
                        "desc": t.get(side) or t.get("name"),
                        "key": other.get("key"),
                        "summary": of.get("summary"),
                        "status": (of.get("status") or {}).get("name")})
    return out


def _epic_key(client, fields):
    parent = fields.get("parent")
    if parent:
        return parent.get("key")
    try:
        names = client.field_names()
    except Exception:
        names = {}
    for fid, val in fields.items():
        if "epic link" in (names.get(fid) or "").lower():
            v = _field_text(val)
            if v:
                return v.split(",")[0].strip()
    return None


def _sprint_points(client, fields):
    try:
        names = client.field_names()
    except Exception:
        names = {}
    pts = None
    for fid, val in fields.items():
        if "story point" in (names.get(fid) or "").lower() \
                or "story point" in fid.lower():
            pts = _field_text(val)
            break
    return pts


def create_app():
    app = Flask(__name__)
    holder = {"cfg": config.load_config(), "client": None}

    def make_client(cfg):
        holder["cfg"] = cfg
        holder["client"] = atlas.AtlasClient(cfg) if config.configured(cfg) else None

    make_client(holder["cfg"])
    app.atlas_holder = holder  # exposed for tests / scripts/perf.py

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

    def cache_get(key):
        c = getattr(holder["client"], "cache", None)
        return c.get(key) if c else None

    def cache_set(key, val, ttl=60):
        c = getattr(holder["client"], "cache", None)
        if c:
            c.set(key, val, ttl)

    def cache_wrap(key, ttl, fn):
        hit = cache_get(key)
        if hit is not None:
            return hit
        val = fn()
        cache_set(key, val, ttl)
        return val

    def invalidate():
        c = getattr(holder["client"], "cache", None)
        if c:
            c.clear()

    def binary(data, filename, mime):
        return Response(data, mimetype=mime or "application/octet-stream",
                        headers={"Content-Disposition":
                                 f"attachment; filename*=UTF-8''{quote(filename or 'file')}"})

    # ---------- health / config ----------

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
        return cache_wrap("jira:projects", 300, lambda: [
            {"key": p.get("key"), "name": p.get("name")}
            for p in (holder["client"].jira.projects() or [])])

    @app.get("/api/jira/issues")
    @api
    def jira_issues():
        jql = request.args.get("jql") or DEFAULT_JQL
        limit = request.args.get("limit", type=int)
        key = f"jira:issues:{jql}:{limit}"

        def fetch():
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
                    "priority": (f.get("priority") or {}).get("name"),
                    "updated": f.get("updated"),
                })
            return {"jql": jql, "issues": issues}

        return cache_wrap(key, 30, fetch)

    def _issue_detail(key):
        c = holder["client"]
        issue, trans, remotes = _parallel([
            lambda: c.jira.issue(key, fields="*all", expand="renderedFields") or {},
            lambda: c.jira.get_issue_transitions(key) or [],
            lambda: c.jira.get(f"rest/api/{_ver(c)}/issue/{key}/remotelink") or [],
        ])
        f = issue.get("fields") or {}
        rf = issue.get("renderedFields") or {}
        comments = [{"author": _display(cm.get("author")),
                     "created": cm.get("created"),
                     "body_html": cm.get("body") or ""}
                    for cm in (rf.get("comment") or {}).get("comments", [])]
        transitions = [{"id": t.get("id"), "name": t.get("name"),
                        "to": ((t.get("to") or {}).get("name"))}
                       for t in trans]
        itype = (f.get("issuetype") or {}).get("name") or ""
        epic = _epic_key(c, f)
        children = None
        if itype.lower() == "epic":
            try:
                data = c.jira.jql(f'parent = {key} ORDER BY key',
                                  fields="summary,status", limit=100) or {}
                children = [{"key": i.get("key"),
                             "summary": (i.get("fields") or {}).get("summary"),
                             "status": (((i.get("fields") or {}).get("status") or {})
                                        .get("name"))}
                            for i in data.get("issues", [])]
            except Exception:
                children = None  # some servers reject parent= on epics; degrade quietly
        atts = []
        for a in f.get("attachment") or []:
            aid = a.get("id")
            atts.append({**_attachments_meta([a])[0],
                         "url": f"/api/jira/attachment/{aid}"})
        return {
            "key": issue.get("key") or key,
            "summary": f.get("summary"),
            "status": f.get("status"),
            "issuetype": f.get("issuetype"),
            "priority": f.get("priority"),
            "assignee": f.get("assignee"),
            "reporter": f.get("reporter"),
            "created": f.get("created"),
            "updated": f.get("updated"),
            "duedate": f.get("duedate"),
            "labels": f.get("labels") or [],
            "components": [x.get("name") for x in f.get("components") or []],
            "fixVersions": [x.get("name") for x in f.get("fixVersions") or []],
            "description_html": rf.get("description") or "",
            "comments": comments,
            "transitions": transitions,
            "attributes": _issue_attrs(c, f),
            "attachments": atts,
            "links": _issue_links(f),
            "subtasks": [{"key": s.get("key"),
                          "summary": (s.get("fields") or {}).get("summary"),
                          "status": (((s.get("fields") or {}).get("status") or {})
                                     .get("name"))}
                         for s in f.get("subtasks") or []],
            "parent": ({"key": f["parent"].get("key"),
                        "summary": (f["parent"].get("fields") or {}).get("summary")}
                       if f.get("parent") else None),
            "epic": epic,
            "children": children,
            "watches": f.get("watches"),
            "votes": f.get("votes"),
            "timetracking": f.get("timetracking"),
            "remote_links": [{"id": str(r.get("id")),
                              "title": (r.get("object") or {}).get("title"),
                              "url": (r.get("object") or {}).get("url")}
                             for r in remotes if isinstance(r, dict)],
        }

    @app.get("/api/jira/issue/<key>")
    @api
    def jira_issue(key):
        return cache_wrap(f"jira:issue:{key}", 60,
                          lambda: _issue_detail(key))

    @app.get("/api/jira/issue/<key>/editmeta")
    @api
    def jira_editmeta(key):
        ver = _ver(holder["client"])
        meta = holder["client"].jira.get(
            f"rest/api/{ver}/issue/{key}/editmeta") or {}
        fields = {}
        for fid, fm in (meta.get("fields") or {}).items():
            av = fm.get("allowedValues")
            fields[fid] = {
                "name": fm.get("name"),
                "required": fm.get("required"),
                "allowedValues": [
                    v if isinstance(v, dict) else {"value": v}
                    for v in (av or [])
                ][:50] if av else [],
            }
        return {"fields": fields}

    @app.get("/api/jira/users")
    @api
    def jira_users():
        q = request.args.get("q") or ""
        ver = _ver(holder["client"])
        users = holder["client"].jira.get(
            f"rest/api/{ver}/user/search",
            params={"query": q, "maxResults": 15}) or []
        return [{"accountId": u.get("accountId"), "name": u.get("name"),
                 "displayName": u.get("displayName"),
                 "email": u.get("emailAddress")}
                for u in users if isinstance(u, dict)]

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
        if b.get("parent"):
            fields["parent"] = {"key": b["parent"]}
        fields.update(_jira_write_fields(b))
        c = holder["client"]
        if holder["cfg"]["cloud"]:
            res = c.jira.post("rest/api/3/issue", data={"fields": fields}) or {}
        else:
            res = c.jira.issue_create(fields) or {}
        invalidate()
        return {"key": res.get("key")}

    _EDIT_ID = {"priority": "priority", "duedate": "duedate", "labels": "labels",
                "components": "components", "fixversions": "fixVersions",
                "environment": "environment", "summary": "summary"}

    def _edit_fields(b):
        """Translate friendly field edits into a Jira fields payload."""
        out = {}
        raw = b.get("fields") or {}
        if not isinstance(raw, dict):
            return out
        for k, v in raw.items():
            kl = k.lower().replace(" ", "")
            if kl == "assignee":
                if isinstance(v, dict):
                    out["assignee"] = ({"accountId": v["accountId"]}
                                       if v.get("accountId") else
                                       {"name": v.get("name") or v.get("displayName")})
                elif v:
                    out["assignee"] = {"name": str(v)}
                continue
            builder = _EDIT_VAL.get(kl)
            if builder is not None:
                out[_EDIT_ID[kl]] = builder(v)
        return out

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
        fields.update(_edit_fields(b))
        if fields:
            if holder["cfg"]["cloud"]:
                c.jira.put(f"rest/api/3/issue/{key}", data={"fields": fields})
            else:
                c.jira.issue_update(key, fields)
        if b.get("transition_id") not in (None, ""):
            c.jira.set_issue_status_by_transition_id(key, b["transition_id"])
        invalidate()
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
        invalidate()
        return {"ok": True}

    @app.delete("/api/jira/issue/<key>")
    @api
    def jira_issue_delete(key):
        holder["client"].jira.delete_issue(key)
        invalidate()
        return {"ok": True}

    @app.post("/api/jira/transition")
    @api
    def jira_bulk_transition():
        b = body()
        keys = b.get("keys") or []
        tid = b.get("transition_id")
        if not keys or not tid:
            return jsonify(error="keys and transition_id required"), 400
        errors = []
        for k in keys:
            try:
                holder["client"].jira.set_issue_status_by_transition_id(k, tid)
            except Exception as e:
                errors.append({"key": k, "error": str(e)})
        invalidate()
        return {"ok": not errors, "errors": errors}

    # ---------- watchers / votes / links ----------

    @app.get("/api/jira/issue/<key>/watchers")
    @api
    def jira_watchers(key):
        ver = _ver(holder["client"])
        return holder["client"].jira.get(
            f"rest/api/{ver}/issue/{key}/watchers") or {}

    @app.post("/api/jira/issue/<key>/watchers")
    @api
    def jira_watch(key):
        ver = _ver(holder["client"])
        b = body()
        data = {}
        if b.get("accountId"):
            data["accountId"] = b["accountId"]
        elif b.get("name"):
            data["name"] = b["name"]
        holder["client"].jira.post(
            f"rest/api/{ver}/issue/{key}/watchers", data=data)
        invalidate()
        return {"ok": True}

    @app.delete("/api/jira/issue/<key>/watchers")
    @api
    def jira_unwatch(key):
        ver = _ver(holder["client"])
        aid = request.args.get("accountId") or ""
        path = f"rest/api/{ver}/issue/{key}/watchers"
        if aid:
            path += f"?accountId={aid}"
        holder["client"].jira.delete(path)
        invalidate()
        return {"ok": True}

    @app.post("/api/jira/issue/<key>/vote")
    @api
    def jira_vote(key):
        ver = _ver(holder["client"])
        holder["client"].jira.post(f"rest/api/{ver}/issue/{key}/votes",
                                   data={})
        invalidate()
        return {"ok": True}

    @app.get("/api/jira/issue/<key>/linktypes")
    @api
    def jira_linktypes(key):
        return cache_wrap("jira:linktypes", 300, lambda: [
            {"id": t.get("id"), "name": t.get("name"),
             "inward": t.get("inward"), "outward": t.get("outward")}
            for t in (holder["client"].jira.get_issue_link_types() or [])])

    @app.post("/api/jira/issue/<key>/link")
    @api
    def jira_link_add(key):
        b = body()
        other = b.get("other") or b.get("key")
        if b.get("inwardIssue") and b.get("outwardIssue"):
            inward, outward = b["inwardIssue"], b["outwardIssue"]
        elif b.get("direction") == "outward":
            # this issue carries the outward description (e.g. "blocks")
            inward, outward = other, key
        else:
            inward, outward = key, other
        if not inward or not outward:
            return jsonify(error="other issue key required"), 400
        holder["client"].jira.create_issue_link({
            "type": {"name": b["type"]},
            "inwardIssue": {"key": inward},
            "outwardIssue": {"key": outward}})
        invalidate()
        return {"ok": True}

    @app.delete("/api/jira/issue/<key>/link/<link_id>")
    @api
    def jira_link_del(key, link_id):
        ver = _ver(holder["client"])
        holder["client"].jira.delete(f"rest/api/{ver}/issueLink/{link_id}")
        invalidate()
        return {"ok": True}

    # ---------- attachments (Jira) ----------

    @app.get("/api/jira/attachment/<aid>")
    @api
    def jira_attachment(aid):
        c = holder["client"]
        ver = _ver(c)
        meta = c.jira.get(f"rest/api/{ver}/attachment/{aid}") or {}
        content = meta.get("content") or ""
        base = holder["cfg"]["url"]
        if content.startswith(base):
            content = content[len(base):]
        path = content if content.startswith("/") else \
            f"rest/api/{ver}/attachment/content/{aid}"
        data = c.jira.get(path, not_json_response=True)
        if isinstance(data, (dict, list)):
            data = json.dumps(data).encode()
        return binary(data, meta.get("filename") or f"att-{aid}",
                      meta.get("mimeType"))

    @app.post("/api/jira/issue/<key>/attachment")
    @api
    def jira_attachment_upload(key):
        f = request.files.get("file")
        if not f or not f.filename:
            return jsonify(error="no file"), 400
        holder["client"].jira.add_attachment_object(
            key, io.BytesIO(f.read()))
        invalidate()
        return {"ok": True}

    # ---------- agile (boards / sprints) ----------

    @app.get("/api/jira/boards")
    @api
    def jira_boards():
        project = request.args.get("project") or ""
        key = f"jira:boards:{project}"

        def fetch():
            data = holder["client"].jira.get_all_agile_boards(
                project_key=project or None, limit=50) or {}
            return [{"id": b.get("id"), "name": b.get("name"),
                     "type": b.get("type"),
                     "project": ((b.get("location") or {}).get("projectKey"))}
                    for b in data.get("values", data.get("results", []))]

        return cache_wrap(key, 120, fetch)

    @app.get("/api/jira/boards/<bid>/sprints")
    @api
    def jira_board_sprints(bid):
        state = request.args.get("state") or None
        data = holder["client"].jira.get_all_sprints_from_board(
            bid, state=state, limit=50) or {}
        return cache_wrap(f"jira:sprints:{bid}:{state}", 60, lambda: [
            {"id": s.get("id"), "name": s.get("name"), "state": s.get("state"),
             "startDate": s.get("startDate"), "endDate": s.get("endDate"),
             "goal": s.get("goal")}
            for s in data.get("values", data.get("results", []))])

    @app.get("/api/jira/sprints/<sid>/issues")
    @api
    def jira_sprint_issues(sid):
        c = holder["client"]
        data = c.jira.get_sprint_issues(sid, 0, 200) or {}
        return cache_wrap(f"jira:sprintissues:{sid}", 30, lambda: [
            _sprint_card(i) for i in data.get("issues", [])])

    def _sprint_card(i):
        f = i.get("fields") or {}
        return {"key": i.get("key"), "summary": f.get("summary"),
                "status": (f.get("status") or {}).get("name"),
                "status_id": (f.get("status") or {}).get("id"),
                "issuetype": (f.get("issuetype") or {}).get("name"),
                "assignee": _display(f.get("assignee")),
                "priority": (f.get("priority") or {}).get("name"),
                "points": _sprint_points(holder["client"], f),
                "epic": _epic_key(holder["client"], f),
                "sprint": _sprint_name(f),
                "updated": f.get("updated")}

    def _sprint_name(fields):
        # agile backlog/sprint payloads carry sprint info in customfield_* strings
        for fid, val in fields.items():
            if isinstance(val, str) and "Sprint@" in val[:60]:
                m = re.search(r"name=([^,\]]+)", val)
                if m:
                    return m.group(1)
            if isinstance(val, list):
                for v in val:
                    if isinstance(v, str) and "Sprint@" in v[:60]:
                        m = re.search(r"name=([^,\]]+)", v)
                        if m:
                            return m.group(1)
        return None

    @app.get("/api/jira/boards/<bid>/backlog")
    @api
    def jira_backlog(bid):
        c = holder["client"].jira
        data = c.get_issues_for_backlog(bid) or {}
        return cache_wrap(f"jira:backlog:{bid}", 30, lambda: [
            _sprint_card(i) for i in data.get("issues", [])])

    @app.get("/api/jira/boards/<bid>/configuration")
    @api
    def jira_board_config(bid):
        def fetch():
            cfg = holder["client"].jira.get_agile_board_configuration(bid) or {}
            cols = []
            for col in ((cfg.get("columnConfig") or {}).get("columns") or []):
                cols.append({
                    "name": col.get("name"),
                    "statuses": [{"id": s.get("id"), "name": s.get("name")}
                                 for s in col.get("statuses") or []],
                })
            return {"id": cfg.get("id"), "name": cfg.get("name"),
                    "columns": cols}
        return cache_wrap(f"jira:boardcfg:{bid}", 300, fetch)

    @app.post("/api/jira/sprints/<sid>/issues")
    @api
    def jira_sprint_add(sid):
        keys = (body().get("keys") or [])[:50]
        if not keys:
            return jsonify(error="keys required"), 400
        holder["client"].jira.add_issues_to_sprint(sid, keys)
        invalidate()
        return {"ok": True}

    @app.post("/api/jira/backlog/issues")
    @api
    def jira_backlog_move():
        keys = (body().get("keys") or [])[:50]
        if not keys:
            return jsonify(error="keys required"), 400
        holder["client"].jira.move_issues_to_backlog(keys)
        invalidate()
        return {"ok": True}

    def _rank_fid():
        try:
            for fid, name in holder["client"].field_names().items():
                if (name or "").lower() == "rank":
                    return fid
        except Exception:
            pass
        return None

    @app.post("/api/jira/issues/rank")
    @api
    def jira_rank():
        b = body()
        keys = b.get("keys") or []
        before = b.get("before")
        fid = _rank_fid()
        if not keys or not before or not fid:
            return jsonify(error="keys, before and a Rank field are required"), 400
        holder["client"].jira.update_rank(keys[:50], before, fid)
        invalidate()
        return {"ok": True}

    @app.post("/api/jira/sprints")
    @api
    def jira_sprint_create():
        b = body()
        res = holder["client"].jira.create_sprint(
            b["name"], b["board_id"],
            start_date=b.get("startDate"), end_date=b.get("endDate"),
            goal=b.get("goal")) or {}
        invalidate()
        return {"id": res.get("id")}

    @app.post("/api/jira/sprints/<sid>/state")
    @api
    def jira_sprint_state(sid):
        state = (body().get("state") or "").lower()
        if state not in ("active", "closed"):
            return jsonify(error="state must be active|closed"), 400
        holder["client"].jira.update_partially_sprint(sid, {"state": state})
        invalidate()
        return {"ok": True}

    # ---------- worklog / remote links ----------

    @app.get("/api/jira/issue/<key>/worklog")
    @api
    def jira_worklog(key):
        ver = _ver(holder["client"])
        data = holder["client"].jira.get(
            f"rest/api/{ver}/issue/{key}/worklog?maxResults=50") or {}
        out = []
        for w in data.get("worklogs", []):
            c = w.get("comment")
            if isinstance(c, dict):
                c = adf_to_text(c) or ""
            out.append({"id": str(w.get("id")), "author": _display(w.get("author")),
                        "timeSpent": w.get("timeSpent"),
                        "started": w.get("started"), "comment": c})
        return {"worklogs": out}

    @app.post("/api/jira/issue/<key>/worklog")
    @api
    def jira_worklog_add(key):
        b = body()
        spent = (b.get("timeSpent") or "").strip()
        if not spent:
            return jsonify(error="timeSpent required (e.g. 1h 30m)"), 400
        ver = _ver(holder["client"])
        data = {"timeSpent": spent}
        if b.get("started"):
            data["started"] = b["started"]
        comment = (b.get("comment") or "").strip()
        if comment:
            if holder["cfg"]["cloud"]:
                data["comment"] = {"type": "doc", "version": 1, "content": [
                    {"type": "paragraph",
                     "content": [{"type": "text", "text": comment}]}]}
            else:
                data["comment"] = comment
        holder["client"].jira.post(
            f"rest/api/{ver}/issue/{key}/worklog", data=data)
        invalidate()
        return {"ok": True}

    @app.post("/api/jira/issue/<key>/remlink")
    @api
    def jira_remlink_add(key):
        b = body()
        url, title = (b.get("url") or "").strip(), (b.get("title") or "").strip()
        if not url:
            return jsonify(error="url required"), 400
        ver = _ver(holder["client"])
        holder["client"].jira.post(
            f"rest/api/{ver}/issue/{key}/remotelink",
            data={"object": {"url": url, "title": title or url}})
        invalidate()
        return {"ok": True}

    @app.delete("/api/jira/issue/<key>/remlink/<rid>")
    @api
    def jira_remlink_del(key, rid):
        ver = _ver(holder["client"])
        holder["client"].jira.delete(
            f"rest/api/{ver}/issue/{key}/remotelink/{rid}")
        invalidate()
        return {"ok": True}

    # ---------- Confluence ----------

    @app.get("/api/confluence/spaces")
    @api
    def conf_spaces():
        def fetch():
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
        return cache_wrap("conf:spaces", 300, fetch)

    @app.get("/api/confluence/pages")
    @api
    def conf_pages():
        c = holder["client"].conf
        space = re.sub(r"[^A-Za-z0-9_]", "", request.args.get("space") or "")
        q = (request.args.get("q") or "").replace('"', "")
        limit = request.args.get("limit", type=int) or 50
        key = f"conf:pages:{space}:{q}:{limit}"

        def fetch():
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

        return cache_wrap(key, 30, fetch)

    @app.get("/api/confluence/cql")
    @api
    def conf_cql():
        cql = request.args.get("cql") or ""
        if not cql.strip():
            return jsonify(error="cql required"), 400
        limit = request.args.get("limit", type=int) or 50
        data = holder["client"].conf.cql(cql, limit=limit) or {}
        return {"pages": [_page_brief(p) for p in data.get("results", [])]}

    def _conf_page_detail(page_id):
        c = holder["client"].conf

        def _page():
            return c.get_page_by_id(
                page_id, expand="body.view,body.storage,version,space") or {}

        def _anc():
            try:
                return [{"id": str(a.get("id")), "title": a.get("title")}
                        for a in (c.get_page_ancestors(page_id) or [])]
            except Exception:
                return []

        def _kids():
            try:
                return [{"id": str(ch.get("id")), "title": ch.get("title")}
                        for ch in (c.get_child_pages(page_id) or [])
                        if ch.get("type", "page") == "page"]
            except Exception:
                return []

        def _labs():
            try:
                return [r.get("name") for r in
                        ((c.get_page_labels(page_id) or {}).get("results") or [])]
            except Exception:
                return []

        def _atts():
            try:
                res = c.get_attachments_from_content(page_id, limit=100) or {}
                out = []
                for a in res.get("results", []):
                    dl = ((a.get("_links") or {}).get("download")) or ""
                    out.append({
                        "id": str(a.get("id")),
                        "filename": a.get("title"),
                        "mime": (a.get("metadata") or {}).get("mediaType"),
                        "size": (a.get("extensions") or {}).get("fileSize"),
                        "version": (a.get("version") or {}).get("number"),
                        "url": "/api/confluence/attachment?dl=" + quote(dl, safe="")
                        if dl else None,
                    })
                return out
            except Exception:
                return []

        p, ancestors, children, labels, atts = _parallel(
            [_page, _anc, _kids, _labs, _atts])
        space = p.get("space") or {}
        diagrams = _diagram_previews(
            ((p.get("body") or {}).get("storage") or {}).get("value") or "", atts)
        return {
            "id": str(p.get("id")),
            "title": p.get("title"),
            "space": space.get("key"),
            "space_name": space.get("name"),
            "version": (p.get("version") or {}).get("number"),
            "body_html": ((p.get("body") or {}).get("view") or {}).get("value") or "",
            "ancestors": ancestors,
            "children": children,
            "labels": labels,
            "attachments": atts,
            "diagrams": diagrams,
        }

    @app.get("/api/confluence/page/<page_id>")
    @api
    def conf_page(page_id):
        return cache_wrap(f"conf:page:{page_id}", 60,
                          lambda: _conf_page_detail(page_id))

    @app.get("/api/confluence/page/<page_id>/history")
    @api
    def conf_page_history(page_id):
        c = holder["client"].conf
        data = c.get(f"rest/api/content/{page_id}/version?limit=25") or {}
        return cache_wrap(f"conf:history:{page_id}", 120, lambda: [
            {"number": v.get("number"), "when": v.get("when"),
             "by": _display(v.get("by")), "message": v.get("message")}
            for v in data.get("results", [])])

    @app.get("/api/confluence/page/<page_id>/restrictions")
    @api
    def conf_page_restrictions(page_id):
        def fetch():
            data = holder["client"].conf.get(
                f"rest/api/content/{page_id}/restriction") or {}
            read = (((data.get("restrictions") or {}).get("read") or {})
                    .get("results") or [])
            return [{"type": ((r.get("operation") or {}).get("target") or {})
                     .get("type"),
                     "name": ((r.get("operation") or {}).get("target") or {})
                             .get("displayName")
                             or ((r.get("operation") or {}).get("target") or {})
                             .get("id")}
                    for r in read]
        return cache_wrap(f"conf:restr:{page_id}", 120, fetch)

    @app.post("/api/confluence/page/<page_id>/label")
    @api
    def conf_label_add(page_id):
        name = (body().get("name") or "").strip()
        if not name:
            return jsonify(error="name required"), 400
        holder["client"].conf.set_page_label(page_id, name)
        invalidate()
        return {"ok": True}

    @app.delete("/api/confluence/page/<page_id>/label")
    @api
    def conf_label_del(page_id):
        name = request.args.get("name") or ""
        if not name:
            return jsonify(error="name required"), 400
        holder["client"].conf.remove_page_label(page_id, name)
        invalidate()
        return {"ok": True}

    @app.put("/api/confluence/page/<page_id>/move")
    @api
    def conf_page_move(page_id):
        b = body()
        holder["client"].conf.move_page(
            b["space"], page_id, target_id=b.get("parent_id") or None,
            position="append")
        invalidate()
        return {"ok": True}

    @app.post("/api/confluence/page/<page_id>/copy")
    @api
    def conf_page_copy(page_id):
        c = holder["client"].conf
        p = c.get_page_by_id(
            page_id, expand="body.storage,ancestors,version") or {}
        storage = ((p.get("body") or {}).get("storage") or {}).get("value") or ""
        b = body()
        title = (b.get("title") or "").strip() or (p.get("title") or "") + " (copy)"
        space = b.get("space") or (p.get("space") or {}).get("key")
        ancestors = p.get("ancestors") or []
        parent = b.get("parent_id") or (str(ancestors[-1]["id"])
                                      if ancestors else None)
        res = c.create_page(space, title, storage, parent_id=parent,
                            representation="storage") or {}
        invalidate()
        return {"id": str(res.get("id"))}

    @app.get("/api/confluence/attachment")
    @api
    def conf_attachment():
        dl = request.args.get("dl") or ""
        if not dl.startswith("/download/"):
            return jsonify(error="bad attachment path"), 400
        c = holder["client"].conf
        data = c.get(dl, not_json_response=True)
        if isinstance(data, (dict, list)):
            data = json.dumps(data).encode()
        name = dl.split("/")[-1].split("?")[0] or "file"
        mime = "application/octet-stream"
        for ext, m in ((".png", "image/png"), (".jpg", "image/jpeg"),
                       (".jpeg", "image/jpeg"), (".gif", "image/gif"),
                       (".svg", "image/svg+xml"), (".webp", "image/webp"),
                       (".pdf", "application/pdf")):
            if name.lower().endswith(ext):
                mime = m
                break
        # images render inline in the pane; everything else downloads
        disp = "inline" if mime.startswith("image/") else "attachment"
        return Response(data, mimetype=mime, headers={
            "Content-Disposition": f'{disp}; filename*=UTF-8\'\'{quote(name)}'})

    @app.post("/api/confluence/page/<page_id>/attachment")
    @api
    def conf_attachment_upload(page_id):
        f = request.files.get("file")
        if not f or not f.filename:
            return jsonify(error="no file"), 400
        holder["client"].conf.attach_content(
            f.read(), f.filename,
            content_type=f.mimetype or "application/binary",
            page_id=page_id)
        invalidate()
        return {"ok": True}

    @app.post("/api/confluence/page")
    @api
    def conf_page_create():
        b = body()
        res = holder["client"].conf.create_page(
            b["space"], b["title"], sanitize_html(b.get("body_html") or ""),
            parent_id=b.get("parent_id") or None, representation="storage") or {}
        invalidate()
        return {"id": str(res.get("id"))}

    @app.put("/api/confluence/page/<page_id>")
    @api
    def conf_page_update(page_id):
        b = body()
        holder["client"].conf.update_page(
            page_id, b["title"], sanitize_html(b.get("body_html") or ""))
        invalidate()
        return {"ok": True}

    @app.delete("/api/confluence/page/<page_id>")
    @api
    def conf_page_delete(page_id):
        holder["client"].conf.remove_page(page_id)
        invalidate()
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
