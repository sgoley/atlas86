from atlas86.convert import (html_to_adf, html_to_text, html_to_wiki,
                              sanitize_html)


def test_sanitize_strips_script_attrs_and_unwraps():
    html = ('<p>hi<script>alert(1)</script><style>x{}</style>'
            '<b onclick="evil()">bold</b><span>wrap</span>'
            '<a href="javascript:x" onclick="y">l</a>'
            '<a href="https://ok">ok</a>'
            '<img src="s.png" onerror="z" alt="pic"></p>')
    out = sanitize_html(html)
    assert "<script" not in out and "alert" not in out
    assert "<style" not in out
    assert "onclick" not in out and "onerror" not in out
    assert "<span>" not in out and "wrap" in out
    assert "javascript" not in out
    assert 'rel="noopener"' in out
    assert 'href="https://ok"' in out
    assert 'src="s.png"' in out and 'alt="pic"' in out


def test_html_to_adf_headings_lists_marks():
    html = ('<h2>Title</h2><p>Hello <strong>bold</strong> '
            '<em>em</em> <a href="https://x">link</a></p>'
            '<ul><li>one</li><li>two</li></ul>')
    doc = html_to_adf(html)
    assert doc["type"] == "doc" and doc["version"] == 1
    h = doc["content"][0]
    assert h["type"] == "heading" and h["attrs"]["level"] == 2
    p = doc["content"][1]
    assert p["type"] == "paragraph"
    marks = [m["type"] for n in p["content"] for m in n.get("marks", [])]
    assert "strong" in marks and "em" in marks and "link" in marks
    lst = doc["content"][2]
    assert lst["type"] == "bulletList" and len(lst["content"]) == 2
    assert all(i["type"] == "listItem" for i in lst["content"])


def test_html_to_adf_escapes_and_breaks():
    doc = html_to_adf("<p>a<br>b &amp; c</p>")
    p = doc["content"][0]
    types = [n["type"] for n in p["content"]]
    assert types == ["text", "hardBreak", "text"]
    assert p["content"][2]["text"] == "b & c"


def test_html_to_wiki_marks_and_lists():
    html = ('<h2>Title</h2><p>Hello <strong>bold</strong> '
            '<em>em</em> <a href="https://x">link</a></p>'
            '<ul><li>one</li><li>two</li></ul>')
    out = html_to_wiki(html)
    assert "h2. Title" in out
    assert "*bold*" in out and "_em_" in out
    assert "[link|https://x]" in out
    assert "* one" in out and "* two" in out


def test_html_to_text_fallback():
    out = html_to_text("<p>Hello <b>world</b></p><p>Second<br>line</p>")
    assert "Hello world" in out
    assert "Second" in out and "line" in out
    assert "<" not in out
