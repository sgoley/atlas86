# ATLAS-86 — spec (the contract, read fully before writing code)

A simple, light, portable Jira + Confluence client. One `pip install git+https://...`,
one `atlas86` command, a local web UI on `127.0.0.1:8686`. No Node, no build step,
no framework on the frontend. The vibe is https://omarchy.org/: campy 80s retro
computing, opinionated, terminal-proud, keyboard-first.

Project root: `/Users/admin/Storage/Git/llm/atlas86`
Python venv already exists at `.venv/` with flask, atlassian-python-api==4.0.7,
python-dotenv, pytest installed. Use `.venv/bin/python` for everything. Do NOT
create a new venv, do NOT add dependencies beyond the list below.

## Dependencies (exact — pin in pyproject)
- `flask>=3`
- `atlassian-python-api>=4,<5`   (5.x removed Confluence page helpers — do not allow v5)
- `python-dotenv>=1`
- stdlib only otherwise (html.parser for converters; no bs4, no markdown lib)

## File map
```
pyproject.toml          # name "atlas86", console script atlas86 = atlas86.server:main
README.md               # campy retro-flavored, install-from-github instructions
LICENSE                 # MIT
.env.example            # ATLAS86_URL / ATLAS86_USER / ATLAS86_TOKEN / ATLAS86_CLOUD
.gitignore              # __pycache__, .venv, .env, *.egg-info
atlas86/__init__.py     # __version__
atlas86/config.py       # env + ~/.atlas86.env load/save
atlas86/convert.py      # html<->storage/adf/wiki/text converters (stdlib html.parser)
atlas86/atlas.py        # AtlasClient: thin wrapper over atlassian.Jira + .Confluence
atlas86/server.py       # Flask app factory + routes + main()
atlas86/templates/index.html
atlas86/static/retro.css
atlas86/static/app.js
tests/test_convert.py
tests/test_server.py
```

## Config
Env vars `ATLAS86_URL`, `ATLAS86_USER`, `ATLAS86_TOKEN`, `ATLAS86_CLOUD` (true/false).
`config.py` loads `~/.atlas86.env` via dotenv (env vars win), `save_config()` writes
that file with mode 0o600. Cloud=true => username+API token; cloud=false => server/DC
basic auth (user+password or PAT).

## HTTP API contract (frontend calls exactly these; JSON in, JSON out)
Every error is `{"error": "<human message>"}` with a sensible status code. If not
configured, every /api/jira/* and /api/confluence/* returns 400 `{"error":"not configured"}`.
Never return the token.

- `GET  /api/health`              -> `{ok:true, configured:bool, url,user,cloud}`
- `GET  /api/config`              -> `{url,user,cloud,has_token:bool}`
- `POST /api/config`  `{url,user,cloud,token?}` -> saves, reinitializes clients, `{ok:true}`
- `GET  /api/jira/projects`       -> `[{key,name}]`
- `GET  /api/jira/issues?jql=&limit=`  -> `{jql, issues:[{key,summary,status,issuetype,assignee,updated}]}`
    default jql: `assignee = currentUser() ORDER BY updated DESC`
- `GET  /api/jira/issue/<key>`    -> `{key,summary,status,issuetype,assignee,reporter,updated,description_html,comments:[{author,created,body_html}],transitions:[{id,name}]}`
- `POST /api/jira/issue`  `{project,summary,issuetype,description_html}` -> `{key}`
- `PUT  /api/jira/issue/<key>`  `{summary?,description_html?,transition_id?}` -> `{ok:true}`
- `POST /api/jira/issue/<key>/comment`  `{body_html}` -> `{ok:true}`
- `DELETE /api/jira/issue/<key>`  -> `{ok:true}`
- `GET  /api/confluence/spaces`   -> `[{key,name}]`
- `GET  /api/confluence/pages?space=&q=&limit=` -> `{pages:[{id,title,space,updated}]}`
    no `q`: `get_all_pages_from_space`. With `q`: `cql('type=page AND title~"q"' [+ ' AND space="K"'])`.
- `GET  /api/confluence/page/<id>` -> `{id,title,space,space_name,version,body_html}`
    fetch `expand='body.view,version,space'`; body_html = `body.view.value`.
- `POST /api/confluence/page`  `{space,title,body_html,parent_id?}` -> `{id}`
- `PUT  /api/confluence/page/<id>`  `{title,body_html}` -> `{ok:true}`
- `DELETE /api/confluence/page/<id>` -> `{ok:true}`
- `GET  /` -> templates/index.html. `/static/*` normal Flask static.

## v0.2 API extensions (intentionally added; same error/JSON rules)

Reads are TTL-cached server-side (30–300s depending on endpoint); every
mutation clears the cache.

- `GET  /api/jira/issue/<key>` now also returns: `priority`, `created`,
  `duedate`, `labels`, `components`, `fixVersions`, `parent`, `epic`,
  `children` (epics only), `subtasks`, `links`, `attachments` (each with a
  proxy `url`), `watches`, `votes`, `timetracking`, and `attributes` covering
  ALL remaining fields generically (dicts→name/value/displayName/key, ADF→text
  via `convert.adf_to_text`, values truncated at 240 chars).
- `GET  /api/jira/issue/<key>/editmeta` -> allowedValues per field (trimmed)
- `GET  /api/jira/users?q=` -> `[{accountId,name,displayName,email}]`
- `PUT  /api/jira/issue/<key>` accepts `fields` = friendly-name map:
  `priority{name}`, `duedate`, `labels[]`, `components[{name}]`,
  `fixVersions[{name}]`, `environment`, `summary`, `assignee{name|accountId}`.
- `POST /api/jira/transition` `{keys:[], transition_id}` -> bulk transition
- `GET|POST|DELETE /api/jira/issue/<key>/watchers` (+ `?accountId=` on DELETE)
- `POST /api/jira/issue/<key>/vote`
- `GET  /api/jira/issue/<key>/linktypes`
- `POST /api/jira/issue/<key>/link` `{type, other, direction}` or explicit
  `{type, inwardIssue, outwardIssue}`
- `DELETE /api/jira/issue/<key>/link/<link_id>`
- `GET  /api/jira/attachment/<aid>` -> proxied bytes (images inline-safe)
- `POST /api/jira/issue/<key>/attachment` (multipart `file`)
- `GET  /api/jira/boards?project=` -> `[{id,name,type,project}]` (agile API)
- `GET  /api/jira/boards/<id>/sprints?state=` -> `[{id,name,state,...}]`
- `GET  /api/jira/sprints/<id>/issues` -> `[{key,summary,status,status_id,
  issuetype,assignee,priority,points,epic,updated}]`
- `GET  /api/confluence/page/<id>` now also returns `ancestors`, `children`,
  `labels`, `attachments` (each with proxy `url`).
- `GET  /api/jira/boards/<id>/backlog` -> backlog issues as sprint cards
- `GET  /api/jira/boards/<id>/configuration` -> `{columns:[{name,statuses:[{id,name}]}]}`
- `POST /api/jira/sprints/<id>/issues` `{keys:[]}` -> add to sprint
- `POST /api/jira/backlog/issues` `{keys:[]}` -> move to backlog
- `POST /api/jira/issues/rank` `{keys:[], before}` -> rank before issue
- `POST /api/jira/sprints` `{name,board_id,startDate?,endDate?,goal?}`
- `POST /api/jira/sprints/<id>/state` `{state:active|closed}`
- `GET  /api/jira/issue/<key>/worklog` -> `{worklogs:[{id,author,timeSpent,started,comment}]}`
- `POST /api/jira/issue/<key>/worklog` `{timeSpent,started?,comment?}`
- `POST /api/jira/issue/<key>/remlink` `{url,title?}`; `DELETE .../remlink/<id>`
- `POST /api/jira/issue` accepts optional `parent` (subtask creation)
- `GET  /api/confluence/page/<id>/restrictions` -> `[{type,name}]` read restrictions
- `POST|DELETE /api/confluence/page/<id>/label` (+ `?name=` on DELETE)
- `PUT  /api/confluence/page/<id>/move` `{space,parent_id?}`
- `POST /api/confluence/page/<id>/copy` `{title?,space?,parent_id?}` -> `{id}`
- `GET  /api/confluence/page/<id>` also returns `diagrams` (best-effort
  drawio/gliffy/plantuml attachment previews resolved from body.storage)
- `GET  /api/confluence/page/<id>/history` -> `[{number,when,by,message}]`
- `GET  /api/confluence/cql?cql=&limit=` -> `{pages:[...]}` raw CQL passthrough
- `GET  /api/confluence/attachment?dl=<_links.download path>` -> proxied bytes;
  path must start `/download/` (400 otherwise). Images served inline.
- `POST /api/confluence/page/<id>/attachment` (multipart `file`)

## Body format rules (the important part)
`body_html`/`description_html` is the editor's HTML subset:
`p br hr h1-h6 strong b em i u s del code pre ul ol li a[href] blockquote
table thead tbody tr th td img[src,alt]`.
Backend ALWAYS sanitizes input through `convert.sanitize_html` (whitelist above;
unknown tags are unwrapped keeping children, except script/style which drop
entirely; only listed attributes survive; a[href] gets rel=noopener).

- Confluence write: `create_page`/`update_page` with `representation='storage'`,
  body = sanitized HTML (storage format accepts this subset).
- Confluence read: `body.view.value` (rendered HTML — the browser edits it directly).
  shortcut: complex macros are dropped on edit — code-comment it in convert.py,
  mention in README.
- Jira read: `jira.issue(key, expand='renderedFields')` -> `renderedFields.description`
  is already HTML on both cloud and server; comments likewise
  (`renderedFields.comment.comments[].body`).
- Jira write, cloud=true: post REST v3 yourself via `jira.post('rest/api/3/issue', ...)`
  / `jira.put(f'rest/api/3/issue/{key}', ...)`, `description` = `convert.html_to_adf(html)`
  ADF object. Comments: `jira.post(f'rest/api/3/issue/{key}/comment', {"body": adf})`.
  Transitions/lookup stay on the lib's v2 methods (they work on cloud).
- Jira write, cloud=false: `jira.issue_create`/`issue_update`/`issue_add_comment`
  with `description`/`body` = `convert.html_to_wiki(html)` wiki markup.

`convert.py` exports: `sanitize_html`, `html_to_adf`, `html_to_wiki`, `html_to_text`.
ADF support (minimal): doc/paragraph/heading(1-6)/bulletList/orderedList/listItem/
codeBlock/blockquote/rule/hardBreak/text; marks strong/em/underline/strike/code/link.
Tables: collapse to paragraphs (comment why — keep it simple).

## Verified lib signatures (4.0.7 — call them exactly like this)
```
Jira(url=..., username=..., password=..., cloud=bool)
Confluence(url=..., username=..., password=..., cloud=bool)
jira.jql(jql, fields='*all', limit=None) -> {'issues':[...]}
jira.issue(key, fields='*all', expand='renderedFields')
jira.issue_create(fields: dict)
jira.issue_update(issue_key, fields)
jira.delete_issue(key)
jira.get_issue_transitions(key) -> [{id,name,...}]
jira.set_issue_status_by_transition_id(key, transition_id)
jira.issue_add_comment(key, text)
jira.projects()
jira.post(path, data=dict) / jira.put(path, data=dict)   # raw REST escape hatches
conf.get_page_by_id(page_id, expand='body.view,version,space')
conf.create_page(space, title, body, parent_id=None, representation='storage')
conf.update_page(page_id, title, body)
conf.remove_page(page_id)
conf.get_all_pages_from_space(space, limit=50)
conf.get_all_spaces()
conf.cql(cql)
```

## Frontend (index.html + retro.css + app.js — plain JS, zero deps, no build)
Layout: top bar `[ATLAS-86]` ASCII/brand + tabs JIRA | CONFLUENCE | SETUP +
connection status dot; main = left list pane (search/filter input on top) +
right detail pane; bottom status bar with key hints.
Jira: JQL box (editable, default prefilled), issue list -> detail shows
fields + rendered description + comments; `e` edits summary+description in the
WYSIWYG editor; status changed via transitions dropdown; comment box; `n` new
issue (project/type/summary/desc); `d` delete (confirm).
Confluence: space dropdown + title search; page list -> rendered view; `e`
WYSIWYG edit (title input + editor); `n` new page; `d` delete (confirm).
Setup: url/user/token/cloud form + save + health result.
WYSIWYG editor: contenteditable + toolbar (B I U S H1 H2 UL OL QUOTE CODE PRE
LINK HR) via document.execCommand; emits innerHTML as body_html.
Keys: 1/2/3 tabs, / focus search, j/k list nav, enter open, e edit, n new,
d delete, ctrl-s save, esc back/view. Mouse works too.
Aesthetic (retro.css owns all of it):
- vars: --bg:#060a07 --panel:#0b120c --fg:#b8ffc8 --dim:#4f7a5c --amber:#ffd75f
  --cyan:#54e8ff --danger:#ff5f56 --border:#1f3a26
- monochrome-green phosphor look, amber for keys/labels, cyan for links/selected,
  danger for destructive; ALL type `ui-monospace,'IBM Plex Mono',Menlo,monospace`,
  uppercase labels, 2px solid borders, no rounded corners, no shadows except
  a subtle green text glow.
- scanline overlay + vignette (fixed pseudo-element layers), blinking block
  cursor after the logo, tiny ASCII box-drawing decorations in headers.
- boot splash overlay: fake BIOS POST lines (`ATLAS-86 BIOS v0.1`, memory check
  OK, `PRESS ANY KEY`), fades in ~1.2s, dismissed by any key/click.
- sound toggle in header (default OFF): short square-wave blips via WebAudio on
  save/open — ~15 lines, campy, not annoying.
- `?` shows a help overlay listing keys. Status bar shows context hints.
Toasts for errors/success (styled like terminal alerts, `[ OK ]` / `[FAIL]`).

## Style rules for all code
Lazy senior dev: smallest complete implementation, no abstractions nobody asked
for, no comments unless the why isn't visible (one line max), `shortcut:` comments
where we knowingly cut a corner. No type-annotation noise beyond what's helpful.
Don't log or persist the token anywhere except the config file (0o600).

## Tests (pytest, run with `.venv/bin/python -m pytest tests/`)
test_convert.py: sanitize strips script/attrs and wraps text; html_to_adf for
headings/lists/marks; html_to_wiki for the same; html_to_text fallback.
test_server.py: Flask test client with `atlas.AtlasClient` monkeypatched —
config round-trip (token never returned), 400-when-unconfigured, one jira list
route and one confluence page route happy path.
