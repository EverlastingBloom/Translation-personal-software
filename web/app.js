"use strict";

const $ = (sel) => document.querySelector(sel);
const STATE_LABEL = { untranslated: "Untranslated", review: "Needs review", done: "Done" };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
const CHUNK = 40;          // cards rendered at a time; more appear as you scroll
const AUTOSAVE_MS = 1500;  // save a line this long after you stop typing
const FIELD_SIZING = !!window.CSS?.supports?.("field-sizing", "content"); // textareas grow by themselves

let projectId = null;    // id of the open project ("projects/x.json" or "workspace/y/project.json")
let summary = null;      // project overview from the server
let glossary = [];       // [{source, target, note}]
let tagRe = null;        // RegExp for codes that must survive translation
let currentGroup = null;
let currentScene = null; // subgroup id
let scenes = [];
let sceneButtons = new Map(); // scene id -> its button in the sidebar
let view = { lines: [], showWhere: false }; // every line in the main column; cards exist for the first ones
let cards = [];          // rendered line cards, same order as view.lines
const cardByRow = new Map();
let draft = null;        // file being set up as a new project
let me = store.get("userName") || "";
const session = Math.random().toString(36).slice(2, 10);
let version = 0;         // last change the server told us about
let people = [];         // others working on this project right now
let pollTimer = null;
let polling = false;
let focusedRow = null;

// ---------- server ----------
async function api(path, body, { raw = false, noProject = false } = {}) {
  const pid = noProject ? null : projectId;
  const url = path + (pid ? (path.includes("?") ? "&" : "?") + "p=" + encodeURIComponent(pid) : "");
  const headers = { "X-User": encodeURIComponent(me) };
  const opts = body === undefined ? { headers } : raw
    ? { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body }
    : { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    setOffline(true);
    throw Object.assign(new Error("Can't reach the editor. Is translator.py still running?"), { offline: true });
  }
  setOffline(false);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Server error ${res.status}`), { status: res.status, data });
  return data;
}

function setOffline(off) {
  $("#offline").hidden = !off;
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), isError ? 9000 : 2600);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(cls, text, onClick, title) {
  const b = el("button", cls, text);
  b.type = "button";
  if (title) b.title = title;
  if (onClick) b.addEventListener("click", onClick);
  return b;
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
  if (FIELD_SIZING) return;
  ta.style.height = "auto";
  ta.style.height = Math.max(44, ta.scrollHeight + 2) + "px";
}

/** Size many textareas with one layout pass instead of one per card. */
function growAll(list) {
  if (FIELD_SIZING || !list.length) return;
  list.forEach((c) => (c.ta.style.height = "auto"));
  const heights = list.map((c) => c.ta.scrollHeight);
  list.forEach((c, i) => (c.ta.style.height = Math.max(44, heights[i] + 2) + "px"));
}

function setBar(container, done, review, total) {
  const [d, r] = container.children;
  d.style.width = total ? (100 * done / total) + "%" : "0";
  r.style.width = total ? (100 * review / total) + "%" : "0";
}

/**
 * Where a project / section / scene stands. "Done" and "translated" are not the same: a line
 * flagged "needs review" is translated but not done, so a section is only complete when
 * nothing is left to translate AND nothing is left to review.
 *   complete  every line done
 *   review    everything translated, some lines still need review
 *   open      lines still untranslated
 */
function progress(c) {
  const review = c.review || 0;
  const left = Math.max(0, c.total - c.done - review);
  const pct = c.total ? Math.floor(100 * c.done / c.total) : 0; // floor: never "100%" while one line is open
  const state = left ? "open" : review ? "review" : "complete";
  const n = (x) => x.toLocaleString();
  return {
    state, review, left, pct,
    // sidebar scenes and the section list: short
    short: state === "complete" ? "✓ Complete" : state === "review" ? `⚑ ${n(review)} to review`
      : `${n(c.done)}/${n(c.total)}` + (review ? ` · ⚑ ${n(review)}` : ""),
    // project list and section stats: a bit more
    text: state === "complete" ? `✓ Complete · ${n(c.total)} lines`
      : state === "review" ? `All translated · ⚑ ${n(review)} still to review`
      : `${pct}% done · ${n(left)} untranslated` + (review ? ` · ⚑ ${n(review)} to review` : ""),
  };
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

function initials(name) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join("") || "?";
}

/** A stable colour per person, so teammates are easy to tell apart. */
function personColor(name) {
  let h = 0;
  for (const ch of name || "") h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}

function avatar(name, cls = "avatar") {
  const a = el("span", cls, initials(name));
  a.style.background = personColor(name);
  a.title = name;
  return a;
}

// ---------- your name ----------
function askName() {
  const d = $("#name-dialog");
  $("#name-input").value = me;
  d.showModal();
  $("#name-input").focus();
  return new Promise((resolve) => d.addEventListener("close", resolve, { once: true }));
}

function saveName() {
  const name = $("#name-input").value.trim().slice(0, 40);
  if (!name) { $("#name-input").focus(); return; }
  me = name;
  store.set("userName", name);
  showMe();
  $("#name-dialog").close();
}

function showMe() {
  const b = $("#me-btn");
  b.textContent = "";
  if (me) b.append(avatar(me), el("span", "me-name", me)); else b.textContent = "Set your name";
}

// ---------- start screen ----------
async function showStart() {
  if (!(await flushAll())) return;
  stopPolling();
  projectId = null;
  history.replaceState(null, "", location.pathname);
  $("#editor").hidden = true;
  $("#start").hidden = false;
  document.title = "Translation Editor";
  const list = $("#project-list");
  list.textContent = "";
  list.append(el("p", "muted", "Loading…"));
  let res;
  try {
    res = await api("/api/projects", undefined, { noProject: true });
  } catch (err) {
    list.textContent = "";
    list.append(el("p", "warn", err.message));
    return;
  }
  $("#open-btn").hidden = !res.owner;
  $("#open-btn").dataset.pick = res.can_pick ? "1" : "";
  const projects = res.projects;
  list.textContent = "";
  if (!projects.length) {
    list.append(el("p", "muted", "No projects yet. Open or drop a file above to start one."));
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
      const pr = progress(p);
      const meta = el("span", "project-meta");
      meta.append(miniBar(p.done, p.review, p.total), el("span", "progress-label " + pr.state, pr.text));
      const foot = el("span", "project-foot muted small");
      foot.append("edited " + timeAgo(p.modified));
      if (p.shared) foot.append(el("span", "shared-tag", p.behind ? `⇅ team · ${p.behind} update${p.behind === 1 ? "" : "s"} waiting` : "⇅ team"));
      if (p.online?.length) {
        const here = el("span", "online");
        p.online.forEach((n) => here.append(avatar(n, "avatar sm")));
        here.append(` ${p.online.join(", ")} working now`);
        foot.append(here);
      }
      card.append(meta, foot);
      if (p.old_copy && res.owner) {
        const old = el("span", "old-copy small");
        const sw = el("span", "link-btn", `Use ${p.old_copy} itself`);
        sw.setAttribute("role", "button");
        sw.tabIndex = 0;
        const go = (e) => { e.stopPropagation(); e.preventDefault(); convertProject(p); };
        sw.addEventListener("click", go);
        sw.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") go(e); });
        old.append("⚠ Old copy – it doesn't see changes from a Pull. ", sw);
        card.append(old);
      }
      card.addEventListener("click", () => openProject(p.id));
    }
    list.append(card);
  }
}

/** An older project (its own copy, written into a file): edit that file directly from now on. */
async function convertProject(p) {
  if (!confirm(`Switch “${p.name}” to work on ${p.old_copy} itself?\n\n` +
    `The file's text is kept (with your teammates' pulled lines). Lines, review flags and notes that only ` +
    `this copy has are added to it. The copy is moved to workspace/.old.`)) return;
  try {
    const r = await api("/api/convert", { id: p.id }, { noProject: true });
    const bits = [];
    if (r.lines) bits.push(`${r.lines} unsaved line${r.lines === 1 ? "" : "s"} added`);
    if (r.flags) bits.push(`${r.flags} review flag${r.flags === 1 ? "" : "s"}`);
    if (r.notes) bits.push(`${r.notes} note${r.notes === 1 ? "" : "s"}`);
    if (r.theirs) bits.push(`${r.theirs} line${r.theirs === 1 ? "" : "s"} changed in the file kept as they are`);
    toast(`Now working on ${r.file}` + (bits.length ? ` · ${bits.join(" · ")}` : ""));
    await openProject(r.id);
  } catch (err) {
    toast(err.message, true);
    showStart();
  }
}

// ---------- new project from a file ----------
async function handleFile(file) {
  if (!file) return;
  if (!(await flushAll())) return;
  toast(`Reading ${file.name}…`);
  try {
    draft = await api("/api/import?name=" + encodeURIComponent(file.name), file, { raw: true, noProject: true });
  } catch (err) {
    toast(err.message, true);
    return;
  }
  showSetup();
}

/** Open a file by its place on disk, so Save can write next to it (or into it) later. */
async function openFromDisk() {
  if (!(await flushAll())) return;
  let body = {};
  if ($("#open-btn").dataset.pick) {
    toast("Pick the file in the window that opened (it may be behind the browser)…");
  } else {
    const path = prompt("Full path of the file to translate, e.g. C:\\Games\\MyGame\\dialogue.csv");
    if (!path) return;
    body = { path };
  }
  try {
    const res = await api("/api/open", body, { noProject: true });
    if (res.cancelled) return;
    if (res.project) { await openProject(res.project); return; } // a teammate's shared project
    draft = res;
  } catch (err) {
    toast(err.message, true);
    return;
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
  $("#setup-save").hidden = !d.origin;
  $("#setup-save-dropped").hidden = !!d.origin;
  if (d.origin) {
    $("#save-original-name").textContent = d.origin;
    $("#save-original-warn").hidden = d.format === "csv";
    $("#save-inplace").hidden = d.format !== "csv";
    $("#save-json-hint").hidden = d.format === "csv";
    $("#save-inplace-name").textContent = d.filename.replace(/\.[^.]+$/, "") + ".translation.json";
  }
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
  let target = tgtSel;
  if (tgtSel === "__new__") {
    // a new column named after the language, unless the file already has one with that name
    const wanted = label ? label.toLowerCase() : "translation";
    target = [wanted, "translation", "translation_new"].find((n) => !draft.fields.includes(n)) || wanted + "_new";
  }
  const body = {
    draft: draft.draft,
    name: $("#setup-name").value,
    target_label: label,
    tag_pattern: pattern,
    columns: {
      source: $("#map-source").value,
      target,
      speaker: $("#map-speaker").value,
      key: $("#map-key").value,
      group: $("#map-group").value,
      subgroup: $("#map-subgroup").value,
      reference: $("#map-reference").value,
    },
    save_to: draft.origin ? { choice: "original", auto: true } : null,
  };
  const btn = $("#setup-create");
  btn.disabled = true;
  try {
    const res = await api("/api/create", body, { noProject: true });
    draft = null;
    $("#setup-dialog").close();
    await openProject(res.id);
  } catch (err) {
    $("#setup-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function cancelSetup() {
  $("#setup-dialog").close();
  if (!draft) return;
  await api("/api/discard", { draft: draft.draft }, { noProject: true }).catch(() => {});
  draft = null;
}

// ---------- overview ----------
async function openProject(id) {
  if (projectId && !(await flushAll())) return;
  stopPolling();
  projectId = id;
  history.replaceState(null, "", "#p=" + encodeURIComponent(id));
  store.set("lastProject", id);
  currentGroup = currentScene = null;
  clearLines();
  $("#search").value = "";
  try {
    [glossary] = await Promise.all([api("/api/glossary"), loadSummary()]);
  } catch (err) {
    toast(err.message, true);
    projectId = null;
    showStart();
    return;
  }
  version = summary.version;
  $("#start").hidden = true;
  $("#editor").hidden = false;
  if (!me) await askName();
  const sel = $("#group-select");
  const savedGroup = store.get(id + "|group");
  if (savedGroup && summary.groups.some((g) => g.name === savedGroup)) sel.value = savedGroup;
  await loadScenes(sel.value);
  const savedScene = store.get(id + "|scene");
  const scene = scenes.find((s) => s.id === savedScene) || scenes.find((s) => s.done < s.total) || scenes[0];
  if (scene) await openScene(scene.id);
  startPolling();
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
  const pr = progress(t);
  const pt = $("#progress-text");
  pt.className = "progress-text " + pr.state;
  pt.textContent = pr.state === "complete" ? `✓ Complete – all ${t.total.toLocaleString()} lines done`
    : pr.state === "review" ? `All ${t.total.toLocaleString()} lines translated · ⚑ ${pr.review.toLocaleString()} still need review`
    : `${t.done.toLocaleString()} of ${t.total.toLocaleString()} lines done (${pr.pct}%) · ` +
      `${pr.left.toLocaleString()} untranslated` + (pr.review ? ` · ⚑ ${pr.review.toLocaleString()} to review` : "");

  const sel = $("#group-select");
  const keep = currentGroup;
  sel.textContent = "";
  for (const g of summary.groups) {
    const gp = progress(g);
    const o = el("option", "", `${g.name} — ${gp.state === "open" ? gp.pct + "%" + (gp.review ? " · ⚑ " + gp.review : "") : gp.short}`);
    o.value = g.name;
    sel.append(o);
  }
  if (keep) sel.value = keep;
  $("#apply-btn").hidden = !summary.apply_label;
  if (summary.apply_label) $("#apply-btn").textContent = summary.apply_label;
  renderSaveState(summary.save);
  renderGit(summary.git);
  showGroupStats();
}

function showGroupStats() {
  const g = summary.groups.find((x) => x.name === $("#group-select").value);
  if (!g) return;
  const pr = progress(g);
  const box = $("#group-stats");
  box.textContent = "";
  box.append(el("div", "progress-label " + pr.state, pr.text),
    el("div", "", `${g.done} done · ${g.review} to review · ${g.untranslated} untranslated · ${g.total} total`));
}

async function loadScenes(group) {
  currentGroup = group;
  store.set(projectId + "|group", group);
  scenes = await api("/api/subgroups?group=" + encodeURIComponent(group));
  renderScenes();
  showGroupStats();
}

function sceneMeta(s) {
  const pr = progress(s);
  const meta = el("span", "scene-meta");
  meta.append(miniBar(s.done, s.review, s.total), el("span", "progress-label " + pr.state, pr.short));
  return meta;
}

function renderScenes() {
  const list = $("#scene-list");
  const filter = $("#scene-filter").value.trim().toLowerCase();
  list.textContent = "";
  sceneButtons = new Map();
  const frag = document.createDocumentFragment();
  for (const s of scenes) {
    if (filter && !s.title.toLowerCase().includes(filter)) continue;
    const b = el("button", `scene is-${progress(s).state}` + (s.id === currentScene ? " active" : ""));
    b.type = "button";
    b.dataset.id = s.id;
    const here = el("span", "scene-people");
    b.append(el("span", "scene-title", s.title || "(untitled)"), here);
    if (s.claimed) {
      const tag = el("span", "claim-tag", s.claimed.name === me ? "you" : s.claimed.name);
      tag.style.borderColor = tag.style.color = personColor(s.claimed.name);
      tag.title = `${s.claimed.name} is translating this scene`;
      b.append(tag);
    }
    b.append(sceneMeta(s));
    b.addEventListener("click", () => openScene(s.id));
    sceneButtons.set(s.id, b);
    frag.append(b);
  }
  list.append(frag);
  markScenePeople();
}

/** Update progress in the sidebar without rebuilding it (keeps scroll position and focus). */
function updateSceneMeta() {
  for (const s of scenes) {
    const b = sceneButtons.get(s.id);
    if (!b) continue;
    b.lastElementChild.replaceWith(sceneMeta(s));
    b.classList.remove("is-complete", "is-review", "is-open");
    b.classList.add("is-" + progress(s).state);
  }
  showClaim();
}

// ---------- "I'm translating this scene" ----------
function showClaim() {
  const btn = $("#claim-btn");
  const s = !$("#search").value.trim() && scenes.find((x) => x.id === currentScene);
  const team = summary?.git?.repo || summary?.shared;
  btn.hidden = !s || !team;
  if (btn.hidden) return;
  const c = s.claimed;
  btn.textContent = !c ? "✋ Claim this scene" : c.name === me ? "✓ You claimed this · release" : `✋ ${c.name} is on this`;
  btn.title = !c ? "Tell your team you're translating this scene, so they pick another one"
    : c.name === me ? "Let others take this scene again" : `${c.name} claimed it ${timeAgo(c.at)} – click to take it over`;
}

async function toggleClaim() {
  const s = scenes.find((x) => x.id === currentScene);
  if (!s) return;
  const on = !s.claimed || s.claimed.name !== me;
  if (on && s.claimed && !confirm(`${s.claimed.name} claimed this scene. Take it over?`)) return;
  try {
    const res = await api("/api/claim", { group: currentGroup, scene: s.id, on });
    s.claimed = res.claimed;
    renderScenes();
    showClaim();
    if (summary.git?.repo) toast(on ? "Claimed – your team sees it after you Sync" : "Released");
  } catch (err) {
    toast(err.message, true);
  }
}

function markScenePeople() {
  for (const [id, b] of sceneButtons) {
    const here = b.querySelector(".scene-people");
    here.textContent = "";
    people.filter((p) => p.scene === id).forEach((p) => here.append(avatar(p.name, "avatar xs")));
  }
}

// ---------- lines ----------
async function openScene(id, { keepScroll = false } = {}) {
  if (!(await flushAll())) return;
  currentScene = id;
  store.set(projectId + "|scene", id);
  $("#search").value = "";
  sceneButtons.forEach((b, sid) => b.classList.toggle("active", sid === id));
  const s = scenes.find((x) => x.id === id);
  $("#crumb").textContent = currentGroup;
  $("#scene-title").textContent = s ? s.title || "(untitled)" : "";
  showClaim();
  const state = $("#state-filter").value;
  try {
    const lines = await api(`/api/lines?group=${encodeURIComponent(currentGroup)}&subgroup=${encodeURIComponent(id)}&state=${state}&limit=20000`);
    renderLines(lines, false, keepScroll);
  } catch (err) {
    toast(err.message, true);
  }
}

async function runSearch({ keepScroll = false } = {}) {
  const q = $("#search").value.trim();
  if (!q) { if (currentScene !== null) openScene(currentScene); return; }
  if (!(await flushAll())) return;
  const state = $("#state-filter").value;
  try {
    const lines = await api(`/api/lines?search=${encodeURIComponent(q)}&state=${state}&limit=300`);
    $("#crumb").textContent = "Search";
    $("#claim-btn").hidden = true;
    $("#scene-title").textContent = `“${q}” – ${lines.length}${lines.length === 300 ? "+" : ""} lines`;
    renderLines(lines, true, keepScroll);
  } catch (err) {
    toast(err.message, true);
  }
}

/** Show the current scene/search again with fresh data (after a merge, or the file changed on disk). */
async function reloadView() {
  if (cards.some((c) => c.ta.value !== c.saved)) { updateCounts(); return; }
  if ($("#search").value.trim()) await runSearch({ keepScroll: true });
  else if (currentScene !== null) await openScene(currentScene, { keepScroll: true });
  updateCounts();
}

function clearLines() {
  $("#lines").textContent = "";
  cards = [];
  cardByRow.clear();
  view = { lines: [], showWhere: false };
}

const moreSentinel = el("div", "more", "Loading more lines…");
const moreObserver = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) renderMore();
}, { rootMargin: "800px" });
moreObserver.observe(moreSentinel);

function renderLines(lines, showWhere, keepScroll = false) {
  const content = $(".content");
  const top = content.scrollTop;
  const keepCount = keepScroll ? cards.length : 0;
  clearLines();
  view = { lines, showWhere };
  const box = $("#lines");
  if (!lines.length) {
    box.append(el("div", "empty", "No lines here with this filter."));
    return;
  }
  renderMore(Math.max(CHUNK, keepCount));
  content.scrollTop = keepScroll ? top : 0;
}

function renderMore(upto = cards.length + CHUNK) {
  const box = $("#lines");
  const end = Math.min(upto, view.lines.length);
  if (cards.length >= end) return;
  const frag = document.createDocumentFragment();
  const fresh = [];
  for (let i = cards.length; i < end; i++) {
    const card = buildCard(view.lines[i], view.showWhere);
    cards.push(card);
    cardByRow.set(card.line.row, card);
    frag.append(card.el);
    fresh.push(card);
  }
  box.append(frag);
  growAll(fresh);
  markCardPeople(fresh);
  if (cards.length < view.lines.length) box.append(moreSentinel); else moreSentinel.remove();
}

function buildCard(line, showWhere) {
  const root = el("article");
  const card = { line, el: root, saved: line.target, pending: null, conflict: null, same: 0, error: null, timer: null };

  const head = el("div", "card-head");
  head.append(el("span", "rownum", "#" + (line.row + 1)));
  if (line.speaker) head.append(el("span", "speaker", line.speaker));
  if (line.key) head.append(el("code", "key", line.key));
  if (showWhere) head.append(el("span", "where", `${line.group} › ${line.subgroup}`));
  const here = el("span", "here");
  const by = el("span", "by");
  const dirty = el("span", "dirty");
  const chip = el("span");
  head.append(here, by, dirty, chip);

  const src = el("div", "source");
  renderSource(src, line.source);

  const ref = el("div", "reference");
  if (line.reference) ref.append(el("b", "", (summary.labels.reference || "Reference") + ": "), line.reference);

  const note = el("div", "note");
  note.addEventListener("click", () => editNote(card));
  note.title = "Click to edit the note";

  const conflictBox = el("div", "conflict");
  conflictBox.hidden = true;

  const ta = el("textarea", "target");
  ta.rows = 1;
  ta.spellcheck = false;
  ta.placeholder = (summary.labels.target || "Translation") + "…";
  ta.value = line.target;

  const noteEdit = el("div", "note-edit");
  noteEdit.hidden = true;
  const noteInput = el("input");
  noteInput.placeholder = "Note for your team (e.g. “not sure about the tone here”) – empty to remove";
  noteInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveNote(card); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); noteEdit.hidden = true; ta.focus(); }
  });
  noteEdit.append(noteInput, button("small primary", "Save note", () => saveNote(card)),
    button("small ghost", "Cancel", () => { noteEdit.hidden = true; }));

  const foot = el("div", "card-foot");
  const tagInfo = el("span");
  const count = el("span", "count");
  const hints = el("span", "hints");
  for (const g of glossaryHits(line.source)) {
    const h = button("hint-chip", `${g.source} → ${g.target || "(keep)"}`,
      () => insertAtCursor(ta, g.target || g.source), (g.note ? g.note + " · " : "") + "Click to insert");
    hints.append(h);
  }
  const sameBtn = button("small ghost same", "", () => fillSame(card),
    "Use this translation for the other untranslated lines with exactly the same original text");
  sameBtn.hidden = true;
  const actions = el("span", "foot-actions");
  actions.append(
    button("small ghost", "Note", () => editNote(card), "Leave a note for your team on this line"),
    button("small ghost", "Copy original", () => { ta.value = line.source; ta.dispatchEvent(new Event("input")); ta.focus(); }, "Ctrl+Shift+C"),
    button("small ghost flag", "⚑ Review", () => save(card, "review").then((ok) => ok && focusNext(card)),
      "Save and mark “needs review” – someone should check this line (Ctrl+Shift+Enter)"),
    button("small primary", "Done ✓", () => save(card, "done").then((ok) => ok && focusNext(card)),
      "Save and mark done (Ctrl+Enter)"),
  );
  foot.append(tagInfo, count, hints, sameBtn, actions);

  root.append(head, src, ref, note, conflictBox, ta, noteEdit, foot);
  Object.assign(card, { ta, chip, dirty, tagInfo, count, by, here, note, conflictBox, noteEdit, noteInput, sameBtn });
  if (line.conflict) showGitConflict(card, line.conflict);
  refresh(card);

  ta.addEventListener("input", () => {
    autoGrow(ta);
    refresh(card);
    clearTimeout(card.timer);
    card.timer = setTimeout(() => save(card, "auto", { quiet: true }), AUTOSAVE_MS);
  });
  ta.addEventListener("focus", () => {
    cards.forEach((c) => c.el.classList.remove("focused"));
    root.classList.add("focused");
    focusedRow = card.line.row;
  });
  ta.addEventListener("blur", () => { if (ta.value !== card.saved) save(card, "auto"); });
  ta.addEventListener("keydown", (e) => onKey(e, card));
  return card;
}

function refresh(card) {
  const { line, ta } = card;
  const text = ta.value;
  const isDirty = text !== card.saved;
  const state = card.conflict || card.gitConflict ? "conflict" : isDirty ? "dirty" : line.state;
  card.el.className = "card state-" + state + (card.el.classList.contains("focused") ? " focused" : "");
  card.chip.className = "chip " + line.state;
  card.chip.textContent = STATE_LABEL[line.state] +
    (line.status === "google" || line.status === "machine" ? " (machine)" : "");
  card.dirty.textContent = card.pending ? "saving…" : isDirty ? "● unsaved" : "";
  card.by.textContent = line.by ? `✎ ${line.by}${line.at ? " · " + timeAgo(line.at) : ""}` : "";
  card.note.hidden = !line.note;
  if (line.note) card.note.textContent = `📝 ${line.note}${line.note_by ? " — " + line.note_by : ""}`;
  card.sameBtn.hidden = !card.same;
  card.sameBtn.textContent = `Fill ${card.same} identical line${card.same === 1 ? "" : "s"}`;
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

/**
 * Save one line. mode: "auto" (typing pause, leaving the box – keeps a "needs review" flag),
 * "done" or "review". Waits for a save that is still on its way instead of giving up, so
 * clicking Done / another scene / Save right after typing always works.
 */
async function save(card, mode = "auto", { quiet = false, force = false } = {}) {
  clearTimeout(card.timer);
  while (card.pending) await card.pending;
  const text = card.ta.value;
  card.error = null;
  if (card.conflict && !force) {
    card.error = "conflict";
    if (!quiet) toast("Someone else changed this line – pick which version to keep first.", true);
    return false;
  }
  if (text.trim() && !sameTags(card.line.source, text)) {
    card.error = "codes";
    if (!quiet) toast("The codes don't match the original – fix them first.", true);
    return false;
  }
  let status = mode === "done" ? "reviewed" : mode === "review" ? "review"
    : card.line.state === "review" ? card.line.status : "reviewed";
  if (!text.trim() && hasWords(card.line.source)) status = "";
  if (!force && text === card.saved && status === card.line.status) return true;
  card.pending = (async () => {
    try {
      const res = await api("/api/line", { row: card.line.row, target: text, status, base: card.saved, force });
      card.line = res.line;
      card.saved = text;
      card.same = res.same || 0;
      return true;
    } catch (err) {
      if (err.status === 409 && err.data?.conflict) {
        showConflict(card, err.data.line, mode);
        card.error = "conflict";
      } else {
        card.error = err.message;
        if (!quiet || !err.offline) toast(err.message, true);
      }
      return false;
    }
  })();
  refresh(card);
  let ok;
  try {
    ok = await card.pending;
  } finally {
    card.pending = null;
  }
  refresh(card);
  if (ok) updateCounts();
  return ok;
}

function showConflict(card, theirs, mode = "auto") {
  card.conflict = theirs;
  const box = card.conflictBox;
  box.textContent = "";
  box.hidden = false;
  box.append(el("div", "", `${theirs.by || "Someone"} changed this line while you were editing it. Their version:`),
    el("div", "their-text", theirs.target || "(empty)"));
  const btns = el("div", "conflict-actions");
  btns.append(
    button("small ghost", "Use theirs", () => resolveConflict(card, false)),
    button("small primary", "Keep mine", () => resolveConflict(card, true, mode)),
  );
  box.append(btns);
  refresh(card);
}

/** Found while syncing: a teammate translated this line differently. Stays until you choose. */
function showGitConflict(card, c) {
  card.gitConflict = c;
  const box = card.conflictBox;
  box.textContent = "";
  box.hidden = false;
  box.append(el("div", "", "A teammate translated this line differently (found when you synced). Their version:"),
    el("div", "their-text", c.theirs || "(empty)"));
  if (c.base) box.append(el("div", "muted small", "Before, it was: " + c.base));
  const btns = el("div", "conflict-actions");
  btns.append(
    button("small ghost", "Use theirs", () => resolveGitConflict(card, false)),
    button("small primary", "Keep mine", () => resolveGitConflict(card, true)),
  );
  box.append(btns);
}

async function resolveGitConflict(card, keepMine) {
  if (!keepMine && !(await save(card, "auto"))) return;
  try {
    const res = await api("/api/resolve", { row: card.line.row, keep: keepMine ? "mine" : "theirs" });
    card.gitConflict = null;
    card.conflictBox.hidden = true;
    card.line = res.line;
    if (!keepMine) {
      card.saved = card.ta.value = res.line.target;
      autoGrow(card.ta);
    }
    refresh(card);
    if (summary.git) renderGit({ ...summary.git, conflicts: Math.max(0, (summary.git.conflicts || 1) - 1) });
    updateCounts();
  } catch (err) {
    toast(err.message, true);
  }
}

function resolveConflict(card, keepMine, mode = "auto") {
  const theirs = card.conflict;
  card.conflict = null;
  card.conflictBox.hidden = true;
  if (keepMine) {
    card.line = { ...theirs, target: card.line.target };
    save(card, mode, { force: true });
  } else {
    card.line = theirs;
    card.saved = card.ta.value = theirs.target;
    autoGrow(card.ta);
    refresh(card);
  }
}

/** Save every card with unsaved changes. Returns false if the user chose to stay and fix one. */
async function flushAll() {
  for (const c of cards) {
    while (c.pending) await c.pending;
    if (c.ta.value === c.saved && !c.conflict) continue;
    if (await save(c, "auto", { quiet: true })) continue;
    c.el.scrollIntoView({ block: "center" });
    const why = c.error === "conflict" ? "someone else changed it at the same time"
      : c.error === "codes" ? "its codes don't match the original" : c.error;
    if (!confirm(`Line #${c.line.row + 1} can't be saved: ${why}.\n\nOK = throw away your change to this line and continue\nCancel = stay here and fix it`)) {
      c.ta.focus();
      return false;
    }
    if (c.conflict) resolveConflict(c, false);
    else { c.ta.value = c.saved; autoGrow(c.ta); refresh(c); }
  }
  return true;
}

let countsTimer = null;
function updateCounts() {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(async () => {
    if (!projectId) return;
    try {
      await loadSummary();
      if (currentGroup !== null) {
        scenes = await api("/api/subgroups?group=" + encodeURIComponent(currentGroup));
        if (scenes.every((s) => sceneButtons.has(s.id) || $("#scene-filter").value)) updateSceneMeta(); else renderScenes();
      }
    } catch { /* shown by the offline bar */ }
  }, 500);
}

function focusIndex(i, smooth = false) {
  if (i < 0 || i >= view.lines.length) return;
  if (i >= cards.length) renderMore(i + CHUNK);
  const c = cards[i];
  c.ta.focus({ preventScroll: true });
  c.el.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
}

function focusNext(card, step = 1) {
  focusIndex(cards.indexOf(card) + step, true);
}

function onKey(e, card) {
  if (e.key === "Enter" && e.ctrlKey) {
    e.preventDefault();
    save(card, e.shiftKey ? "review" : "done").then((ok) => ok && focusNext(card));
  } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    focusNext(card, e.key === "ArrowDown" ? 1 : -1);
  } else if ((e.key === "C" || e.key === "c") && e.ctrlKey && e.shiftKey) {
    e.preventDefault();
    card.ta.value = card.line.source;
    card.ta.dispatchEvent(new Event("input"));
  } else if (e.key === "Escape") {
    card.ta.value = card.saved;
    card.ta.dispatchEvent(new Event("input"));
    clearTimeout(card.timer);
  }
}

async function nextUnfinished() {
  const n = view.lines.length;
  const cur = cards.findIndex((c) => c.el.classList.contains("focused"));
  const isOpen = (i) => {
    const c = cards[i];
    return c ? c.line.state !== "done" || !c.ta.value.trim() : view.lines[i].state !== "done";
  };
  for (let k = 1; k <= n; k++) {
    const i = (cur + k + n) % n;
    if (i === cur) continue;
    if (isOpen(i)) { focusIndex(i); return; }
  }
  if ($("#search").value.trim()) { toast("No unfinished lines in these results."); return; }
  const idx = scenes.findIndex((s) => s.id === currentScene);
  const next = scenes.slice(idx + 1).find((s) => s.done < s.total) || scenes.find((s) => s.done < s.total && s.id !== currentScene);
  if (!next) { toast("Everything in this section is done!"); return; }
  await openScene(next.id);
  const first = view.lines.findIndex((l) => l.state !== "done");
  if (first >= 0) focusIndex(first);
}

// ---------- notes & identical lines ----------
function editNote(card) {
  card.noteEdit.hidden = false;
  card.noteInput.value = card.line.note || "";
  card.noteInput.focus();
}

async function saveNote(card) {
  try {
    const res = await api("/api/note", { row: card.line.row, note: card.noteInput.value });
    card.line = { ...res.line, target: card.line.target, status: card.line.status, state: card.line.state };
    card.noteEdit.hidden = true;
    refresh(card);
    card.ta.focus();
  } catch (err) {
    toast(err.message, true);
  }
}

async function fillSame(card) {
  if (!(await save(card, "auto"))) return;
  try {
    const res = await api("/api/fill-same", { row: card.line.row });
    card.same = 0;
    refresh(card);
    toast(`Filled ${res.filled} identical line${res.filled === 1 ? "" : "s"}`);
    pollNow();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- live updates & teammates ----------
function startPolling() {
  stopPolling();
  pollTimer = setTimeout(poll, 1000);
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
  people = [];
  renderPeople();
}

function pollNow() {
  clearTimeout(pollTimer);
  poll();
}

async function poll() {
  const pid = projectId;
  if (!pid || polling) return;
  polling = true;
  try {
    if (!document.hidden) {
      const res = await api(`/api/poll?since=${version}&session=${session}&row=${focusedRow ?? ""}` +
        `&scene=${encodeURIComponent(currentScene ?? "")}`);
      if (pid !== projectId) return;
      version = res.version;
      if (res.reload) {
        await reloadView();
      } else if (res.lines.length) {
        res.lines.forEach(applyRemote);
        updateCounts();
      }
      people = res.people;
      renderPeople();
      renderSaveState(res.save);
      if (res.git) renderGit(res.git);
    }
  } catch { /* offline: the bar says so, keep trying */ } finally {
    polling = false;
    if (pid === projectId) {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, people.length ? 2000 : 4000);
    }
  }
}

/** A line changed on the server (a teammate, another tab, Fill identical, Merge). */
function applyRemote(line) {
  const i = view.lines.findIndex((l) => l.row === line.row);
  if (i >= 0 && i >= cards.length) view.lines[i] = line;
  const card = cardByRow.get(line.row);
  if (!card || card.pending) return; // a save of ours is on its way; its answer wins
  if ((line.at || 0) < (card.line.at || 0) && line.note === card.line.note) return; // older news
  const dirty = card.ta.value !== card.saved;
  if (!dirty) {
    const changed = line.target !== card.saved;
    card.line = line;
    card.saved = line.target;
    if (changed) {
      card.ta.value = line.target;
      autoGrow(card.ta);
      if (line.by !== me) flash(card);
    }
  } else if (line.target !== card.saved) {
    showConflict(card, line);
    return;
  } else {
    card.line = line; // only the note or status changed
  }
  if (line.conflict && !card.gitConflict) showGitConflict(card, line.conflict);
  else if (!line.conflict && card.gitConflict) { card.gitConflict = null; card.conflictBox.hidden = !card.conflict; }
  refresh(card);
}

function flash(card) {
  card.el.classList.remove("flash");
  void card.el.offsetWidth;
  card.el.classList.add("flash");
}

function renderPeople() {
  const box = $("#people");
  box.textContent = "";
  const names = [...new Set(people.map((p) => p.name))];
  names.forEach((n) => box.append(avatar(n, "avatar sm")));
  $("#share-btn").title = names.length ? `Working now: ${names.join(", ")}` : "Work on this project together";
  markCardPeople(cards);
  markScenePeople();
}

function markCardPeople(list) {
  for (const c of list) {
    c.here.textContent = "";
    for (const p of people) {
      if (p.row !== c.line.row) continue;
      const tag = el("span", "here-tag", `${p.name} is here`);
      tag.style.borderColor = tag.style.color = personColor(p.name);
      c.here.append(tag);
    }
  }
}

// ---------- git: translating with people anywhere ----------
function renderGit(g) {
  if (!summary) return;
  summary.git = g || { repo: false };
  const btn = $("#sync-btn");
  btn.hidden = !summary.git.repo;
  const bar = $("#conflict-bar");
  bar.hidden = !g?.conflicts;
  if (g?.conflicts) {
    $("#conflict-text").textContent = `${g.conflicts} line${g.conflicts === 1 ? " was" : "s were"} translated ` +
      "differently by you and a teammate. Choose which version to keep.";
  }
  if (!summary.git.repo) return;
  const parts = [];
  if (g.behind) parts.push(`↓${g.behind}`);
  if (g.changed) parts.push(`↑${g.changed}`); else if (g.uncommitted || g.ahead) parts.push("↑");
  $("#sync-badge").textContent = parts.join(" ");
  btn.classList.toggle("has-news", !!g.behind);
  const tips = [];
  tips.push(g.changed ? `${g.changed} of your changed lines aren't shared yet` : g.uncommitted || g.ahead
    ? "You have changes that aren't shared yet" : "Everything you did is shared");
  if (g.behind) tips.push(`${g.behind} update${g.behind === 1 ? "" : "s"} from teammates waiting`);
  if (g.fetch_error) tips.push("⚠ " + g.fetch_error);
  if (g.last_sync) tips.push("Last sync " + timeAgo(g.last_sync));
  btn.title = tips.join("\n") + "\nClick to share your lines and get your team's.";
}

async function syncNow() {
  if (!projectId) return;
  if (!(await flushAll())) return;
  const btn = $("#sync-btn");
  const label = btn.querySelector(".sync-label");
  btn.disabled = true;
  label.textContent = "⇅ Syncing…";
  toast("Syncing with your team… (a GitHub sign-in window may open the first time)");
  try {
    const res = await api("/api/sync", {});
    renderGit(res.git);
    if (res.local_only) toast(res.message);
    else {
      toast(`✓ Synced · shared ${res.sent} line${res.sent === 1 ? "" : "s"} · got ${res.received} from teammates` +
        (res.conflicts ? ` · ${res.conflicts} to decide` : ""), res.conflicts > 0);
    }
    try { glossary = await api("/api/glossary"); } catch { /* keep */ }
    await reloadView();
    if ($("#share-dialog").open) openShare();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    label.textContent = "⇅ Sync";
  }
}

async function renderTeamGit() {
  const box = $("#team-git");
  box.textContent = "";
  const g0 = summary.git || {};
  if (!g0.repo) {
    box.append(el("h4", "", "Translate with people anywhere"));
    if (summary.save.mode === "direct") {
      box.append(el("p", "", "This CSV isn't in a git repository yet. Put its folder in a GitHub repository " +
        "(e.g. with GitHub Desktop: File → Add local repository → create one → Publish), then open the editor again."));
    } else {
      const ol = el("ol");
      ol.append(el("li", "", "Put your CSV in a GitHub repository and download (clone) it, e.g. with GitHub Desktop."),
        el("li", "", "In the editor, press Open a file… (start screen) and pick the CSV from that folder."),
        el("li", "", "Choose “Work on this file itself – for a team sharing it on GitHub”, then push once (Sync)."),
        el("li", "", "Teammates clone the same repository, open the same CSV in their own editor, and press Sync now and then."));
      box.append(el("p", "", "This project is a private copy on this computer. To share it:"), ol);
    }
    return;
  }
  box.append(el("p", "muted", "Loading…"));
  let g;
  try { g = await api("/api/git"); } catch (err) { box.textContent = ""; box.append(el("p", "warn", err.message)); return; }
  renderGit({ ...summary.git, ...g, log: undefined });
  box.textContent = "";
  const head = el("p");
  head.append("Shared through git: ", el("code", "", g.remote || "(no GitHub remote yet)"));
  if (g.branch) head.append(" · branch ", el("b", "", g.branch));
  box.append(head);
  const st = el("ul", "git-status");
  const item = (cls, text) => st.append(el("li", cls, text));
  if (g.changed) item("", `↑ ${g.changed} of your changed lines aren't shared yet`);
  else if (g.uncommitted || g.ahead) item("", "↑ You have changes that aren't shared yet");
  else item("ok", "✓ Everything you did is shared");
  if (g.behind) item("news", `↓ ${g.behind} update${g.behind === 1 ? "" : "s"} from teammates waiting`);
  if (g.conflicts) item("warn", `${g.conflicts} line${g.conflicts === 1 ? "" : "s"} translated differently – choose which version to keep`);
  if (g.no_upstream) item("muted", "Not uploaded to GitHub yet – Sync uploads it");
  if (g.fetch_error) item("warn", "⚠ " + g.fetch_error);
  if (g.last_sync) item("muted", "Last sync " + timeAgo(g.last_sync));
  const sync = button("primary", "⇅ Sync now", syncNow);
  box.append(st, sync);
  if (g.log?.length) {
    box.append(el("h4", "", "Recent activity"));
    const ul = el("ul", "people-list activity");
    for (const e of g.log) {
      const li = el("li");
      li.append(avatar(e.author, "avatar sm"), el("b", "", " " + e.author), el("span", "muted", ` · ${timeAgo(e.at)} · `), e.message);
      ul.append(li);
    }
    box.append(ul);
  }
  const help = el("details", "team-more");
  const csvFile = (g.files || [])[0] || summary.file;
  const ol = el("ol");
  ol.append(
    el("li", "", "Install Python and download this Translation Editor (from its GitHub page: Code → Download ZIP)."),
    el("li", "", `Download (clone) the translation repository${g.remote ? " " + g.remote : ""} – easiest with GitHub Desktop: File → Clone repository.`),
    el("li", "", `Start the editor, press Open a file… and pick ${csvFile} in that folder. Everything else is already set up.`),
    el("li", "", "Translate, and press ⇅ Sync now and then (at least when you start and when you stop)."));
  help.append(el("summary", "", "How teammates join"), ol,
    el("p", "hint", "To let them upload, the repository owner adds them on GitHub: the repository → Settings → " +
      "Collaborators. Tip: claim a scene (button above the lines) so two people don't translate the same one."));
  box.append(help);
}

async function openShare() {
  renderTeamGit();
  $("#team-lan").open = !!summary.shared && !summary.git?.repo;
  const d = $("#share-dialog");
  const box = $("#share-body");
  box.textContent = "";
  let info = { shared: false };
  try { info = await api("/api/share", undefined, { noProject: true }); } catch { /* offline */ }
  if (info.shared && info.urls.length) {
    box.append(el("p", "", "Sharing is on. Send this link to teammates on the same Wi-Fi or network:"));
    for (const u of info.urls) {
      const row = el("div", "share-row");
      const input = el("input");
      input.value = u;
      input.readOnly = true;
      row.append(input, button("small primary", "Copy", async () => {
        try { await navigator.clipboard.writeText(u); toast("Link copied"); } catch { input.select(); }
      }));
      box.append(row);
    }
    box.append(el("p", "hint", "Everyone edits the same project live: lines others change appear on your screen, " +
      "you see who is on which line, and if two people change the same line at once the editor asks which version to keep."));
  } else if (info.shared) {
    box.append(el("p", "", "You joined through a share link – you're working together with the person running the editor."));
  } else {
    box.append(el("p", "", "Translate together, live:"));
    const ol = el("ol");
    ol.append(el("li", "", "Close the editor window."),
      el("li", "", "Start START_SHARED.bat instead (or: python translator.py --share)."),
      el("li", "", "It shows a link – send it to your teammates on the same Wi-Fi / network."));
    box.append(ol,
      el("p", "hint", "Not on the same network? Each person translates their own copy, then use Merge to bring " +
        "everyone's lines together. Lines are matched by key or identical original text."));
  }
  const list = $("#share-people");
  list.textContent = "";
  const all = [{ name: me || "You", row: focusedRow, scene: currentScene, self: true }, ...people];
  for (const p of all) {
    const li = el("li");
    const scene = scenes.find((s) => s.id === p.scene);
    li.append(avatar(p.name, "avatar sm"), ` ${p.name}${p.self ? " (you)" : ""}`,
      el("span", "muted", scene ? ` · ${scene.title}` : p.row != null ? ` · line #${p.row + 1}` : ""));
    list.append(li);
  }
  if (!d.open) d.showModal();
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
  td.append(button("small ghost", "✕", () => tr.remove(), "Remove"));
  tr.append(td);
  return tr;
}

async function openGlossary() {
  try { glossary = await api("/api/glossary"); } catch { /* keep what we have */ }
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
    await reloadView();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- saving to the file ----------
function renderSaveState(s) {
  if (!s || !summary) return;
  summary.save = s;
  const btn = $("#save-btn"), st = $("#save-state");
  st.className = "save-state";
  if (s.mode === "none") {
    btn.textContent = "Save to file…";
    btn.title = "Choose where the translated file goes. After that, Save (Ctrl+S) just updates it.";
    st.textContent = s.error ? "⚠ " + s.error : "Not saved to a file yet";
    if (s.error) st.classList.add("warn");
    return;
  }
  btn.textContent = "Save";
  btn.title = `Write the translation to ${s.path || s.name} now (Ctrl+S)`;
  st.title = s.path || s.name;
  if (s.error) {
    st.textContent = "⚠ " + s.error;
    st.classList.add("warn");
  } else if (s.pending) {
    st.textContent = s.mode === "linked" && !s.auto ? `Unsaved changes · ${s.name}` : `Saving… · ${s.name}`;
  } else {
    st.textContent = `✓ Saved to ${s.name}` + (s.saved_at ? " · " + timeAgo(s.saved_at) : "");
    st.classList.add("ok");
  }
}

async function saveToFile() {
  if (!projectId) return;
  if (!(await flushAll())) return;
  if (summary.save.mode === "none") { openSaveDialog(); return; }
  try {
    const info = await api("/api/save", {});
    renderSaveState(info);
    if (info.error) toast(info.error, true); else toast(`Saved to ${info.name}`);
  } catch (err) {
    toast(err.message, true);
  }
}

function fallbackValue() {
  return document.querySelector("input[name=fallback]:checked").value;
}

function updateExportLink() {
  $("#export-link").href = `/api/export?p=${encodeURIComponent(projectId)}&fallback=${fallbackValue()}`;
  $("#export-link").textContent = `Download a copy (${summary.save.export_name || summary.file})`;
}

async function openSaveDialog() {
  if (!(await flushAll())) return;
  const s = summary.save;
  const cur = $("#save-current");
  cur.textContent = "";
  if (s.mode === "direct") {
    cur.append("This project edits ", el("code", "", s.path || s.name),
      " directly – every change is written there by itself a moment after you make it.");
  } else if (s.mode === "linked") {
    cur.append("Saving to ", el("code", "", s.path || s.name),
      s.auto ? " – kept up to date automatically while you translate." : " – updated when you press Save (Ctrl+S).");
  } else {
    cur.append("Pick where the translated file should go. You only do this once: after that, Save (Ctrl+S) " +
      "updates the same file, no more exporting.");
  }
  const canChoose = s.mode !== "direct" && summary.owner;
  $("#save-choose").hidden = !canChoose;
  $("#save-not-owner").hidden = s.mode === "direct" || summary.owner;
  if (canChoose) {
    const opts = $("#save-options");
    opts.textContent = "";
    const current = s.path || "";
    let matched = false;
    for (const sug of s.suggest || []) {
      const label = el("label", "radio");
      const r = Object.assign(el("input"), { type: "radio", name: "save-choice", value: sug.path });
      if (sug.path === current || !current) { r.checked = true; matched = true; }
      const text = el("span");
      text.append(sug.label, el("br"), el("code", "small", sug.path));
      label.append(r, text);
      opts.append(label);
    }
    const free = !matched;  // no original file known (a dropped file), or an older project saving elsewhere
    const label = el("label", "radio");
    const r = Object.assign(el("input"), { type: "radio", name: "save-choice", value: "custom" });
    r.checked = free;
    label.hidden = !free;
    const text = el("span", "grow");
    text.append("File:");
    label.append(r, text);
    opts.append(label);
    $("#save-path").closest(".save-path-row")?.toggleAttribute("hidden", !free);
    $("#save-path").value = matched ? "" : current;
    $("#save-path").placeholder = "C:\\…\\" + (s.export_name || "translation.csv");
    $("#save-browse").hidden = !summary.can_pick;
    $("#save-auto").checked = s.mode === "linked" ? s.auto : true;
  }
  const fb = s.fallback || (/\.json$/i.test(s.export_name || "") ? "source" : "empty");
  document.querySelector(`input[name=fallback][value=${fb}]`).checked = true;
  updateExportLink();
  $("#save-dialog").showModal();
}

async function chooseOutput(pick) {
  const choice = document.querySelector("input[name=save-choice]:checked")?.value;
  const path = pick ? summary.save.path || "" : choice === "custom" || !choice ? $("#save-path").value.trim() : choice;
  if (!pick && !path) { $("#save-path").focus(); toast("Type the full path of the file, or use Browse.", true); return; }
  if (pick) toast("Choose the file in the window that opened (it may be behind the browser)…");
  try {
    const info = await api("/api/output", { path, pick, auto: $("#save-auto").checked, fallback: fallbackValue() });
    if (info.cancelled) return;
    renderSaveState(info);
    $("#save-dialog").close();
    if (info.error) toast(info.error, true); else toast(`Saved to ${info.name}. From now on Save updates this file.`);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- merge a teammate's file ----------
async function mergeFile(file) {
  if (!file) return;
  if (!(await flushAll())) return;
  const out = $("#merge-result");
  out.className = "hint";
  out.textContent = `Reading ${file.name}…`;
  const overwrite = $("#merge-overwrite").checked ? 1 : 0;
  const review = $("#merge-review").checked ? 1 : 0;
  try {
    const r = await api(`/api/merge?name=${encodeURIComponent(file.name)}&overwrite=${overwrite}&review=${review}`, file, { raw: true });
    out.className = "ok";
    out.textContent = `✓ ${r.filled.toLocaleString()} lines filled in from ${file.name}` +
      (r.kept ? ` · ${r.kept.toLocaleString()} kept (you already had a different translation)` : "") +
      (r.same ? ` · ${r.same.toLocaleString()} were already the same` : "") +
      (r.missing ? ` · ${r.missing.toLocaleString()} not translated in that file` : "");
    await reloadView();
  } catch (err) {
    out.className = "warn";
    out.textContent = err.message;
  }
}

function openMerge() {
  $("#share-dialog").close();
  $("#merge-result").textContent = "";
  $("#merge-dialog").showModal();
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

// ---------- drag and drop ----------
function setupDrop() {
  const overlay = $("#drop-overlay");
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.firstElementChild.textContent = $("#merge-dialog").open ? "Drop to merge these translations" : "Drop to start a new project";
    overlay.hidden = false;
  });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    if ($("#merge-dialog").open) mergeFile(e.dataTransfer.files[0]); else handleFile(e.dataTransfer.files[0]);
  });
  $("#file-input").addEventListener("change", (e) => { handleFile(e.target.files[0]); e.target.value = ""; });
  $("#merge-file").addEventListener("change", (e) => { mergeFile(e.target.files[0]); e.target.value = ""; });
  for (const id of ["#dropzone", "#merge-drop"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $(id).querySelector("input").click(); }
    });
  }
}

// ---------- start ----------
function init() {
  setupDrop();
  showMe();
  $("#home-btn").addEventListener("click", showStart);
  $("#open-btn").addEventListener("click", openFromDisk);
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
  $("#state-filter").addEventListener("change", () => ($("#search").value.trim() ? runSearch() : currentScene !== null && openScene(currentScene)));
  $("#next-btn").addEventListener("click", nextUnfinished);
  $("#glossary-btn").addEventListener("click", openGlossary);
  $("#glossary-add").addEventListener("click", () => {
    const row = glossaryRow();
    $("#glossary-body").append(row);
    row.querySelector("input").focus();
  });
  $("#glossary-save").addEventListener("click", saveGlossary);
  $("#help-btn").addEventListener("click", () => $("#help-dialog").showModal());
  $("#save-btn").addEventListener("click", saveToFile);
  $("#save-menu-btn").addEventListener("click", openSaveDialog);
  $("#save-state").addEventListener("click", openSaveDialog);
  $("#save-apply").addEventListener("click", () => chooseOutput(false));
  $("#save-browse").addEventListener("click", () => chooseOutput(true));
  $("#save-path").addEventListener("focus", () => {
    const custom = document.querySelector("input[name=save-choice][value=custom]");
    if (custom) custom.checked = true;
  });
  document.querySelectorAll("input[name=fallback]").forEach((r) => r.addEventListener("change", updateExportLink));
  $("#merge-btn").addEventListener("click", openMerge);
  $("#sync-btn").addEventListener("click", syncNow);
  $("#claim-btn").addEventListener("click", toggleClaim);
  $("#conflict-show").addEventListener("click", () => {
    $("#search").value = "";
    $("#state-filter").value = "conflicts";
    $("#crumb").textContent = "Translated differently";
    api("/api/lines?state=conflicts&limit=2000").then((lines) => {
      $("#scene-title").textContent = `${lines.length} line${lines.length === 1 ? "" : "s"} to decide`;
      $("#claim-btn").hidden = true;
      renderLines(lines, true);
    }).catch((err) => toast(err.message, true));
  });
  $("#share-btn").addEventListener("click", openShare);
  $("#me-btn").addEventListener("click", askName);
  $("#name-save").addEventListener("click", saveName);
  $("#name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveName(); } });
  $("#apply-btn").addEventListener("click", applyToGame);
  $("#setup-create").addEventListener("click", createProject);
  $("#setup-cancel").addEventListener("click", cancelSetup);
  $("#setup-dialog").addEventListener("cancel", (e) => { e.preventDefault(); cancelSetup(); });
  for (const id of ["#map-source", "#map-target"]) $(id).addEventListener("change", renderPreview);
  $("#tag-preset").addEventListener("change", () => { $("#tag-custom-wrap").hidden = $("#tag-preset").value !== "custom"; });
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "s" && (e.ctrlKey || e.metaKey) && !e.shiftKey && projectId && !$("#editor").hidden) {
      e.preventDefault();
      saveToFile();
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && projectId) pollNow(); });
  window.addEventListener("beforeunload", (e) => {
    if (cards.some((c) => c.ta.value !== c.saved || c.pending)) e.preventDefault();
  });

  const fromHash = () => new URLSearchParams(location.hash.slice(1)).get("p");
  window.addEventListener("hashchange", () => {
    const id = fromHash();
    if (id && id !== projectId) openProject(id);
  });
  if (fromHash()) openProject(fromHash()); else showStart();
}

init();
