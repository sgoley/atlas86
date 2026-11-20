# Decisions

- **Cache = whole-cache clear on write.** Single-user localhost app; a targeted
  invalidation matrix would be more code than the problem is worth. TTLs are
  short enough that stale reads self-heal.
- **Board columns = distinct statuses present in the sprint**, not the board's
  configured columns. The agile API's column config lives behind
  `/rest/agile/1.0/board/{id}/configuration` and is heavier; statuses-present
  covers the common case and degrades gracefully on weird workflows. A
  GROUP toggle regroups the same cards into epic swimlanes (move disabled
  there — epics aren't statuses).
- **Card move = transition lookup by target status name** (`transition.to`),
  not drag-and-drop. Keyboard-first fits the aesthetic; `[`/`]` moves a card
  left/right a column. If no transition lands on that status, the move is
  refused with a toast rather than guessing.
- **Bulk transition UI = checkboxes + prompt() picker.** Deliberately crude:
  the transition list comes from the first checked issue (transitions are
  per-issue in Jira), the user picks a number, confirm dialog, done. A fancy
  picker would be a framework wearing a trench coat.
- **Detail prefetch on j/k** uses a bare `fetch` (no toast on failure) to warm
  the server-side cache so ENTER opens instantly.
- **Attachments proxied through Flask** (`/api/jira/attachment/<id>`,
  `/api/confluence/attachment?dl=...`) so the browser never sees Atlassian
  URLs or needs auth headers; images render inline, everything else downloads.
  Confluence download paths are validated to start with `/download/`.
- **Field editing is a friendly-name allowlist** (priority, duedate, labels,
  components, fixVersions, environment, summary, assignee). Arbitrary custom
  fields stay read-only — their edit payloads are too instance-specific to
  guess safely. Assignee resolves name → accountId via `/api/jira/users`.
- **All fields render generically** via `_field_text` (dicts → name/value/
  displayName/key, lists joined, ADF flattened by `adf_to_text`, sprint
  greenhopper strings parsed). Values truncated at 240 chars.
- **Epic children** fetched with `parent = KEY` JQL (works cloud + modern
  server); legacy `"Epic Link"` custom field is still detected for the epic
  backlink on child issues.
- **No new dependencies.** Everything above is stdlib + existing flask /
  atlassian-python-api calls.

## v0.3.0 — parity tranche 2

- **Board columns come from `/rest/agile/1.0/board/{id}/configuration`**
  (status-id mapping, configured order). Cards whose status isn't mapped land
  in an OTHER column; epic swimlanes keep the old grouping and disable moves.
- **Card moves always go through transitions.** Drag-and-drop and `[`/`]`
  share `moveCardToColumn`, which matches the target column's status names
  against `transition.to`/`name`. No direct status writes — the workflow
  stays authoritative.
- **Rank uses the lib's `update_rank` (`rankBeforeIssue`)** with the field id
  discovered by name "Rank" via `/field`. Only up/down-by-one is exposed;
  arbitrary positioning would need rankAfterIssue plumbing nobody asked for.
- **Sprint state changes use `update_partially_sprint`** (`state: active|
  closed`); creating sprints uses `create_sprint` (name + board + optional
  dates/goal).
- **Worklog comments are ADF on Cloud, plain text on Server/DC**, matching the
  existing write-format split. Worklog list is fetched lazily per issue view.
- **Remote links use raw REST** (`/issue/{key}/remotelink`) because the lib's
  remote-link helpers are inconsistently shaped across versions; GET rides
  along in the detail fan-out.
- **Confluence copy re-uses storage format** (`representation='storage'`) so
  macros survive the copy; parent defaults to the source page's last ancestor.
- **Page move uses `conf.move_page`** with `position='append'` under the new
  parent; root moves pass `target_id=None`.
- **Diagram previews are resolved server-side** from `body.storage` macro
  blocks: filenames inside drawio/gliffy/diagram/plantuml macros are matched
  to attachments, preferring a same-basename image sibling over the source
  file. Failure modes degrade to a plain link or nothing — never worse than
  before. No drawio renderer is embedded (would need JS/SVG pipeline); the
  `.drawio` XML itself is not rendered.

## v0.4.0 — final tranche

- **HOME is a real tab (`0`), not a Jira view.** It renders `/api/home` —
  four parallel JQL buckets (mine / due-this-week / watched / open sprint),
  cached 60s. Clicking a key jumps into the Jira tab's issue detail.
- **Transition screen fields come from `transitions?expand=transitions.fields`.**
  The detail fan-out already fetched transitions; the expand adds per-field
  `{name, required, allowedValues}` metadata. When a transition carries fields,
  the UI opens the same editor overlay as a minimal form instead of firing a
  bare transition. `transition_fields` values go out keyed by field id;
  `comment` fields are converted to ADF (cloud) / wiki (server) server-side.
- **Worklog edit/delete are raw REST** (`PUT|DELETE /issue/{key}/worklog/{id}`)
  because the lib has no worklog-mutation helpers; comment bodies follow the
  same ADF/wiki split as worklog create.
- **rankAfterIssue needed a raw agile PUT** — the lib only exposes
  `update_rank` (rankBeforeIssue). `/api/jira/issues/rank` accepts `before`
  (lib) or `after` (raw `issue/rank` with `rankCustomFieldId`). Backlog rows
  are HTML5-draggable; drop-on-row = insert before it, drop on section body =
  rank after last. Cross-section drops are ignored (rank is positional, not
  a move operation).
- **Confluence comments use `child/comment` REST directly** (storage-format
  body, sanitized HTML subset). Replies are modeled by ancestors — a comment
  whose ancestors include another comment id is a reply. Inline/anchored
  comments are not supported (they need selection offsets in body storage).
- **drawio SVG extraction is a stdlib mxGraphModel→SVG renderer**, capped at
  120 cells and 3 diagrams per page. It handles inline XML and the usual
  base64+zlib-compressed `<diagram>` payload. Read-only, phosphor-styled;
  anything unparseable falls back to the existing link/XML-summary path.
  No online renderer, no new deps.
- **Versions view reuses JQL counts** — one `fixVersion =` count query per
  version, parallelized, cached 120s. Capped at 25 versions.

## v0.5.0 — parity sweep

- **Issue history rides the detail fetch.** `expand=changelog` on the same
  `issue()` call returns up to 50 histories — zero extra upstream latency.
  Items normalize `fromString/toString` (falling back to raw `from/to` ids).
- **Custom-field editing is scalar-only by construction.** `_issue_attrs`
  marks `editable` only when the raw value is str/int/float/bool; the PUT
  path rejects non-scalars 400. Option objects, user pickers, cascading
  selects and multi-value fields stay read-only — their payload shapes are
  too instance-specific to guess safely.
- **Bulk edit is sequential per-key PUTs**, not `PUT /issue/bulk` — bulk
  update can't express per-issue `update` label ops cleanly and N≤50 keeps
  it simple; failures are collected per key instead of aborting.
- **Labels add/remove use Jira `update` operations** (`{add}/{remove}`)
  rather than rewriting the whole label set — additive edits can't clobber
  concurrent label changes.
- **Sprint report is a stats panel, not a chart.** The agile report
  endpoint's contents are normalized defensively (issueCount dict, issues
  list, or bare int) since payload shape varies by Jira version.
- **Conf watch uses the documented v1 endpoint** (`user/watch/content/{id}`,
  GET status + POST/DELETE toggle; the lib's default `X-Atlassian-Token:
  no-check` header satisfies its XSRF requirement).
- **Conf favourite uses the experimental relations API**
  (`rest/experimental/relation/user/current/favourite/toContent/{id}`) —
  the only REST toggle that exists; read state comes free from
  `metadata.currentuser.favourited` expand. Best-effort: if the instance
  doesn't expose it, the UI toasts rather than pretending.
- **Mentions are cosmetic, not semantic.** `@name` text nodes get wrapped
  in `<span class="mention">` post-render (text-node walk only — sanitized
  HTML is never reparsed). The comment box gets a user datalist backed by
  `/api/jira/users`; there's no real mention resolution or notification.
