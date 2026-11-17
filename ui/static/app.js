// Ledger browser and run control. Routes: #/<slug>, #/<slug>/<finding id>, #/<slug>/docs/<group>/<name>.
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
  mode: "breadth", // Run tab mode; only the toggle, "Add to focus selection", and "Edit and start" change it
  selection: [], // finding ids picked for a focus run (cleared on topic change)
  direction: "",
  opts: { windows: 1, concurrency: 3 }, // shared by the Run tab and the new-topic form
  posting: false, // a start request is in flight
  runError: "", // html from the last failed start/stop
  newTopic: null, // {title, brief, preview: html | null, posting, error} while the form replaces the tabs
  view: null, // {type: "finding", id} | {type: "doc", group, name} | null
  detail: null, // fetched body for `view`
  preprints: {}, // slug -> GET /api/topics/{slug}/preprint; polled while running
  open: new Set(), // sidebar <details> keys left open by the user
  seq: 0, // guards against out-of-order detail responses
  topicListSeq: 0, // same, for refetches of /api/topics
  openTopicSeq: 0, // same, for refetches of the open topic
};
const ALL_PARTS = ["ledger", "verifications", "tasks", "docs"]; // topic-changed parts (arui/events.py)
const RUN_VERB = { complete: "finished", signal: "stopped", error: "failed", lost: "lost" };
const FINDING_ID = /^f-[0-9a-f]{8}$/;
const PREPRINT_POLL_MS = 5000;
// A free-text focus target becomes a finding claim: FindingInput.claim length limits in arui/models.py.
const CLAIM_MIN = 20;
const CLAIM_MAX = 1000;
const BRIEF_CAP = 12000; // as in topic.ts

// Copy of slugify in src/topic.ts, for the slug preview only (the server returns the real slug).
const slugify = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Same as compose_target in arui/runs.py, for the live counter; the server stays the authority.
function composeTarget(ids, direction) {
  const d = direction.split(/\s+/).filter(Boolean).join(" ");
  if (ids.length === 1 && !d) return ids[0];
  return [d, ids.length ? `(builds on ${ids.join(", ")})` : ""].filter(Boolean).join(" ");
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const day = (ts) => (ts ? ts.slice(0, 10) : "");
const minute = (ts) => (ts ? ts.slice(0, 16).replace("T", " ") : "");

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

// POST JSON (the server rejects other content types); never throws.
async function post(path, body) {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
  } catch (e) {
    return { ok: false, status: 0, body: { detail: e.message } };
  }
}

// FastAPI errors: a string, a validation error list, or {error, output} from a child that exited early.
function errorHtml(r) {
  const d = r.body?.detail;
  if (typeof d === "string") return `<div class="warn">${esc(d)}</div>`;
  if (Array.isArray(d)) return `<div class="warn">${esc(d.map((e) => `${e.loc.slice(1).join(".")}: ${e.msg}`).join("; "))}</div>`;
  if (d?.error) return `<div class="warn">${esc(d.error)}</div>${d.output ? `<pre class="out">${esc(d.output)}</pre>` : ""}`;
  return `<div class="warn">Request failed (${r.status})</div>`;
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
    if (slug !== state.slug) {
      state.selection = [];
      state.direction = "";
      state.runError = "";
    }
    state.slug = slug;
    state.topic = null;
    state.docs = [];
    try {
      const loaded = await Promise.all([api(`/api/topics/${encodeURIComponent(slug)}`), api(`/api/topics/${encodeURIComponent(slug)}/docs`)]);
      if (parseHash().slug !== slug) return; // a later route() owns the page now
      [state.topic, state.docs] = loaded;
      loadPreprint(slug);
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
  if (state.tab === "inspector" && !state.newTopic) renderPane(true); // never clobber a form being typed in
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
  // A new topic opened before its directory existed: load it now that it is listed.
  if (!state.topic && topics.some((t) => t.slug === state.slug)) return route();
  renderSidebar();
  renderStrip();
  syncRunControls();
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
  const picked = new Set(state.selection);
  $("rows").innerHTML =
    rows
      .map(
        (f) =>
          `<div class="h${f.id === viewing ? " viewing" : ""}${picked.has(f.id) ? " on" : ""}" data-row="${f.id}" title="${esc(f.claim.md)}"><input type="checkbox" data-pick="${f.id}" title="Focus selection"${
            picked.has(f.id) ? " checked" : ""
          }><div><p>${f.title.html}</p><div class="m"><code>${f.id}</code> &middot; ${esc(f.kind)} &middot; ${day(f.ts)}</div></div><div class="cks">${chips(f.checks)}</div></div>`,
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

const currentRun = () => state.topics.find((t) => t.slug === state.slug)?.run ?? state.topic?.run;
const stopButton = (run) => (run.state === "running" ? '<button class="btn2" data-act="stop">Stop</button>' : "");

function renderStrip() {
  const run = currentRun();
  $("strip").innerHTML = run ? `<div class="strip ${run.state}">${runText(run)}${stopButton(run)}</div>` : "";
}

function toast(d) {
  const n = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
  notify(d.slug, d.reason, `${esc(d.mode)} run ${esc(RUN_VERB[d.reason] ?? d.reason)}: ${n(d.newFindings, "new finding")}, ${n(d.newVerifications, "verdict")}`);
}

// `cls` is a toast color class (complete, error, lost, signal); `html` is already escaped.
function notify(slug, cls, html) {
  const title = state.topics.find((t) => t.slug === slug)?.title ?? slug;
  const el = document.createElement("div");
  el.className = `toast ${cls}`;
  el.innerHTML = `<b>${esc(title)}</b>${html}`;
  el.onclick = () => el.remove();
  $("toasts").append(el);
  setTimeout(() => el.remove(), 10000);
}

async function loadPreprint(slug) {
  let s;
  try {
    s = await api(`/api/topics/${encodeURIComponent(slug)}/preprint`);
  } catch {
    return; // the next poll retries
  }
  const was = state.preprints[slug];
  state.preprints[slug] = s;
  if (was?.running && !s.running) {
    if (s.exitCode === 0) notify(slug, "complete", `Pre-print written: <code>${esc(s.path)}</code>`);
    else notify(slug, "error", `Pre-print failed (exit ${esc(s.exitCode)}); see topics/.ui/${esc(slug)}-preprint-*.out`);
  }
  if (slug === state.slug) renderFoot();
}

async function startPreprint() {
  const slug = state.slug;
  state.preprints[slug] = { running: true, path: null, exitCode: null };
  renderFoot();
  const r = await post(`/api/topics/${encodeURIComponent(slug)}/preprint`, {});
  if (r.ok) {
    state.preprints[slug] = r.body;
    notify(slug, "complete", `Writing a pre-print of ${esc(r.body.findingId)} to <code>${esc(r.body.path)}</code>`);
  } else {
    state.preprints[slug] = { running: false, path: null, exitCode: null };
    const d = r.body?.detail;
    notify(slug, "error", `Pre-print not started: ${esc(typeof d === "string" ? d : (d?.error ?? `request failed (${r.status})`))}`);
  }
  if (slug === state.slug) renderFoot();
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
<h4>Links</h4><div class="lk">References: ${refs}</div><div class="lk">Referenced by: ${refBy}</div>
<div class="dact">${
    state.selection.includes(d.id)
      ? '<button class="btn2" disabled>In focus selection</button>'
      : `<button class="btn2" data-act="pick" data-id="${esc(d.id)}">Add to focus selection</button>`
  }</div>`;
}

function docHtml(d) {
  const meta = state.docs.find((x) => x.group === d.group && x.name === d.name);
  return `<header class="dh"><span class="did">${esc(d.name)}</span><div class="dm">${esc(d.group)}${meta ? ` &middot; updated ${minute(new Date(meta.mtime * 1000).toISOString())}` : ""}</div></header><div class="md" style="margin-top:14px">${d.html}</div>`;
}

const optsHtml = () =>
  `<div class="opts">${["windows", "concurrency"].map((k) => `<label>${k} <input type="number" min="1" step="1" id="opt-${k}" value="${esc(state.opts[k])}"></label>`).join("")}</div>`;
const optsValid = () => Object.values(state.opts).every((n) => Number.isInteger(n) && n >= 1);

function runHtml() {
  if (!state.topic) return '<div class="empty">Open a topic to start a run on it.</div>';
  const n = state.selection.length;
  const seg = `<div class="seg">${[
    ["breadth", "Breadth"],
    ["focus", "Focus"],
  ]
    .map(([m, label]) => `<button data-mode="${m}" class="${state.mode === m ? "on" : ""}">${label}</button>`)
    .join("")}</div>`;
  let body;
  if (state.mode === "focus") {
    const byId = new Map(state.topic.findings.map((f) => [f.id, f]));
    const rows = state.selection
      .map(
        (id) =>
          `<div><a class="fid" data-finding="${esc(id)}" href="${findingHash(id)}">${esc(id)}</a><span>${byId.get(id)?.title.html ?? ""}</span><a class="rm" href="#" data-act="unpick" data-id="${esc(id)}" title="Remove">&times;</a></div>`,
      )
      .join("");
    body = `<h3>Selected findings <small>${n}</small></h3>${
      rows ? `<div class="sel">${rows}</div>` : '<div class="empty">Tick findings in the list, or use "Add to focus selection" in the Inspector.</div>'
    }<label class="l" for="direction">Direction</label><textarea id="direction" placeholder="What should the focus run test?">${esc(state.direction)}</textarea><div id="dir-count" class="ctr"></div>`;
  } else {
    body = n ? `<p class="note">${n} selected finding${n === 1 ? " is" : "s are"} not used in a breadth run.</p>` : "";
  }
  return `<div class="composer">${seg}<div id="run-status"></div>${body}${optsHtml()}<button class="btn" id="start" data-act="start"></button><div id="run-error">${state.runError}</div></div>`;
}

// Live parts of the Run tab, updated in place so typing in Direction keeps focus.
function syncRunControls() {
  const start = $("start");
  if (!start) return;
  const run = currentRun();
  const running = run?.state === "running";
  $("run-status").innerHTML = running ? `<div class="strip running">${runText(run)}${stopButton(run)}</div>` : "";
  let blocked = false;
  if (state.mode === "focus") {
    const target = composeTarget(state.selection, state.direction);
    const single = FINDING_ID.test(target);
    const bad = !single && (target.length < CLAIM_MIN || target.length > CLAIM_MAX);
    blocked = !target || bad;
    const ctr = $("dir-count");
    ctr.textContent = single ? `Continues the focus on ${target}` : `Target ${target.length} / ${CLAIM_MAX}${target && target.length < CLAIM_MIN ? ` (min ${CLAIM_MIN})` : ""}`;
    ctr.className = `ctr${target && bad ? " over" : ""}`;
  }
  start.disabled = running || state.posting || blocked || !optsValid();
  start.textContent = state.posting ? "Starting..." : running ? "Running" : `Start ${state.mode} run`;
}

function newTopicHtml() {
  const n = state.newTopic;
  const brief =
    n.preview === null
      ? `<textarea id="nt-brief" placeholder="Goals, context, leads, constraints">${esc(n.brief)}</textarea>`
      : `<div class="md preview">${n.preview || '<span class="empty">Empty brief</span>'}</div>`;
  return `<div class="composer"><h3>New topic <a href="#" data-act="nt-cancel">Cancel</a></h3>
<label class="l" for="nt-title">Title</label><input id="nt-title" class="in" value="${esc(n.title)}" placeholder="Research topic"><div class="dm">Slug: <code id="nt-slug"></code></div>
<label class="l" for="nt-brief">Brief (optional, Markdown) &middot; <a href="#" data-act="nt-preview">${n.preview === null ? "Preview" : "Edit"}</a></label>${brief}<div id="nt-count" class="ctr"></div>
${optsHtml()}<button class="btn" id="nt-create" data-act="nt-create"></button><div id="nt-error">${n.error}</div></div>`;
}

function syncNewTopic() {
  const n = state.newTopic;
  if (!n || !$("nt-create")) return;
  const slug = slugify(n.title);
  const len = n.brief.trim().length;
  $("nt-slug").textContent = slug || "(needs letters or digits)";
  $("nt-count").textContent = `${len} / ${BRIEF_CAP}`;
  $("nt-count").className = `ctr${len > BRIEF_CAP ? " over" : ""}`;
  $("nt-create").disabled = n.posting || !slug || len > BRIEF_CAP || !optsValid();
  $("nt-create").textContent = n.posting ? "Starting..." : "Create and start breadth run";
}

function preprintButton() {
  const fid = state.topic?.mainHypothesis?.findingId;
  const running = state.preprints[state.slug]?.running;
  const title = fid ? `Summarize ${fid} and its related findings into pre-prints/${state.slug}/` : "No main finding to summarize yet";
  return `<button class="btn2" data-act="preprint" title="${esc(title)}"${!fid || running ? " disabled" : ""}>${running ? "Writing pre-print..." : "Pre-print"}</button>`;
}

function footHtml() {
  if (state.tab !== "inspector") return `<span></span>${preprintButton()}`;
  const ids = state.selection.map((id) => `<code>${esc(id)}</code>`).join(" ");
  return `<span>${ids ? `Selected: ${ids}` : "No findings selected"}</span><button class="btn" data-act="edit-start">Edit and start</button>${preprintButton()}`;
}

function renderFoot() {
  $("foot").innerHTML = state.newTopic === null && state.topic ? footHtml() : "";
}

function renderPane(keepScroll = false) {
  const form = state.newTopic !== null;
  $("tabs").hidden = form;
  $("tab-run").className = state.tab === "run" ? "on" : "";
  $("tab-run").textContent = state.mode === "focus" ? `Focus (${state.selection.length})` : "Run";
  $("tab-inspector").className = state.tab === "inspector" ? "on" : "";
  let body;
  if (form) body = newTopicHtml();
  else if (state.tab === "run") body = runHtml();
  else if (!state.view) body = '<div class="empty">Click a finding or doc to inspect it.</div>';
  else if (!state.detail) body = '<div class="empty">Loading...</div>';
  else if (state.detail.error) body = `<div class="warn">${esc(state.detail.error)}</div>`;
  else body = `<article class="dv"><div class="dvi">${state.view.type === "finding" ? findingHtml(state.detail) : docHtml(state.detail)}</div></article>`;
  $("pane").innerHTML = body;
  renderFoot();
  if (!keepScroll) $("pane").parentElement.scrollTop = 0;
  syncRunControls();
  syncNewTopic();
}

function setPicked(id, on) {
  state.selection = on ? [...new Set([...state.selection, id])] : state.selection.filter((x) => x !== id);
  renderRows();
  renderPane(true);
}

async function startRun() {
  const slug = state.slug;
  const focus = state.mode === "focus";
  const body = { mode: state.mode, findingIds: focus ? state.selection : [], direction: focus ? state.direction : "", ...state.opts };
  state.posting = true;
  syncRunControls();
  const r = await post(`/api/topics/${encodeURIComponent(slug)}/runs`, body);
  state.posting = false;
  if (slug === state.slug) state.runError = r.ok ? "" : errorHtml(r);
  if ($("run-error")) $("run-error").innerHTML = state.runError;
  syncRunControls();
  if (r.ok) refreshTopics();
}

async function stopRun() {
  const r = await post(`/api/topics/${encodeURIComponent(state.slug)}/stop`, {});
  state.runError = r.ok ? "" : errorHtml(r);
  if ($("run-error")) $("run-error").innerHTML = state.runError;
  refreshTopics();
}

async function createTopic() {
  const n = state.newTopic;
  n.posting = true;
  n.error = "";
  $("nt-error").innerHTML = "";
  syncNewTopic();
  const r = await post("/api/topics", { title: n.title, brief: n.brief, ...state.opts });
  n.posting = false;
  if (state.newTopic !== n) return; // cancelled meanwhile
  if (r.ok) {
    state.newTopic = null;
    state.tab = "run";
    state.mode = "breadth";
    location.hash = `#/${encodeURIComponent(r.body.slug)}`;
    renderPane();
    refreshTopics();
    return;
  }
  const slug = r.status === 409 ? r.body?.detail?.slug : null;
  n.error = slug ? `<div class="warn">Topic exists: <a href="#/${encodeURIComponent(slug)}" data-act="nt-open" data-slug="${esc(slug)}">open ${esc(slug)}</a></div>` : errorHtml(r);
  $("nt-error").innerHTML = n.error;
  syncNewTopic();
}

async function togglePreview() {
  const n = state.newTopic;
  if (n.preview === null) {
    const r = await post("/api/render", { md: n.brief });
    if (state.newTopic !== n) return;
    n.preview = r.ok ? r.body.html : errorHtml(r);
  } else {
    n.preview = null;
  }
  renderPane(true);
}

function action(el) {
  const id = el.dataset.id;
  if (el.dataset.mode) {
    state.mode = el.dataset.mode;
    renderPane(true);
    return;
  }
  switch (el.dataset.act) {
    case "start":
      return startRun();
    case "stop":
      return stopRun();
    case "preprint":
      return startPreprint();
    case "pick":
      state.mode = "focus";
      return setPicked(id, true);
    case "unpick":
      return setPicked(id, false);
    case "edit-start":
      state.mode = "focus";
      state.tab = "run";
      return renderPane();
    case "new-topic":
      state.newTopic ??= { title: "", brief: "", preview: null, posting: false, error: "" };
      renderPane();
      return $("nt-title").focus();
    case "nt-cancel":
      state.newTopic = null;
      return renderPane();
    case "nt-preview":
      return togglePreview();
    case "nt-create":
      return createTopic();
    case "nt-open":
      state.newTopic = null;
      location.hash = `#/${encodeURIComponent(el.dataset.slug)}`;
      return renderPane();
  }
}

function renderAll(error) {
  renderSidebar();
  renderStrip();
  renderMain(error);
  renderPane();
}

document.addEventListener("click", (e) => {
  if (e.target.closest('a[target="_blank"]') || e.target.matches("input[data-pick]")) return; // checkboxes: see "change"
  const act = e.target.closest("[data-act],[data-mode]");
  if (act) {
    e.preventDefault();
    action(act);
    return;
  }
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

document.addEventListener("change", (e) => {
  if (e.target.dataset?.pick) setPicked(e.target.dataset.pick, e.target.checked);
});

// Form fields write through to state; only the live counters and buttons re-render.
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "direction") state.direction = el.value;
  else if (el.id === "opt-windows" || el.id === "opt-concurrency") state.opts[el.id.slice(4)] = Number(el.value);
  else if (el.id === "nt-title") state.newTopic.title = el.value;
  else if (el.id === "nt-brief") state.newTopic.brief = el.value;
  else return;
  syncRunControls();
  syncNewTopic();
});

window.addEventListener("hashchange", route);

setInterval(() => {
  for (const [slug, s] of Object.entries(state.preprints)) if (s.running) loadPreprint(slug);
}, PREPRINT_POLL_MS);

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
