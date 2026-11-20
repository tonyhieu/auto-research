"""Markdown -> safe HTML, with finding, task, focus, and paper ids turned into links."""

import re
from dataclasses import dataclass, field
from html import escape

from markdown_it import MarkdownIt
from markdown_it.rules_core import StateCore
from markdown_it.token import Token
from mdit_py_plugins.dollarmath import dollarmath_plugin

ID = re.compile(r"\b(f-[0-9a-f]{8}|t-[0-9a-f]{8}|fx-[0-9a-f]{8}|[0-9a-f]{40})\b")


@dataclass
class LinkContext:
    """What a topic knows about the ids it can link to."""

    findings: set[str] = field(default_factory=set)
    notes: set[str] = field(default_factory=set)  # task ids with notes/<id>.md
    focus: set[str] = field(default_factory=set)  # focus keys with state/focus-<key>.md
    papers: dict[str, str] = field(default_factory=dict)  # paperId -> title
    status: dict[str, str] = field(default_factory=dict)  # finding id -> effective status, shown as a badge


def id_html(m: str, ctx: LinkContext) -> str:
    if m.startswith("f-"):
        if m in ctx.findings:
            st = ctx.status.get(m)
            badge = f' data-status="{st}" title="{st}"' if st else ""
            return f'<a class="fid{f" st-{st}" if st else ""}" data-finding="{m}" href="#{m}"{badge}>{m}</a>'
        # Only badge deletions when statuses are known, i.e. in a topic's docs.
        badge = ' data-status="deleted" title="deleted from the ledger"' if ctx.status else ""
        return f'<span class="fid removed"{badge}>{m}</span>'
    if m.startswith("t-"):
        if m in ctx.notes:
            return f'<a class="tid" data-task="{m}" data-doc="notes/{m}.md" href="#{m}">{m}</a>'
        return f'<span class="tid" data-task="{m}">{m}</span>'
    if m.startswith("fx-"):
        if m in ctx.focus:
            return f'<a class="fxid" data-doc="state/focus-{m}.md" href="#{m}">{m}</a>'
        return f'<span class="fxid">{m}</span>'
    text = escape(ctx.papers.get(m) or m)
    return f'<a class="paper" href="https://www.semanticscholar.org/paper/{m}" target="_blank" rel="noopener" title="{m}">{text}</a>'


def link_ids(state: StateCore) -> None:
    ctx: LinkContext | None = state.env.get("links")
    if ctx is None:
        return
    for block in state.tokens:
        if block.type != "inline" or not block.children:
            continue
        out: list[Token] = []
        depth = 0  # inside an existing link, leave text alone
        for tok in block.children:
            depth += tok.type == "link_open"
            depth -= tok.type == "link_close"
            if tok.type != "text" or depth or not ID.search(tok.content):
                out.append(tok)
                continue
            # Split the text token; escape the plain parts since html_inline is emitted raw.
            pos = 0
            for m in ID.finditer(tok.content):
                html = Token("html_inline", "", 0)
                html.content = escape(tok.content[pos : m.start()], quote=False) + id_html(m.group(), ctx)
                out.append(html)
                pos = m.end()
            rest = Token("text", "", 0)
            rest.content = tok.content[pos:]
            out.append(rest)
        block.children = out


# html=False escapes raw HTML in agent text, so no sanitizer is needed.
MD = MarkdownIt("commonmark", {"html": False, "linkify": True}).enable(["table", "strikethrough", "linkify"])
# $..$ / $$..$$ become escaped .math spans/divs that the client typesets with KaTeX; no digits/spaces at the edges keeps "$5 and $10" plain.
MD.use(dollarmath_plugin, allow_space=False, allow_digits=False, double_inline=True)
MD.core.ruler.push("link_ids", link_ids)


def render(md: str, ctx: LinkContext | None = None) -> str:
    return MD.render(md, {"links": ctx or LinkContext()})


def render_inline(md: str, ctx: LinkContext | None = None) -> str:
    return MD.renderInline(md, {"links": ctx or LinkContext()})


def rendered(md: str, ctx: LinkContext | None = None, inline: bool = False) -> dict[str, str]:
    """The `{md, html}` shape the API returns for Markdown fields."""
    return {"md": md, "html": (render_inline if inline else render)(md, ctx)}
