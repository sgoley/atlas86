"""HTML <-> Jira/Confluence body-format converters. Stdlib html.parser only.

All public functions sanitize through the same whitelist, so converters only
ever see allowed tags. Complex Confluence macros are dropped on edit — the
sanitizer unwraps unknown tags and storage format cannot round-trip them.
"""

import re
from html import escape
from html.parser import HTMLParser

ALLOWED = {
    "p", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "u", "s", "del", "code", "pre",
    "ul", "ol", "li", "a", "blockquote",
    "table", "thead", "tbody", "tr", "th", "td", "img",
}
DROP = {"script", "style"}
ATTRS = {"a": ("href",), "img": ("src", "alt")}
VOID = {"br", "hr", "img"}
HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
INLINE = {"strong", "b", "em", "i", "u", "s", "del", "code", "a", "img", "br"}


class _Parser(HTMLParser):
    """Builds a tree of [tag, attrs, children]; text children are str."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = [None, {}, []]
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        node = [tag, dict(attrs), []]
        self.stack[-1][2].append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1][2].append([tag.lower(), dict(attrs), []])

    def handle_endtag(self, tag):
        tag = tag.lower()
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1][2].append(data)


def _parse(html):
    p = _Parser()
    p.feed(html or "")
    p.close()
    return p.root[2]


def _clean(nodes):
    """Whitelist filter -> clean tree. Unknown tags unwrap, script/style drop."""
    out = []
    for n in nodes:
        if isinstance(n, str):
            # formatting whitespace between tags; keep real spaces
            if n.strip() or not any(c in n for c in "\n\t"):
                out.append(n)
            continue
        tag, attrs, children = n
        if tag in DROP:
            continue
        if tag not in ALLOWED:
            out.extend(_clean(children))
            continue
        kept = {k: attrs[k] for k in ATTRS.get(tag, ()) if k in attrs}
        if tag == "a":
            if kept.get("href", "").strip().lower().startswith("javascript:"):
                kept.pop("href", None)
            else:
                kept["rel"] = "noopener"
        out.append([tag, kept, _clean(children)])
    return out


def _render(nodes):
    parts = []
    for n in nodes:
        if isinstance(n, str):
            parts.append(escape(n))
            continue
        tag, attrs, children = n
        a = "".join(f' {k}="{escape(v)}"' for k, v in attrs.items())
        if tag in VOID:
            parts.append(f"<{tag}{a}>")
        else:
            parts.append(f"<{tag}{a}>{_render(children)}</{tag}>")
    return "".join(parts)


def sanitize_html(html):
    return _render(_clean(_parse(html)))


def _text_of(nodes):
    out = []
    for n in nodes:
        if isinstance(n, str):
            out.append(n)
        elif n[0] == "br":
            out.append("\n")
        elif n[0] == "img":
            out.append(n[1].get("alt") or "")
        else:
            out.append(_text_of(n[2]))
    return "".join(out)


# ---------- ADF (Jira cloud, REST v3) ----------

_ADF_MARKS = {
    "strong": {"type": "strong"}, "b": {"type": "strong"},
    "em": {"type": "em"}, "i": {"type": "em"},
    "u": {"type": "underline"},
    "s": {"type": "strike"}, "del": {"type": "strike"},
    "code": {"type": "code"},
}


def _adf_text(text, marks):
    node = {"type": "text", "text": text}
    if marks:
        node["marks"] = list(marks)
    return node


def _adf_inlines(nodes, marks=()):
    out = []
    for n in nodes:
        if isinstance(n, str):
            if n:
                out.append(_adf_text(n, marks))
        elif n[0] == "br":
            out.append({"type": "hardBreak"})
        elif n[0] == "img":
            alt = n[1].get("alt") or n[1].get("src")
            if alt:
                out.append(_adf_text(alt, marks))
        elif n[0] == "a":
            href = n[1].get("href")
            m = ({"type": "link", "attrs": {"href": href}},) if href else ()
            out.extend(_adf_inlines(n[2], marks + m))
        elif n[0] in _ADF_MARKS:
            out.extend(_adf_inlines(n[2], marks + (_ADF_MARKS[n[0]],)))
        else:
            out.extend(_adf_inlines(n[2], marks))
    return out


def _merge_text(inlines):
    out = []
    for n in inlines:
        if (out and n.get("type") == "text" and out[-1].get("type") == "text"
                and out[-1].get("marks") == n.get("marks")):
            out[-1]["text"] += n["text"]
        else:
            out.append(n)
    return out


def _para(content):
    content = _merge_text(content)
    return {"type": "paragraph", "content": content} if content else {"type": "paragraph"}


def _adf_list(node):
    ltype = "bulletList" if node[0] == "ul" else "orderedList"
    items = []
    for ch in node[2]:
        if isinstance(ch, list) and ch[0] == "li":
            content = _adf_blocks(ch[2]) or [{"type": "paragraph"}]
            items.append({"type": "listItem", "content": content})
    return {"type": ltype, "content": items}


def _table_rows(node):
    rows = []

    def walk(ns):
        for n in ns:
            if isinstance(n, list):
                if n[0] == "tr":
                    rows.append(n)
                else:
                    walk(n[2])

    walk(node[2])
    return [" | ".join(t for t in
                       (_text_of(c[2]) for c in tr[2]
                        if isinstance(c, list) and c[0] in ("td", "th")) if t)
            for tr in rows]


def _adf_table(node):
    # ADF table nodes are heavy; collapse each row to a plain paragraph.
    blocks = [{"type": "paragraph",
               "content": [{"type": "text", "text": row}]}
              for row in _table_rows(node) if row]
    return blocks or [{"type": "paragraph"}]


def _adf_blocks(nodes):
    blocks, pending = [], []

    def flush():
        nonlocal pending
        if pending:
            blocks.append(_para(_adf_inlines(pending)))
            pending = []

    for n in nodes:
        if isinstance(n, str) or (isinstance(n, list) and n[0] in INLINE):
            pending.append(n)
        elif n[0] == "p":
            flush()
            blocks.append(_para(_adf_inlines(n[2])))
        elif n[0] in HEADINGS:
            flush()
            blocks.append({"type": "heading", "attrs": {"level": HEADINGS[n[0]]},
                           "content": _merge_text(_adf_inlines(n[2]))})
        elif n[0] in ("ul", "ol"):
            flush()
            blocks.append(_adf_list(n))
        elif n[0] == "blockquote":
            flush()
            blocks.append({"type": "blockquote", "content": _adf_blocks(n[2])})
        elif n[0] == "pre":
            flush()
            text = _text_of(n[2]).strip("\n")
            blocks.append({"type": "codeBlock",
                           "content": [{"type": "text", "text": text}] if text else []})
        elif n[0] == "hr":
            flush()
            blocks.append({"type": "rule"})
        elif n[0] == "table":
            flush()
            blocks.extend(_adf_table(n))
        else:
            pending.append(n)
    flush()
    return blocks


def html_to_adf(html):
    return {"type": "doc", "version": 1,
            "content": _adf_blocks(_clean(_parse(html)))}


def adf_to_text(doc):
    """Flatten an ADF doc/node to plain text (for generic field display)."""
    out = []

    def walk(n):
        if isinstance(n, list):
            for x in n:
                walk(x)
            return
        if not isinstance(n, dict):
            return
        t = n.get("type")
        if t == "text":
            out.append(n.get("text") or "")
        elif t == "hardBreak":
            out.append("\n")
        elif t in ("paragraph", "heading", "blockquote", "listItem",
                   "codeBlock", "panel", "rule", "expand", "table",
                   "tableRow", "tableCell", "tableHeader", "mediaSingle",
                   "media", "mention", "emoji", "date", "status"):
            out.append("\n")
            for c in n.get("content") or []:
                walk(c)
            out.append("\n")
        elif t in ("bulletList", "orderedList", "doc"):
            for c in n.get("content") or []:
                walk(c)
        else:
            for c in n.get("content") or []:
                walk(c)

    walk(doc)
    text = "".join(out)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ---------- wiki markup (Jira server/DC) ----------

_WIKI_MARKS = {
    "strong": ("*", "*"), "b": ("*", "*"),
    "em": ("_", "_"), "i": ("_", "_"),
    "u": ("+", "+"),
    "s": ("-", "-"), "del": ("-", "-"),
}


def _wiki_inline(nodes):
    parts = []
    for n in nodes:
        if isinstance(n, str):
            parts.append(n)
        elif n[0] == "br":
            parts.append("\n")
        elif n[0] == "img":
            src = n[1].get("src")
            if src:
                parts.append(f"!{src}!")
        elif n[0] == "a":
            href = n[1].get("href")
            text = _wiki_inline(n[2]).strip() or href or ""
            parts.append(f"[{text}|{href}]" if href else text)
        elif n[0] == "code":
            parts.append("{{" + _wiki_inline(n[2]) + "}}")
        elif n[0] in _WIKI_MARKS:
            l, r = _WIKI_MARKS[n[0]]
            parts.append(l + _wiki_inline(n[2]) + r)
        else:
            parts.append(_wiki_inline(n[2]))
    return "".join(parts)


def _wiki_list(node, out):
    marker = "* " if node[0] == "ul" else "# "
    for ch in node[2]:
        if not (isinstance(ch, list) and ch[0] == "li"):
            continue
        body = _wiki_blocks(ch[2]).strip("\n")
        lines = body.split("\n") if body else [""]
        out.append((marker + lines[0]).rstrip())
        out.extend("  " + l for l in lines[1:])
        # shortcut: nested lists flatten to this level — Jira wiki nesting needs
        # repeated markers; good enough for a local client.


def _wiki_blocks(nodes):
    blocks, pending = [], []

    def flush():
        nonlocal pending
        if pending:
            text = _wiki_inline(pending).strip()
            if text:
                blocks.append(text)
            pending = []

    for n in nodes:
        if isinstance(n, str) or (isinstance(n, list) and n[0] in INLINE):
            pending.append(n)
        elif n[0] == "p":
            flush()
            text = _wiki_inline(n[2]).strip()
            if text:
                blocks.append(text)
        elif n[0] in HEADINGS:
            flush()
            text = _wiki_inline(n[2]).strip()
            if text:
                blocks.append(f"h{HEADINGS[n[0]]}. {text}")
        elif n[0] in ("ul", "ol"):
            flush()
            lines = []
            _wiki_list(n, lines)
            if lines:
                blocks.append("\n".join(lines))
        elif n[0] == "blockquote":
            flush()
            text = _wiki_blocks(n[2]).strip("\n")
            if text:
                blocks.append("{quote}\n" + text + "\n{/quote}")
        elif n[0] == "pre":
            flush()
            text = _text_of(n[2]).strip("\n")
            if text:
                blocks.append("{code}\n" + text + "\n{/code}")
        elif n[0] == "hr":
            flush()
            blocks.append("----")
        elif n[0] == "table":
            flush()
            blocks.extend(r for r in _table_rows(n) if r)
        else:
            pending.append(n)
    flush()
    return "\n\n".join(blocks)


def html_to_wiki(html):
    return _wiki_blocks(_clean(_parse(html)))


# ---------- plain text ----------

_BLOCK = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
          "blockquote", "pre", "table", "thead", "tbody", "tr", "hr"}


def html_to_text(html):
    parts = []

    def walk(nodes):
        for n in nodes:
            if isinstance(n, str):
                parts.append(n)
            elif n[0] == "br":
                parts.append("\n")
            elif n[0] == "img":
                parts.append(n[1].get("alt") or "")
            elif n[0] in _BLOCK:
                parts.append("\n")
                walk(n[2])
                parts.append("\n")
            else:
                walk(n[2])

    walk(_clean(_parse(html)))
    text = "".join(parts)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return "\n".join(line.strip() for line in text.split("\n")).strip()
