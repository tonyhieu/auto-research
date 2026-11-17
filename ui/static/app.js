// Read-only ledger browser. Routes: #/<slug>, #/<slug>/<finding id>, #/<slug>/docs/<group>/<name>.
// Markdown arrives pre-rendered from the server as {md, html}; everything else is escaped here.
// Live updates: /api/events (SSE) triggers refetches; the server pushes no data itself.

const $ = (id) => document.getElementById(id);
const BUCKETS = [["refuted", "Refuted"], ["known", "Not novel"], ["pending", "Novelty pending"]];
const DOC_GROUPS = [["reports", "Reports"], ["state", "Focus states"], ["notes", "Notes"], ["brief", "Brief"]];
const CHIP = { citation: "cit", adversarial: "adv", reproduce: "rep", novelty: "nov" };

const state = {
  topics: [],
  slug: null,
  topic: null, // GET /api/topics/{slug}
  docs: [],
  query: "",
  tab: "inspector", // "inspector" | "run"
  view: null, // {type: "finding", id} | {type: "doc", group, name} | null
  detail: null, // fetched body for `view`
  open: new Set(), // sidebar <details> keys left open by the user
  seq: 0, // guards against out-of-order detail responses
  topicListSeq: 0, // same, for refetches of /api/topics
  openTopicSeq: 0, // same, for refetches of the open topic
};
const ALL_PARTS = ["ledger", "verifications", "tasks", "docs"]; // topic-changed parts (arui/events.py)
const RUN_VERB = { complete: "finished", signal: "stopped", error: "failed", lost: "lost" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const day = (ts) => (ts ? ts.slice(0, 10) : "");
const minute = (ts) => (ts ? ts.slice(0, 16).replace("T", " ") : "");

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

function parseHash() {
  let parts;
  try {
    parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  } catch {
    return { slug: null, view: null }; // malformed escape, e.g. #/%
  }
  const [slug, a, ...rest] = parts;
  if (a === "docs" && rest.length === 2) return { slug, view: { type: "doc", group: rest[0], name: rest[1] } };
  if (a) return { slug, view: { type: "finding", id: a } };
  return { slug: slug || null, view: null };
}

const findingHash = (id) => `#/${encodeURIComponent(state.slug)}/${id}`;
const docHash = (group, name) => `#/${encodeURIComponent(state.slug)}/docs/${group}/${encodeURIComponent(name)}`;

async function route() {
  const { slug, view } = parseHash();
  if (!slug) {
    if (state.topics.length) location.replace(`#/${encodeURIComponent(state.topics[0].slug)}`);
    else renderAll();
    return;
  }
  if (slug !== state.slug || !state.topic) {
    state.slug = slug;
    state.topic = null;
    state.docs = [];
    try {
      const loaded = await Promise.all([api(`/api/topics/${encodeURIComponent(slug)}`), api(`/api/topics/${encodeURIComponent(slug)}/docs`)]);
      if (parseHash().slug !== slug) return; // a later route() owns the page now
      [state.topic, state.docs] = loaded;
    } catch (e) {
      if (parseHash().slug !== slug) return;
      state.view = null;
      renderAll(`Could not load topic ${slug}: ${e.message}`);
      return;
    }
  }
  state.view = view;
  if (view) state.tab = "inspector";
  await loadDetail();
}

async function fetchDetail(v) {
  const base = `/api/topics/${encodeURIComponent(state.slug)}`;
  try {
    return v.type === "finding" ? await api(`${base}/findings/${encodeURIComponent(v.id)}`) : await api(`${base}/docs/${encodeURIComponent(v.group)}/${encodeURIComponent(v.name)}`);
  } catch (e) {
    return { error: e.message };
  }
}

async function loadDetail() {
  const seq = ++state.seq;
  state.detail = null;
  renderAll();
  const v = state.view;
  if (!v) return;
  const detail = await fetchDetail(v);
  if (seq !== state.seq) return;
  state.detail = detail;
  renderPane();
  renderRows(); // the viewing accent bar follows the open finding
}

// Refetch the open view in place: the old body stays up meanwhile and the pane keeps its scroll.
async function reloadDetail() {
  const seq = ++state.seq;
  const v = state.view;
  if (!v) return;
  const detail = await fetchDetail(v);
  if (seq !== state.seq || v !== state.view) return;
  state.detail = detail;
  renderPane(true);
}

async function refreshTopics() {
  const seq = ++state.topicListSeq;
  let topics;
  try {
    topics = await api("/api/topics");
  } catch {
    return; // keep the last list; the next event retries
  }
  if (seq !== state.topicListSeq) return;
  state.topics = topics;
  if (!state.slug) return route(); // e.g. the first topic just appeared
  renderSidebar();
  renderStrip();
}

// Refetch the open topic, keeping selection, scroll, tab, and search; `force` always reloads the Inspector.
async function refreshTopic(parts, force = false) {
  const slug = state.slug;
  if (!slug || !state.topic) return; // route() is loading it
  const seq = ++state.openTopicSeq;
  const base = `/api/topics/${encodeURIComponent(slug)}`;
  let topic, docs;
  try {
    [topic, docs] = await Promise.all([api(base), parts.includes("docs") ? api(`${base}/docs`) : state.docs]);
  } catch {
    return;
  }
  if (seq !== state.openTopicSeq || slug !== state.slug || !state.topic) return;
  const v = state.view;
  const checks = (t) => JSON.stringify(t.findings.find((f) => f.id === v.id)?.checks);
  // Docs are rewritten in place, so any docs change reloads an open doc.
  const changed = v?.type === "finding" ? checks(state.topic) !== checks(topic) : v?.type === "doc" && parts.includes("docs");
  state.topic = topic;
  state.docs = docs;
  renderSidebar();
  renderMain();
  if (v && (force || changed)) await reloadDetail();
}

function matches(f) {
  const q = state.query.trim().toLowerCase();
  return !q || [f.title.md, f.claim.md, f.id, f.kind].some((s) => s.toLowerCase().includes(q));
}

function details(key, summary, body) {
  return `<details data-key="${esc(key)}"${state.open.has(key) ? " open" : ""}><summary>${summary}</summary>${body}</details>`;
}

function renderSidebar() {
  $("topics").innerHTML =
    state.topics
      .map(
        (t) =>
          `<a href="#/${encodeURIComponent(t.slug)}" class="${t.slug === state.slug ? "on" : ""}" title="${esc(t.slug)}"><span>${esc(t.title)}${
            t.run.state === "running" ? '<span class="dot" title="running"></span>' : ""
          }</span><small>${t.counts.main}</small></a>`,
      )
      .join("") || '<div class="none">No topics in topics/</div>';

  const v = state.view;
  const docGroups = DOC_GROUPS.map(([g, label]) => {
    const ds = state.docs.filter((d) => d.group === g);
    if (!ds.length) return "";
    const rows = ds
      .map((d) => {
        const on = v?.type === "doc" && v.group === g && v.name === d.name;
        return `<a class="ar${on ? " on" : ""}" href="${docHash(g, d.name)}"><b>${esc(d.name.replace(/\.md$/, ""))}</b>${esc(day(new Date(d.mtime * 1000).toISOString()))}</a>`;
      })
      .join("");
    return details(`docs:${g}`, `${label} <small>${ds.length}</small>`, rows);
  }).join("");
  $("docs").innerHTML = state.topic && docGroups ? `<h4>Docs</h4>${docGroups}` : "";

  const findings = state.topic?.findings ?? [];
  $("hidden").innerHTML = state.topic
    ? `<h4>Hidden</h4>${BUCKETS.map(([b, label]) => {
        const fs = findings.filter((f) => f.bucket === b && matches(f));
        const rows = fs.map((f) => `<a class="ar op${v?.id === f.id ? " on" : ""}" href="${findingHash(f.id)}" title="${esc(f.claim.md)}"><b>${f.id}</b>${f.title.html}</a>`).join("");
        return details(`bucket:${b}`, `${label} <small>${fs.length}</small>`, rows);
      }).join("")}`
    : "";
}

function chips(checks) {
  return Object.entries(checks)
    .map(([c, v]) => `<span class="ck ck-${v ?? "none"}" title="${c}: ${v ?? "not checked"}">${CHIP[c]}</span>`)
    .join("");
}

function renderRows() {
  const t = state.topic;
  if (!t) {
    $("rows").innerHTML = "";
    $("count").textContent = "";
    return;
  }
  const rows = t.findings.filter((f) => f.bucket === "main" && matches(f));
  $("count").textContent = `${rows.length} hypothes${rows.length === 1 ? "is" : "es"}`;
  const viewing = state.view?.type === "finding" ? state.view.id : null;
  $("rows").innerHTML =
    rows
      .map(
        (f) =>
          `<div class="h${f.id === viewing ? " viewing" : ""}" data-row="${f.id}" title="${esc(f.claim.md)}"><div><p>${f.title.html}</p><div class="m"><code>${f.id}</code> &middot; ${esc(f.kind)} &middot; ${day(f.ts)}</div></div><div class="cks">${chips(f.checks)}</div></div>`,
      )
      .join("") || `<div class="none">${t.findings.length ? "No matching findings" : "No findings yet"}</div>`;
}

function runText(run) {
  if (run.state === "running") {
    const s = run.start;
    return `<span class="dot"></span><b>Running</b>${s ? ` &middot; ${esc(s.mode)} run${s.focusKey ? ` &middot; ${esc(s.focusKey)}` : ""} &middot; since ${minute(s.ts)}` : ` &middot; pid ${run.pid}`}`;
  }
  const l = run.last;
  return `<b>Idle</b>${l ? ` &middot; last ${esc(l.mode)} run${l.focusKey ? ` ${esc(l.focusKey)}` : ""} ${esc(RUN_VERB[l.reason] ?? l.reason)} ${minute(l.end ?? l.start)}` : " &middot; no runs yet"}`;
}

function renderStrip() {
  const run = state.topics.find((t) => t.slug === state.slug)?.run ?? state.topic?.run;
  $("strip").innerHTML = run ? `<div class="strip ${run.state}">${runText(run)}</div>` : "";
}

function toast(d) {
  const title = state.topics.find((t) => t.slug === d.slug)?.title ?? d.slug;
  const n = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
  const el = document.createElement("div");
  el.className = `toast ${d.reason}`;
  el.innerHTML = `<b>${esc(title)}</b>${esc(d.mode)} run ${esc(RUN_VERB[d.reason] ?? d.reason)}: ${n(d.newFindings, "new finding")}, ${n(d.newVerifications, "verdict")}`;
  el.onclick = () => el.remove();
  $("toasts").append(el);
  setTimeout(() => el.remove(), 10000);
}

function renderMain(error) {
  const t = state.topic;
  $("warn").innerHTML = error
    ? `<div class="warn">${esc(error)}</div>`
    : t?.invalidLines
      ? `<div class="warn">${t.invalidLines} invalid ledger line(s) skipped; run <code>arui validate ${esc(t.slug)}</code></div>`
      : "";
  const m = t?.mainHypothesis;
  $("cur").innerHTML = m
    ? `<div class="cur"><div class="lab"></div><div class="t">Current main hypothesis${
        m.focusKey ? ` &middot; last focus ${esc(m.focusKey)} <b class="${esc(m.outcome)}">${esc(m.outcome.replaceAll("_", " ").toUpperCase())}</b> &middot; ${day(m.ts)}` : ""
      }${m.findingId ? ` &middot; <a class="fid" data-finding="${m.findingId}" href="${findingHash(m.findingId)}">${m.findingId}</a>` : ""}</div><div class="md">${m.claim.html}</div></div>`
    : "";
  renderRows();
}

const s2Link = (id, text, cls) => `<a class="${cls}" href="https://www.semanticscholar.org/paper/${id}" target="_blank" rel="noopener" title="${id}">${text}</a>`;

function findingHtml(d) {
  const known = new Set(state.topic.findings.map((f) => f.id));
  const src = (s) =>
    s.startsWith("f-")
      ? known.has(s)
        ? `<a class="fid" data-finding="${esc(s)}" href="${findingHash(s)}">${esc(s)}</a>`
        : `<span class="fid removed" title="removed from the ledger">${esc(s)}</span>`
      : /^[0-9a-f]{40}$/.test(s)
        ? s2Link(s, s.slice(0, 12), "paper mono")
        : `<code>${esc(s)}</code>`;
  // Cached title as link text; uncached ids render bare with a Semantic Scholar link.
  const paper = (p) =>
    (/^[0-9a-f]{40}$/.test(p.id)
      ? s2Link(p.id, esc(p.title ?? p.id), p.title ? "paper" : "paper mono")
      : `<code>${esc(p.id)}</code>${p.title ? ` ${esc(p.title)}` : ""}`) + (p.year ? ` (${p.year})` : "");
  const novelty = d.novelty ?? "pending";
  const task = d.task
    ? `<div class="dm">Task <code>${esc(d.task.id)}</code>${d.task.title ? `: ${esc(d.task.title)}` : ""}${
        d.task.notePath ? ` &middot; <a data-doc="${esc(d.task.notePath)}" href="#">note</a>` : ""
      }</div>`
    : "";
  const exp = d.experiment ? `<h4>Experiment setup</h4><div class="md">${d.experiment.setup.html}</div><h4>Experiment results</h4><div class="md">${d.experiment.results.html}</div>` : "";
  const vfs = d.verifications
    .map(
      (v) =>
        `<div class="vf ${v.verdict}${v.superseded ? " sup" : ""}"><div class="vh"><b>${v.check}</b> <span class="vd">${v.verdict}</span> &middot; ${esc(v.by)} &middot; ${minute(v.ts)}${
          v.focus ? ` &middot; focus ${esc(v.focus.key)} <b>${esc(v.focus.outcome.replaceAll("_", " "))}</b>` : ""
        }${v.superseded ? " &middot; superseded" : ""}</div><div class="vr md">${v.rationale.html}</div>${v.sources.length ? `<div class="src">${v.sources.map(src).join("")}</div>` : ""}</div>`,
    )
    .join("");
  const papers = d.papers.length
    ? `<ul class="papers">${d.papers.map((p) => `<li>${paper(p)}</li>`).join("")}</ul>`
    : '<div class="empty">None</div>';
  const refs = d.references.map((r) => src(r.id)).join(" ") || '<span class="empty">none</span>';
  const refBy = d.referencedBy.map(src).join(" ") || '<span class="empty">none</span>';
  return `<header class="dh"><span class="did">${d.id}</span><span class="badge st-${d.status}">${d.status}</span><span class="badge nv-${novelty}">${novelty}</span>${
    d.role ? `<span class="badge role">${esc(d.role)}</span>` : ""
  }<div class="ttl">${d.title.html}</div><div class="dm">${esc(d.kind)} &middot; ${esc(d.author)} &middot; ${minute(d.ts)}</div>${task}</header>
<h4>Claim</h4><div class="md claim">${d.claim.html}</div>
<h4>Evidence</h4><div class="md">${d.evidence.html}</div>${exp}
<h4>Verifications (${d.verifications.length}, newest first)</h4>${vfs || '<div class="empty">None yet</div>'}
<h4>Papers (${d.papers.length})</h4>${papers}
<h4>Links</h4><div class="lk">References: ${refs}</div><div class="lk">Referenced by: ${refBy}</div>`;
}

function docHtml(d) {
  const meta = state.docs.find((x) => x.group === d.group && x.name === d.name);
  return `<header class="dh"><span class="did">${esc(d.name)}</span><div class="dm">${esc(d.group)}${meta ? ` &middot; updated ${minute(new Date(meta.mtime * 1000).toISOString())}` : ""}</div></header><div class="md" style="margin-top:14px">${d.html}</div>`;
}

function renderPane(keepScroll = false) {
  $("tab-run").className = state.tab === "run" ? "on" : "";
  $("tab-inspector").className = state.tab === "inspector" ? "on" : "";
  let body;
  if (state.tab === "run") body = '<div class="empty">Runs are started from the CLI for now: <code>./bin/research -t &lt;topic&gt; [-f &lt;finding&gt;]</code>.</div>';
  else if (!state.view) body = '<div class="empty">Click a finding or doc to inspect it.</div>';
  else if (!state.detail) body = '<div class="empty">Loading...</div>';
  else if (state.detail.error) body = `<div class="warn">${esc(state.detail.error)}</div>`;
  else body = `<article class="dv"><div class="dvi">${state.view.type === "finding" ? findingHtml(state.detail) : docHtml(state.detail)}</div></article>`;
  $("pane").innerHTML = body;
  if (!keepScroll) $("pane").parentElement.scrollTop = 0;
}

function renderAll(error) {
  renderSidebar();
  renderStrip();
  renderMain(error);
  renderPane();
}

document.addEventListener("click", (e) => {
  if (e.target.closest('a[target="_blank"]')) return;
  const el = e.target.closest("[data-finding],[data-doc],[data-row],#tab-run,#tab-inspector");
  if (!el) return;
  e.preventDefault();
  if (el.id === "tab-run" || el.id === "tab-inspector") {
    state.tab = el.id === "tab-run" ? "run" : "inspector";
    renderPane();
  } else if (el.dataset.doc) {
    const [group, name] = el.dataset.doc.split("/");
    location.hash = docHash(group, name);
  } else {
    location.hash = findingHash(el.dataset.finding ?? el.dataset.row);
  }
});

// Remember which sidebar groups are open so re-renders keep them.
document.addEventListener(
  "toggle",
  (e) => {
    const key = e.target.dataset?.key;
    if (key) e.target.open ? state.open.add(key) : state.open.delete(key);
  },
  true,
);

$("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  renderRows();
  renderSidebar();
});

window.addEventListener("hashchange", route);

// EventSource reconnects on its own; refetch on reconnect so missed events do not matter.
const es = new EventSource("/api/events");
let connected = false;
es.onopen = () => {
  if (connected) {
    refreshTopics();
    refreshTopic(ALL_PARTS, true);
  }
  connected = true;
};
for (const name of ["topic-changed", "run-started", "run-finished"]) {
  es.addEventListener(name, (e) => {
    const d = JSON.parse(e.data);
    refreshTopics();
    if (name === "topic-changed" && d.slug === state.slug) refreshTopic(d.parts);
    if (name === "run-finished") toast(d);
  });
}

try {
  state.topics = await api("/api/topics");
} catch (e) {
  renderAll(`Could not load topics: ${e.message}`);
}
await route();
