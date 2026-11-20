from arui.render import LinkContext, render, render_inline

PAPER = "b" * 40
CTX = LinkContext(findings={"f-0123abcd"}, notes={"t-00000001"}, focus={"fx-00000002"}, papers={PAPER: "A <title>"})


def test_raw_html_is_escaped():
    html = render("<script>alert(1)</script> and <b>x</b>")
    assert "<script>" not in html and "&lt;script&gt;" in html and "<b>" not in html


def test_tables_and_strikethrough():
    html = render("| n | acc |\n|---|---|\n| 3 | 0.81 |\n\n~~old~~")
    assert "<table>" in html and "<td>0.81</td>" in html and "<s>old</s>" in html


def test_links_known_and_removed_ids():
    html = render("See f-0123abcd and f-deadbeef, task t-00000001 and t-00000009, focus fx-00000002.", CTX)
    assert '<a class="fid" data-finding="f-0123abcd" href="#f-0123abcd">f-0123abcd</a>' in html
    assert '<span class="fid removed">f-deadbeef</span>' in html
    assert 'data-doc="notes/t-00000001.md"' in html and '<span class="tid" data-task="t-00000009">' in html
    assert 'data-doc="state/focus-fx-00000002.md"' in html


def test_finding_status_badges():
    ctx = LinkContext(findings={"f-0123abcd", "f-0000000b"}, status={"f-0123abcd": "refuted"})
    html = render("f-0123abcd, f-0000000b and f-deadbeef", ctx)
    assert '<a class="fid st-refuted" data-finding="f-0123abcd" href="#f-0123abcd" data-status="refuted" title="refuted">' in html
    assert '<a class="fid" data-finding="f-0000000b" href="#f-0000000b">' in html, "no status known, no badge"
    assert '<span class="fid removed" data-status="deleted" title="deleted from the ledger">f-deadbeef</span>' in html


def test_paper_links_use_cached_title_escaped():
    html = render(f"Per {PAPER} and {'c' * 40}.", CTX)
    assert f'href="https://www.semanticscholar.org/paper/{PAPER}"' in html and ">A &lt;title&gt;</a>" in html
    assert f">{'c' * 40}</a>" in html


def test_text_around_ids_stays_escaped_and_code_is_not_linked():
    html = render_inline("a < b f-0123abcd `f-0123abcd` [link f-0123abcd](http://x)", CTX)
    assert html.startswith('a &lt; b <a class="fid"')
    assert "<code>f-0123abcd</code>" in html
    assert '<a href="http://x">link f-0123abcd</a>' in html


def test_inline_has_no_paragraph():
    assert render_inline("**t** f-0123abcd", CTX).startswith("<strong>t</strong>")
    assert not render_inline("x").startswith("<p>")


def test_math_is_escaped_and_left_for_katex():
    html = render("loss $a_i * b_j < c$ on f-0123abcd\n\n$$\n\\sum_i x_i\n$$", CTX)
    assert '<span class="math inline">a_i * b_j &lt; c</span>' in html
    assert '<div class="math block">\n\\sum_i x_i\n</div>' in html
    assert 'data-finding="f-0123abcd"' in html


def test_dollar_amounts_are_not_math():
    assert "math" not in render("costs $5 and $10, or $ 3 $")
