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
