"use strict";

const $ = (sel) => document.querySelector(sel);
const STATE_LABEL = { untranslated: "Untranslated", review: "Needs review", done: "Done" };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

let projectId = null;    // id of the open project ("projects/x.json" or "workspace/y/project.json")
let summary = null;      // project overview from the server
let glossary = [];       // [{source, target, note}]
let tagRe = null;        // RegExp for codes that must survive translation
let currentGroup = null;
let currentScene = null; // subgroup id
let scenes = [];
let cards = [];          // rendered line cards, in order
let draft = null;        // file being set up as a new project

// ---------- server ----------
async function api(path, body, raw = false) {
  const url = path + (projectId ? (path.includes("?") ? "&" : "?") + "p=" + encodeURIComponent(projectId) : "");
  const opts = body === undefined ? {} : raw
    ? { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), isError ? 6000 : 1800);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------- helpers ----------
function tagsOf(text) {
  return tagRe ? text.match(tagRe) || [] : [];
}

/** Same codes, any order (word order changes between languages). */
function sameTags(a, b) {
  const x = tagsOf(a).sort(), y = tagsOf(b).sort();
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

function missingTags(source, text) {
  const left = tagsOf(text);
  const missing = [];
  for (const t of tagsOf(source)) {
    const i = left.indexOf(t);
    if (i >= 0) left.splice(i, 1); else missing.push(t);
  }
  return { missing, extra: left };
}

function hasWords(text) {
  return /\p{L}/u.test(tagRe ? text.replace(tagRe, "") : text);
}

/** Source text with codes shown as chips. Built from DOM nodes, never innerHTML. */
function renderSource(node, text) {
  node.textContent = "";
  if (!tagRe) { node.textContent = text; return; }
  let last = 0;
  for (const m of text.matchAll(tagRe)) {
    if (!m[0]) continue;
    node.append(text.slice(last, m.index), el("span", "tag", m[0]));
    last = m.index + m[0].length;
  }
  node.append(text.slice(last));
}

function glossaryHits(text) {
  const lower = text.toLowerCase();
  const hits = glossary.filter((g) => {
    const s = g.source.toLowerCase();
    const i = lower.indexOf(s);
    if (i < 0) return false;
    const before = lower[i - 1], after = lower[i + s.length];
    return !/\p{L}/u.test(before || "") && !/\p{L}/u.test(after || "");
  });
  // "grimoire" is noise when "Grand Grimoire" already matched; keep a short term only if it
  // also appears outside every longer match.
  return hits.filter((g) => {
    const s = g.source.toLowerCase();
    const longer = hits.filter((h) => h !== g && h.source.toLowerCase().includes(s));
    if (!longer.length) return true;
    let rest = lower;
    for (const h of longer) rest = rest.split(h.source.toLowerCase()).join(" ");
    return rest.includes(s);
  });
}

function insertAtCursor(ta, text) {
  const { selectionStart: a, selectionEnd: b, value } = ta;
  ta.value = value.slice(0, a) + text + value.slice(b);
  ta.selectionStart = ta.selectionEnd = a + text.length;
  ta.dispatchEvent(new Event("input"));
  ta.focus();
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.max(44, ta.scrollHeight + 2) + "px";
}

function setBar(container, done, review, total) {
  const [d, r] = container.children;
  d.style.width = total ? (100 * done / total) + "%" : "0";
  r.style.width = total ? (100 * review / total) + "%" : "0";
}

function miniBar(done, review, total) {
  const mini = el("span", "mini");
  mini.append(el("span", "seg-done"), el("span", "seg-review"));
  setBar(mini, done, review, total);
  return mini;
}

function timeAgo(seconds) {
  const d = Date.now() / 1000 - seconds;
  if (d < 90) return "just now";
  if (d < 3600) return Math.round(d / 60) + " min ago";
  if (d < 86400) return Math.round(d / 3600) + " h ago";
  return Math.round(d / 86400) + " days ago";
}

// ---------- start screen ----------
async function showStart() {
  if (!(await flushAll())) return;
  projectId = null;
  history.replaceState(null, "", location.pathname);
  $("#editor").hidden = true;
  $("#start").hidden = false;
  document.title = "Translation Editor";
  const list = $("#project-list");
  list.textContent = "";
  list.append(el("p", "muted", "Loading…"));
  let projects;
  try {
    projects = await api("/api/projects");
  } catch (err) {
    list.textContent = "";
    list.append(el("p", "warn", "Can't reach the editor. Is translator.py still running?"));
    return;
  }
  list.textContent = "";
  if (!projects.length) {
    list.append(el("p", "muted", "No projects yet. Drop a file above to start one."));
    return;
  }
  for (const p of projects) {
    const card = el("button", "project-card" + (p.error ? " broken" : ""));
    card.type = "button";
    const top = el("span", "project-top");
    top.append(el("strong", "", p.name), el("span", "muted", p.file || ""));
    card.append(top);
    if (p.error) {
      card.append(el("span", "warn small", "Can't open: " + p.error));
      card.disabled = true;
    } else {
      const pct = p.total ? Math.floor(100 * p.done / p.total) : 0;
      const meta = el("span", "project-meta");
      meta.append(miniBar(p.done, p.review, p.total),
        el("span", "", `${pct}% · ${p.done.toLocaleString()}/${p.total.toLocaleString()}`));
      card.append(meta, el("span", "muted small",
        (p.review ? `${p.review.toLocaleString()} to review · ` : "") + "edited " + timeAgo(p.modified)));
      card.addEventListener("click", () => openProject(p.id));
    }
    list.append(card);
  }
}

// ---------- new project from a file ----------
async function handleFile(file) {
  if (!file) return;
  if (!(await flushAll())) return;
  toast(`Reading ${file.name}…`);
  const saved = projectId;
  projectId = null;
  try {
    draft = await api("/api/import?name=" + encodeURIComponent(file.name), file, true);
  } catch (err) {
    toast(err.message, true);
    return;
  } finally {
    projectId = saved;
  }
  showSetup();
}

function fillSelect(sel, fields, chosen, { none = "(none)", newCol = null } = {}) {
  sel.textContent = "";
  if (newCol) {
    const o = el("option", "", `New column (${newCol})`);
    o.value = "__new__";
    sel.append(o);
  }
  if (none) {
    const o = el("option", "", none);
    o.value = "";
    sel.append(o);
  }
  for (const f of fields) {
    const o = el("option", "", f);
    o.value = f;
    sel.append(o);
  }
  sel.value = chosen || (newCol ? "__new__" : "");
}

function showSetup() {
  const d = draft;
  const fmt = { csv: "table", "json-tree": "JSON (keys and texts)", "json-records": "JSON (list of objects)" }[d.format];
  $("#setup-info").textContent = `${d.filename} · ${fmt} · ${d.lines.toLocaleString()} lines found. ` +
    "Check which column is which – the guesses are filled in.";
  $("#setup-name").value = d.filename.replace(/\.[^.]+$/, "");
  $("#setup-label").value = store.get("lastLabel") || "";
  const g = d.guess, f = d.fields;
  fillSelect($("#map-source"), f, g.source, { none: null });
  fillSelect($("#map-target"), f, g.target, { none: null, newCol: "named after the language" });
  fillSelect($("#map-speaker"), f, g.speaker);
  fillSelect($("#map-key"), f, g.key);
  fillSelect($("#map-group"), f, g.group);
  fillSelect($("#map-subgroup"), f, g.subgroup);
  fillSelect($("#map-reference"), f, g.reference);
  const preset = $("#tag-preset");
  preset.textContent = "";
  for (const p of d.tag_presets) {
    const o = el("option", "", p.label);
    o.value = p.id;
    preset.append(o);
  }
  preset.append(Object.assign(el("option", "", "Custom…"), { value: "custom" }));
  preset.value = d.tag_guess;
  $("#tag-custom-wrap").hidden = true;
  $("#setup-error").textContent = "";
  renderPreview();
  $("#setup-dialog").showModal();
}

function renderPreview() {
  const t = $("#preview");
  t.textContent = "";
  const src = $("#map-source").value;
  const tgt = $("#map-target").value;
  const head = el("tr");
  for (const f of draft.fields) {
    const th = el("th", f === src ? "is-source" : f === tgt ? "is-target" : "", f);
    head.append(th);
  }
  t.append(head);
  for (const row of draft.preview) {
    const tr = el("tr");
    for (const f of draft.fields) {
      const v = row[f] || "";
      tr.append(el("td", f === src ? "is-source" : f === tgt ? "is-target" : "", v.length > 140 ? v.slice(0, 140) + "…" : v));
    }
    t.append(tr);
  }
}

async function createProject() {
  const tgtSel = $("#map-target").value;
  const presetId = $("#tag-preset").value;
  const pattern = presetId === "custom" ? $("#tag-custom").value
    : draft.tag_presets.find((p) => p.id === presetId).pattern;
  try { new RegExp(pattern, "gu"); } catch {
    $("#setup-error").textContent = "That custom pattern isn't a valid regular expression.";
    return;
  }
  const label = $("#setup-label").value.trim();
  store.set("lastLabel", label);
  const body = {
    draft: draft.draft,
    name: $("#setup-name").value,
    target_label: label,
    tag_pattern: pattern,
    columns: {
      source: $("#map-source").value,
      target: tgtSel === "__new__" ? (label ? label.toLowerCase() : "translation") : tgtSel,
      speaker: $("#map-speaker").value,
      key: $("#map-key").value,
      group: $("#map-group").value,
      subgroup: $("#map-subgroup").value,
      reference: $("#map-reference").value,
    },
  };
  if (body.columns.target !== "translation" && draft.fields.includes(body.columns.target) && tgtSel === "__new__") {
    body.columns.target = "translation";
  }
  try {
    const saved = projectId;
    projectId = null;
    const res = await api("/api/create", body).finally(() => (projectId = saved));
    draft = null;
    $("#setup-dialog").close();
    await openProject(res.id);
  } catch (err) {
    $("#setup-error").textContent = err.message;
  }
}

async function cancelSetup() {
  $("#setup-dialog").close();
  if (!draft) return;
  const saved = projectId;
  projectId = null;
  await api("/api/discard", { draft: draft.draft }).catch(() => {});
  projectId = saved;
  draft = null;
}

// ---------- overview ----------
async function openProject(id) {
  if (projectId && !(await flushAll())) return;
  projectId = id;
  history.replaceState(null, "", "#p=" + encodeURIComponent(id));
  store.set("lastProject", id);
  currentGroup = currentScene = null;
  cards = [];
  $("#lines").textContent = "";
  $("#search").value = "";
  try {
    [glossary] = await Promise.all([api("/api/glossary"), loadSummary()]);
  } catch (err) {
    toast(err.message, true);
    projectId = null;
    showStart();
    return;
  }
  $("#start").hidden = true;
  $("#editor").hidden = false;
  const sel = $("#group-select");
  const savedGroup = store.get(id + "|group");
  if (savedGroup && summary.groups.some((g) => g.name === savedGroup)) sel.value = savedGroup;
  await loadScenes(sel.value);
  const savedScene = store.get(id + "|scene");
  const scene = scenes.find((s) => s.id === savedScene) || scenes.find((s) => s.done < s.total) || scenes[0];
  if (scene) await openScene(scene.id);
}

async function loadSummary() {
  summary = await api("/api/summary");
  document.title = summary.name + " · Translation Editor";
  $("#project-name").textContent = summary.name;
  try {
    tagRe = summary.tag_pattern ? new RegExp(summary.tag_pattern, "gu") : null;
  } catch {
    tagRe = summary.tag_pattern ? new RegExp(summary.tag_pattern, "g") : null;
  }
  const t = summary.groups.reduce((a, g) => ({
    total: a.total + g.total, done: a.done + g.done, review: a.review + g.review,
  }), { total: 0, done: 0, review: 0 });
  setBar($("#progress"), t.done, t.review, t.total);
  const pct = t.total ? Math.floor(100 * t.done / t.total) : 0;
  $("#progress-text").textContent =
    `${t.done.toLocaleString()} of ${t.total.toLocaleString()} lines done (${pct}%) · ${t.review.toLocaleString()} need review`;

  const sel = $("#group-select");
  const keep = currentGroup;
  sel.textContent = "";
  for (const g of summary.groups) {
    const o = el("option", "", `${g.name}  (${Math.floor(100 * g.done / g.total)}%)`);
    o.value = g.name;
    sel.append(o);
  }
  if (keep) sel.value = keep;
  $("#apply-btn").hidden = !summary.apply_label;
  if (summary.apply_label) $("#apply-btn").textContent = summary.apply_label;
  showGroupStats();
}

function showGroupStats() {
  const g = summary.groups.find((x) => x.name === $("#group-select").value);
  if (!g) return;
  $("#group-stats").textContent =
    `${g.done} done · ${g.review} to review · ${g.untranslated} untranslated · ${g.total} total`;
}

async function loadScenes(group) {
  currentGroup = group;
  store.set(projectId + "|group", group);
  scenes = await api("/api/subgroups?group=" + encodeURIComponent(group));
  renderScenes();
  showGroupStats();
}

function renderScenes() {
  const list = $("#scene-list");
  const filter = $("#scene-filter").value.trim().toLowerCase();
  list.textContent = "";
  for (const s of scenes) {
    if (filter && !s.title.toLowerCase().includes(filter)) continue;
    const b = el("button", "scene" + (s.id === currentScene ? " active" : ""));
    b.dataset.id = s.id;
    const meta = el("span", "scene-meta");
    meta.append(miniBar(s.done, s.review, s.total), el("span", "", `${s.done}/${s.total}`));
    b.append(el("span", "scene-title", s.title || "(untitled)"), meta);
    b.addEventListener("click", () => openScene(s.id));
    list.append(b);
  }
}

// ---------- lines ----------
async function openScene(id) {
  if (!(await flushAll())) return;
  currentScene = id;
  store.set(projectId + "|scene", id);
  $("#search").value = "";
  document.querySelectorAll(".scene").forEach((b) => b.classList.toggle("active", b.dataset.id === id));
  const s = scenes.find((x) => x.id === id);
  $("#crumb").textContent = currentGroup;
  $("#scene-title").textContent = s ? s.title || "(untitled)" : "";
  const state = $("#state-filter").value;
  const lines = await api(`/api/lines?group=${encodeURIComponent(currentGroup)}&subgroup=${encodeURIComponent(id)}&state=${state}&limit=5000`);
  renderLines(lines, false);
}

async function runSearch() {
  const q = $("#search").value.trim();
  if (!q) { if (currentScene) openScene(currentScene); return; }
  if (!(await flushAll())) return;
  const state = $("#state-filter").value;
  const lines = await api(`/api/lines?search=${encodeURIComponent(q)}&state=${state}&limit=300`);
  $("#crumb").textContent = "Search";
  $("#scene-title").textContent = `“${q}” – ${lines.length}${lines.length === 300 ? "+" : ""} lines`;
  renderLines(lines, true);
}

function renderLines(lines, showWhere) {
  const box = $("#lines");
  box.textContent = "";
  cards = [];
  if (!lines.length) {
    box.append(el("div", "empty", "No lines here with this filter."));
    return;
  }
  for (const line of lines) {
    const card = buildCard(line, showWhere);
    cards.push(card);
    box.append(card.el);
  }
  requestAnimationFrame(() => cards.forEach((c) => autoGrow(c.ta)));
  $(".content").scrollTop = 0;
}

function buildCard(line, showWhere) {
  const root = el("article");
  const card = { line, el: root, saved: line.target, saving: false };

  const head = el("div", "card-head");
  head.append(el("span", "rownum", "#" + (line.row + 1)));
  if (line.speaker) head.append(el("span", "speaker", line.speaker));
  if (line.key) head.append(el("code", "key", line.key));
  if (showWhere) head.append(el("span", "where", `${line.group} › ${line.subgroup}`));
  const dirty = el("span", "dirty");
  const chip = el("span");
  head.append(dirty, chip);

  const src = el("div", "source");
  renderSource(src, line.source);

  const ref = el("div", "reference");
  if (line.reference) ref.append(el("b", "", (summary.labels.reference || "Reference") + ": "), line.reference);

  const ta = el("textarea", "target");
  ta.rows = 1;
  ta.spellcheck = false;
  ta.placeholder = (summary.labels.target || "Translation") + "…";
  ta.value = line.target;

  const foot = el("div", "card-foot");
  const tagInfo = el("span");
  const count = el("span", "count");
  const hints = el("span", "hints");
  for (const g of glossaryHits(line.source)) {
    const h = el("button", "hint-chip", `${g.source} → ${g.target || "(keep)"}`);
    h.type = "button";
    h.title = (g.note ? g.note + " · " : "") + "Click to insert";
    h.addEventListener("click", () => insertAtCursor(ta, g.target || g.source));
    hints.append(h);
  }
  const actions = el("span", "foot-actions");
  const copyBtn = el("button", "small ghost", "Copy original");
  copyBtn.type = "button";
  copyBtn.title = "Ctrl+Shift+C";
  copyBtn.addEventListener("click", () => { ta.value = line.source; ta.dispatchEvent(new Event("input")); ta.focus(); });
  const doneBtn = el("button", "small primary", "Done ✓");
  doneBtn.type = "button";
  doneBtn.title = "Save and mark done (Ctrl+Enter)";
  doneBtn.addEventListener("click", () => save(card, "reviewed").then((ok) => ok && focusNext(card)));
  actions.append(copyBtn, doneBtn);
  foot.append(tagInfo, count, hints, actions);

  root.append(head, src, ref, ta, foot);
  Object.assign(card, { ta, chip, dirty, tagInfo, count });
  refresh(card);

  ta.addEventListener("input", () => { autoGrow(ta); refresh(card); });
  ta.addEventListener("focus", () => {
    cards.forEach((c) => c.el.classList.remove("focused"));
    root.classList.add("focused");
  });
  ta.addEventListener("blur", () => { if (ta.value !== card.saved) save(card, "reviewed"); });
  ta.addEventListener("keydown", (e) => onKey(e, card));
  return card;
}

function refresh(card) {
  const { line, ta } = card;
  const text = ta.value;
  const state = text !== card.saved ? "dirty" : line.state;
  card.el.className = "card state-" + state + (card.el.classList.contains("focused") ? " focused" : "");
  card.chip.className = "chip " + line.state;
  card.chip.textContent = STATE_LABEL[line.state] +
    (line.status === "google" || line.status === "machine" ? " (machine)" : "");
  card.dirty.textContent = text !== card.saved ? "● unsaved" : "";
  const need = tagsOf(line.source);
  if (!text.trim()) {
    card.tagInfo.textContent = need.length ? `Keep: ${need.join(" ")}` : "";
    card.tagInfo.className = "count";
  } else {
    const { missing, extra } = missingTags(line.source, text);
    if (!missing.length && !extra.length) {
      card.tagInfo.textContent = need.length ? "✓ codes OK" : "";
      card.tagInfo.className = "ok";
    } else {
      card.tagInfo.textContent = "⚠ " + [missing.length ? "missing " + missing.join(" ") : "",
        extra.length ? "extra " + extra.join(" ") : ""].filter(Boolean).join(" · ");
      card.tagInfo.className = "warn";
    }
  }
  card.count.textContent = `${text.length}/${line.source.length} chars`;
}

async function save(card, status) {
  const text = card.ta.value;
  if (text.trim() && !sameTags(card.line.source, text)) {
    toast("The codes don't match the original – fix them first.", true);
    return false;
  }
  if (!text.trim() && hasWords(card.line.source)) status = "";
  if (card.saving) return false;
  card.saving = true;
  try {
    card.line = await api("/api/line", { row: card.line.row, target: text, status });
    card.saved = text;
    refresh(card);
    updateCounts();
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  } finally {
    card.saving = false;
  }
}

/** Save every card with unsaved changes. Returns false if one could not be saved. */
async function flushAll() {
  for (const c of cards) {
    if (c.ta.value !== c.saved && !(await save(c, "reviewed"))) {
      c.ta.focus();
      return false;
    }
  }
  return true;
}

let countsTimer = null;
function updateCounts() {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(async () => {
    if (!projectId) return;
    await loadSummary();
    if (currentGroup) {
      scenes = await api("/api/subgroups?group=" + encodeURIComponent(currentGroup));
      renderScenes();
    }
  }, 600);
}

function focusNext(card, step = 1) {
  const i = cards.indexOf(card) + step;
  if (i >= 0 && i < cards.length) {
    cards[i].ta.focus();
    cards[i].el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function onKey(e, card) {
  if (e.key === "Enter" && e.ctrlKey) {
    e.preventDefault();
    save(card, "reviewed").then((ok) => ok && focusNext(card));
  } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    focusNext(card, e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "s" && e.ctrlKey) {
    e.preventDefault();
    save(card, "reviewed");
  } else if (e.key === "C" && e.ctrlKey && e.shiftKey) {
    e.preventDefault();
    card.ta.value = card.line.source;
    card.ta.dispatchEvent(new Event("input"));
  } else if (e.key === "Escape") {
    card.ta.value = card.saved;
    card.ta.dispatchEvent(new Event("input"));
  }
}

async function nextUnfinished() {
  const start = cards.findIndex((c) => c.el.classList.contains("focused")) + 1;
  const isOpen = (c) => c.line.state !== "done" || !c.ta.value.trim();
  const found = cards.slice(start).find(isOpen) || cards.slice(0, start).find(isOpen);
  if (found) {
    found.ta.focus();
    found.el.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  const idx = scenes.findIndex((s) => s.id === currentScene);
  const next = scenes.slice(idx + 1).find((s) => s.done < s.total) || scenes.find((s) => s.done < s.total);
  if (!next) { toast("Everything in this section is done!"); return; }
  await openScene(next.id);
  const first = cards.find(isOpen);
  if (first) first.ta.focus();
}

// ---------- glossary ----------
function glossaryRow(entry = { source: "", target: "", note: "" }) {
  const tr = el("tr");
  for (const key of ["source", "target", "note"]) {
    const td = el("td");
    const input = el("input");
    input.value = entry[key] || "";
    input.dataset.key = key;
    td.append(input);
    tr.append(td);
  }
  const td = el("td");
  const del = el("button", "small ghost", "✕");
  del.title = "Remove";
  del.addEventListener("click", () => tr.remove());
  td.append(del);
  tr.append(td);
  return tr;
}

function openGlossary() {
  const body = $("#glossary-body");
  body.textContent = "";
  glossary.forEach((g) => body.append(glossaryRow(g)));
  if (!glossary.length) body.append(glossaryRow());
  $("#glossary-dialog").showModal();
}

async function saveGlossary() {
  const entries = [...$("#glossary-body").children].map((tr) => {
    const e = {};
    tr.querySelectorAll("input").forEach((i) => (e[i.dataset.key] = i.value));
    return e;
  });
  try {
    glossary = await api("/api/glossary", entries);
    toast("Glossary saved");
    $("#glossary-dialog").close();
    if ($("#search").value.trim()) runSearch(); else if (currentScene) openScene(currentScene);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- export / apply ----------
function updateExportLink() {
  const fallback = document.querySelector("input[name=fallback]:checked").value;
  $("#export-link").href = `/api/export?p=${encodeURIComponent(projectId)}&fallback=${fallback}`;
}

async function openExport() {
  if (!(await flushAll())) return;
  $("#export-info").textContent = `Download ${summary.file} with your translations, in its original format.`;
  updateExportLink();
  $("#export-dialog").showModal();
}

async function applyToGame() {
  if (!(await flushAll())) return;
  const btn = $("#apply-btn");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Working…";
  $("#apply-title").textContent = summary.apply_label;
  $("#apply-output").textContent = "Running… this can take half a minute.";
  $("#apply-dialog").showModal();
  try {
    const res = await api("/api/apply", {});
    $("#apply-output").textContent = (res.ok ? "✓ Finished\n\n" : "✕ Failed\n\n") + res.output;
  } catch (err) {
    $("#apply-output").textContent = "✕ " + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- drag and drop ----------
function setupDrop() {
  const overlay = $("#drop-overlay");
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    handleFile(e.dataTransfer.files[0]);
  });
  $("#file-input").addEventListener("change", (e) => { handleFile(e.target.files[0]); e.target.value = ""; });
  $("#dropzone").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#file-input").click(); }
  });
}

// ---------- start ----------
function init() {
  setupDrop();
  $("#home-btn").addEventListener("click", showStart);
  $("#group-select").addEventListener("change", async () => {
    const sel = $("#group-select");
    if (!(await flushAll())) { sel.value = currentGroup; return; }
    await loadScenes(sel.value);
    const first = scenes.find((s) => s.done < s.total) || scenes[0];
    if (first) openScene(first.id);
  });
  $("#scene-filter").addEventListener("input", renderScenes);
  let searchTimer;
  $("#search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); });
  $("#state-filter").addEventListener("change", () => ($("#search").value.trim() ? runSearch() : currentScene && openScene(currentScene)));
  $("#next-btn").addEventListener("click", nextUnfinished);
  $("#glossary-btn").addEventListener("click", openGlossary);
  $("#glossary-add").addEventListener("click", () => {
    const row = glossaryRow();
    $("#glossary-body").append(row);
    row.querySelector("input").focus();
  });
  $("#glossary-save").addEventListener("click", saveGlossary);
  $("#help-btn").addEventListener("click", () => $("#help-dialog").showModal());
  $("#export-btn").addEventListener("click", openExport);
  document.querySelectorAll("input[name=fallback]").forEach((r) => r.addEventListener("change", updateExportLink));
  $("#apply-btn").addEventListener("click", applyToGame);
  $("#setup-create").addEventListener("click", createProject);
  $("#setup-cancel").addEventListener("click", cancelSetup);
  $("#setup-dialog").addEventListener("cancel", (e) => { e.preventDefault(); cancelSetup(); });
  for (const id of ["#map-source", "#map-target"]) $(id).addEventListener("change", renderPreview);
  $("#tag-preset").addEventListener("change", () => { $("#tag-custom-wrap").hidden = $("#tag-preset").value !== "custom"; });
  window.addEventListener("beforeunload", (e) => {
    if (cards.some((c) => c.ta.value !== c.saved)) e.preventDefault();
  });

  const fromHash = () => new URLSearchParams(location.hash.slice(1)).get("p");
  window.addEventListener("hashchange", () => {
    const id = fromHash();
    if (id && id !== projectId) openProject(id);
  });
  if (fromHash()) openProject(fromHash()); else showStart();
}

init();
