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
| `1` `2` `3`| Switch tabs (Jira / Confluence / Setup) |
| `/`        | Focus search / JQL box          |
| `j` `k`    | Move through the list           |
| `enter`    | Open selected item              |
| `e`        | Edit                            |
| `n`        | New issue / page                |
| `d`        | Delete (with confirm)           |
| `ctrl-s`   | Save                            |
| `esc`      | Back / exit edit                |
| `?`        | Help overlay                    |

The mouse works too. We're not monsters.

## Known limits

- **Confluence pages with complex macros**: editing a page that uses macros
  (Jira issues, children display, etc.) and saving will drop them. atlas86
  round-trips the HTML storage format and doesn't model macro storage XML.
  Read-only? Totally fine. Write? Expect casualties.
- **Jira markup differs by platform**: on Server/DC, descriptions are written
  as wiki markup; on Cloud they're written as ADF (Atlassian Document Format).
  Read back in, it all becomes HTML either way.
- **Tables in Jira descriptions flatten to paragraphs** on save. Cells lose
  their grid.
- **It's a simple client, not a full replacement.** No dashboards, no agile
  boards, no gadgets, no attachments. If you need that, go home and use Jira.

## Development

```sh
python -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python -m pytest tests/
```

## License

MIT — see [LICENSE](LICENSE).
