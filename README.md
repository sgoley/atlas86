# ATLAS-86

A lightweight local-web Jira + Confluence client. One install, one command,
a phosphor-green 80s terminal in your browser. Keyboard-first, mouse-tolerated.

Works with **Atlassian Cloud** and **Jira/Confluence Server & Data Center**.

```
   _____ _____ _____ _____
  / ____|_   _|  __ \_   _|
 | (___   | | | |__) || |
  \___ \  | | |  ___/ | |
  ____) |_| |_| |     |_|   ... a web client for Jira & Confluence
 |_____/_____|_|
```

No Node. No build step. No framework on the frontend. Just Python, Flask, and
plenty of scanlines.

## Install

Requires Python 3.10+.

```sh
# with pipx (recommended — keeps it out of your global site-packages)
pipx install git+https://github.com/sgoley/atlas86

# or with pip, inside a venv
pip install git+https://github.com/sgoley/atlas86
```

## Run

```sh
atlas86
```

Open <http://127.0.0.1:8686>. On first boot you'll see a fake BIOS POST
sequence — press any key, then fill in the SETUP tab.

## Configure

Either use the **SETUP** tab in the UI, or set env vars:

```sh
export ATLAS86_URL="https://your-instance.atlassian.net"
export ATLAS86_USER="you@example.com"
export ATLAS86_TOKEN="your-api-token"
export ATLAS86_CLOUD="true"   # or "false" for Server / Data Center
```

Values saved via SETUP are written to `~/.atlas86.env` with mode `0600`.
Environment variables take precedence over that file. The token is never sent
back to the browser or logged.

### Getting an API token

- **Atlassian Cloud**: <https://id.atlassian.com/manage-profile/security/api-tokens>
  → "Create API token". `ATLAS86_CLOUD=true`, use your email as the user.
- **Server / Data Center** (`ATLAS86_CLOUD=false`): create a Personal Access
  Token under your profile settings, or use your regular password.

## Keyboard shortcuts

| Key        | Action                          |
| ---------- | ------------------------------- |
| `0` `1` `2` `3` | Switch tabs (Home / Jira / Confluence / Setup) |
| `/`        | Focus search / JQL box          |
| `j` `k`    | Move through the list           |
| `enter`    | Open selected item              |
| `e`        | Edit                            |
| `n`        | New issue / page                |
| `d`        | Delete (with confirm)           |
| `ctrl-s`   | Save                            |
| `esc`      | Back / exit edit                |
| `?`        | Help overlay                    |
| `[` `]`    | On a board: move card a column (fires the matching transition) |
| `r`        | On a board: reload the sprint   |

The mouse works too. We're not monsters.

## What it does

- **HOME** (`0`): your-work dashboard — my open issues, due this week,
  watched issues, active sprint items. Click a key to jump into Jira.
- **Jira**: JQL search with presets + saved filters, full issue detail (every
  field, rendered generically), edit summary/description, edit priority /
  assignee / labels / due date / components / fix versions, transitions
  (including transition-screen fields like Resolution), comments with
  @mention rendering + user lookup, issue history (changelog), issue links,
  remote links, watchers, votes, worklog (view/log/edit/delete), attachments
  (view inline + upload), epic/parent/child/subtask hierarchy.
- **Boards**: pick project → board → sprint, cards grouped by configured
  status columns (or epic swimlanes), drag-and-drop or `[`/`]` moves via the
  matching transition, sprint create/start/complete, sprint report (completed /
  incomplete / punted + velocity), versions view, backlog view with sprint
  sections, checkbox bulk transition + bulk field edit, and drag-to-position
  ranking.
- **Versions**: per-project fixVersions with issue counts and release state,
  from the board header.
- **Confluence**: space browse + title search + raw CQL, page tree
  (ancestors/children), labels, page comments (threads, replies, delete),
  page watch + favourite, version history, move/copy/restrictions, attachments
  (inline images + upload), diagram previews (images, drawio→SVG extraction,
  links), WYSIWYG edit.
- **Fast**: TTL-cached reads (~0.3ms warm vs ~50ms+ cold upstream),
  virtualized lists, parallel detail fetches. See `docs/PERF.md`.

## Known limits

- **Confluence pages with complex macros**: editing a page that uses macros
  (Jira issues, children display, etc.) and saving will drop them. atlas86
  round-trips the HTML storage format and doesn't model macro storage XML.
  Read-only? Totally fine — `body.view` renders most macros for you. Write?
  Expect casualties.
- **Jira markup differs by platform**: on Server/DC, descriptions are written
  as wiki markup; on Cloud they're written as ADF (Atlassian Document Format).
  Read back in, it all becomes HTML either way.
- **Tables in Jira descriptions flatten to paragraphs** on save. Cells lose
  their grid.
- **Field editing covers the common fields plus scalar custom fields.**
  Priority, assignee, labels, due date, components, fix versions, environment,
  summary are editable; custom fields are editable only when their value is a
  plain string/number/boolean — option pickers, user pickers, cascading
  selects, and multi-value fields stay read-only.
- **Bulk edit covers transition + assignee/priority/due date/labels** on up
  to 50 issues. No bulk delete, no bulk move-to-sprint from the issues list.
- **Board columns follow the board's configured layout** when the agile
  configuration endpoint answers; cards move by workflow transition, so a
  drop only works when a transition targets a status in that column. If the
  transition has screen fields (e.g. Resolution), a minimal form is shown.
- **Rank ordering works within a backlog/sprint section** — drag a row onto
  another row to insert before it, or onto the section body to send it last.
  There's no cross-section drag (use the →SPRINT / →BACKLOG buttons).
- **Diagrams are best-effort**: image attachments render inline; `.drawio`
  files get a read-only SVG preview extracted from the embedded mxGraphModel
  (inline or compressed, capped at 120 cells/3 diagrams); anything else
  falls back to a link. Complex diagrams may render approximately.
- **Confluence comments are page-level threads** — display, add, reply,
  delete. Inline/anchored comments (anchored to selected text) are not
  supported.
- **HOME is a dashboard-lite**, not Jira's full "Your Work" — four fixed
  buckets, no gadgets, filters, or activity streams.
- **Sprint report is stats-only** — completed/incomplete/punted counts and
  velocity numbers from the agile report endpoint; no burndown chart, no
  per-issue drill-down.
- **Page favourites use the experimental relations API** — it works on most
  Server/DC instances and recent Cloud, but if your flavour doesn't expose it
  the button toasts an error instead of toggling.
- **Mentions render as styled spans** in rendered bodies, and the Jira comment
  box has a user-lookup helper — but there's no real mention notification or
  autocomplete dropdown.
- **It's a simple client, not a full replacement.** No Jira dashboards,
  gadgets, roadmaps, sprint planning poker, or admin screens. If you need
  that, go home and use Jira.

## Development

```sh
python -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python -m pytest tests/
```

## License

MIT — see [LICENSE](LICENSE).
