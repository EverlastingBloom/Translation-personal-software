"use strict";

const $ = (sel) => document.querySelector(sel);
const STATE_LABEL = { untranslated: "Untranslated", review: "Needs review", done: "Done" };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

let summary = null;      // project overview from the server
let glossary = [];       // [{source, target, note}]
let tagRe = null;        // RegExp for game tags, from the project config
let currentGroup = null;
let currentScene = null; // subgroup id
let scenes = [];
let cards = [];          // rendered line cards, in order

// ---------- server ----------
async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), isError ? 5000 : 1800);
}

// ---------- helpers ----------
function tagsOf(text) {
  return tagRe ? text.match(tagRe) || [] : [];
}

function sameTags(a, b) {
  const x = tagsOf(a), y = tagsOf(b);
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

function hasWords(text) {
  return /[A-Za-z]/.test(tagRe ? text.replace(tagRe, "") : text);
}

/** Source text with tags shown as chips. Built from DOM nodes, never innerHTML. */
function renderSource(el, text) {
  el.textContent = "";
  if (!tagRe) { el.textContent = text; return; }
  let last = 0;
  for (const m of text.matchAll(tagRe)) {
    el.append(text.slice(last, m.index));
    const s = document.createElement("span");
    s.className = "tag";
    s.textContent = m[0];
    el.append(s);
    last = m.index + m[0].length;
  }
  el.append(text.slice(last));
}

function glossaryHits(text) {
  const lower = text.toLowerCase();
  const hits = glossary.filter((g) => {
    const s = g.source.toLowerCase();
    const i = lower.indexOf(s);
    if (i < 0) return false;
    const before = lower[i - 1], after = lower[i + s.length];
    return !/[a-z]/.test(before || "") && !/[a-z]/.test(after || "");
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

// ---------- overview ----------
async function loadSummary() {
  summary = await api("/api/summary");
  document.title = summary.name + " · Translation Editor";
  $("#project-name").textContent = summary.name;
  tagRe = summary.tag_pattern ? new RegExp(summary.tag_pattern, "g") : null;
  const t = summary.groups.reduce((a, g) => ({
    total: a.total + g.total, done: a.done + g.done, review: a.review + g.review,
  }), { total: 0, done: 0, review: 0 });
  setBar($("#progress"), t.done, t.review, t.total);
  const pct = t.total ? Math.floor(100 * t.done / t.total) : 0;
  $("#progress-text").textContent =
    `${t.done.toLocaleString()} of ${t.total.toLocaleString()} lines done (${pct}%) · ${t.review.toLocaleString()} need review`;

  const sel = $("#group-select");
  const keep = sel.value || currentGroup;
  sel.textContent = "";
  for (const g of summary.groups) {
    const o = document.createElement("option");
    o.value = g.name;
    o.textContent = `${g.name}  (${Math.floor(100 * g.done / g.total)}%)`;
    sel.append(o);
  }
  if (keep) sel.value = keep;
  if (summary.apply_label) {
    $("#apply-btn").hidden = false;
    $("#apply-btn").textContent = summary.apply_label;
  }
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
  store.set("group", group);
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
    const b = document.createElement("button");
    b.className = "scene" + (s.id === currentScene ? " active" : "");
    b.dataset.id = s.id;
    const title = document.createElement("span");
    title.className = "scene-title";
    title.textContent = s.title || "(untitled)";
    const meta = document.createElement("span");
    meta.className = "scene-meta";
    const mini = document.createElement("span");
    mini.className = "mini";
    mini.innerHTML = '<span style="background:var(--done)"></span><span style="background:var(--review)"></span>';
    setBar(mini, s.done, s.review, s.total);
    const count = document.createElement("span");
    count.textContent = `${s.done}/${s.total}`;
    meta.append(mini, count);
    b.append(title, meta);
    b.addEventListener("click", () => openScene(s.id));
    list.append(b);
  }
}

// ---------- lines ----------
async function openScene(id) {
  if (!(await flushAll())) return;
  currentScene = id;
  store.set("scene", id);
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
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No lines here with this filter.";
    box.append(e);
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
  const el = document.createElement("article");
  const card = { line, el, saved: line.target, saving: false };

  const head = document.createElement("div");
  head.className = "card-head";
  const num = document.createElement("span");
  num.className = "rownum";
  num.textContent = "#" + line.row;
  const sp = document.createElement("span");
  sp.className = "speaker";
  sp.textContent = line.speaker || "—";
  head.append(num, sp);
  if (showWhere) {
    const w = document.createElement("span");
    w.className = "where";
    w.textContent = `${line.group} › ${line.subgroup}`;
    head.append(w);
  }
  const dirty = document.createElement("span");
  dirty.className = "dirty";
  const chip = document.createElement("span");
  head.append(dirty, chip);

  const src = document.createElement("div");
  src.className = "source";
  renderSource(src, line.source);

  const ref = document.createElement("div");
  ref.className = "reference";
  if (line.reference) {
    const b = document.createElement("b");
    b.textContent = (summary.labels.reference || "Reference") + ": ";
    ref.append(b, line.reference);
  }

  const ta = document.createElement("textarea");
  ta.className = "target";
  ta.rows = 1;
  ta.spellcheck = false;
  ta.placeholder = (summary.labels.target || "Translation") + "…";
  ta.value = line.target;

  const foot = document.createElement("div");
  foot.className = "card-foot";
  const tagInfo = document.createElement("span");
  const count = document.createElement("span");
  count.className = "count";
  const hints = document.createElement("span");
  for (const g of glossaryHits(line.source)) {
    const h = document.createElement("button");
    h.type = "button";
    h.className = "hint-chip";
    h.title = (g.note ? g.note + " · " : "") + "Click to insert";
    h.textContent = `${g.source} → ${g.target || "(keep)"}`;
    h.addEventListener("click", () => insertAtCursor(ta, g.target || g.source));
    hints.append(h);
  }
  const actions = document.createElement("span");
  actions.className = "foot-actions";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "small ghost";
  copyBtn.textContent = "Copy English";
  copyBtn.title = "Ctrl+Shift+C";
  copyBtn.addEventListener("click", () => { ta.value = line.source; ta.dispatchEvent(new Event("input")); ta.focus(); });
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "small primary";
  doneBtn.textContent = "Done ✓";
  doneBtn.title = "Save and mark done (Ctrl+Enter)";
  doneBtn.addEventListener("click", () => save(card, "reviewed").then((ok) => ok && focusNext(card)));
  actions.append(copyBtn, doneBtn);
  foot.append(tagInfo, count, hints, actions);

  el.append(head, src, ref, ta, foot);
  Object.assign(card, { ta, chip, dirty, tagInfo, count });
  refresh(card);

  ta.addEventListener("input", () => { autoGrow(ta); refresh(card); });
  ta.addEventListener("focus", () => {
    cards.forEach((c) => c.el.classList.remove("focused"));
    el.classList.add("focused");
  });
  ta.addEventListener("blur", () => { if (ta.value !== card.saved) save(card, "reviewed"); });
  ta.addEventListener("keydown", (e) => onKey(e, card));
  return card;
}

function refresh(card) {
  const { line, ta } = card;
  const text = ta.value;
  const state = !text.trim() ? "untranslated" : (text !== card.saved ? "done" : line.state);
  card.el.className = "card state-" + state + (card.el.classList.contains("focused") ? " focused" : "");
  card.chip.className = "chip " + line.state;
  card.chip.textContent = STATE_LABEL[line.state] + (line.status === "google" ? " (Google)" : "");
  card.dirty.textContent = text !== card.saved ? "● unsaved" : "";
  const need = tagsOf(line.source);
  if (!text.trim()) {
    card.tagInfo.textContent = need.length ? `Needs tags: ${need.join(" ")}` : "";
    card.tagInfo.className = "count";
  } else if (sameTags(line.source, text)) {
    card.tagInfo.textContent = need.length ? "✓ tags OK" : "";
    card.tagInfo.className = "ok";
  } else {
    card.tagInfo.textContent = `⚠ tags must be: ${need.join(" ") || "(none)"}`;
    card.tagInfo.className = "warn";
  }
  card.count.textContent = `${text.length}/${line.source.length} chars`;
}

async function save(card, status) {
  const text = card.ta.value;
  if (text.trim() && !sameTags(card.line.source, text)) {
    toast("Tags don't match the English – fix them first.", true);
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
  const tr = document.createElement("tr");
  for (const key of ["source", "target", "note"]) {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.value = entry[key] || "";
    input.dataset.key = key;
    td.append(input);
    tr.append(td);
  }
  const td = document.createElement("td");
  const del = document.createElement("button");
  del.className = "small ghost";
  del.textContent = "✕";
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

// ---------- apply ----------
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

// ---------- start ----------
async function init() {
  try {
    [glossary] = await Promise.all([api("/api/glossary"), loadSummary()]);
  } catch (err) {
    toast("Can't reach the editor server. Is translator.py still running?", true);
    return;
  }
  const savedGroup = store.get("group");
  const sel = $("#group-select");
  if (savedGroup && summary.groups.some((g) => g.name === savedGroup)) sel.value = savedGroup;
  await loadScenes(sel.value);
  const savedScene = store.get("scene");
  const scene = scenes.find((s) => s.id === savedScene) || scenes.find((s) => s.done < s.total) || scenes[0];
  if (scene) await openScene(scene.id);

  sel.addEventListener("change", async () => {
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
  $("#apply-btn").addEventListener("click", applyToGame);
  window.addEventListener("beforeunload", (e) => {
    if (cards.some((c) => c.ta.value !== c.saved)) e.preventDefault();
  });
}

init();
