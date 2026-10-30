/* Team Translation: the website. Data lives in Supabase; the rules in supabase/schema.sql decide who
   may do what, so this page only has to show it. */
"use strict";

const sb = supabase.createClient(window.SITE.url, window.SITE.key);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let me = null;            // my profile
let projects = [];
let project = null;       // the open project
let stats = [];           // scene_stats rows
let claims = [];
let view = null;          // {grp, scene} | {search} | {review: true}
let lines = [];           // lines on screen
let drafts = {};          // line id -> text typed but not sent
let channel = null;
let signUpMode = false;

// ---------- small helpers ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let toastTimer;
function toast(text, error = false) {
  const t = $("#toast");
  t.textContent = text;
  t.className = "toast" + (error ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 6000 : 3000);
}

/** Supabase errors in plain words. */
function explain(err) {
  const m = (err && (err.message || err.error_description || String(err))) || "Something went wrong.";
  if (/database error saving new user|NOT_INVITED/i.test(m)) return "This email hasn't been invited. Ask the admin to invite exactly this address.";
  if (/invalid login credentials/i.test(m)) return "Wrong email or password.";
  if (/email not confirmed/i.test(m)) return "Confirm your email first – open the link in the email you got.";
  if (/user already registered/i.test(m)) return "This email already has an account – sign in instead (or use Forgot password).";
  if (/rate limit/i.test(m)) return "Too many emails were sent just now. Wait a while and try again.";
  if (/failed to fetch|network/i.test(m)) return "No connection to the server. Check your internet.";
  if (/row-level security|permission denied/i.test(m)) return "You're not allowed to do that.";
  if (/weekly_activity|weekly_progress|week_scenes/i.test(m) && /function/i.test(m)) {
    return "The dashboard needs a database update: run docs/supabase/update-2-dashboard.sql in Supabase → SQL Editor.";
  }
  return m;
}

async function must(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

function tagRegex() {
  if (!project?.tag_pattern) return null;
  try { return new RegExp(project.tag_pattern, "gu"); } catch { return null; }
}

function tagsOf(text) {
  const re = tagRegex();
  return re ? (text.match(re) || []).sort() : [];
}

/** Codes in the original that the translation lost (or added). */
function tagProblem(source, text) {
  const a = tagsOf(source), b = tagsOf(text);
  if (a.join("\u0000") === b.join("\u0000")) return "";
  const missing = a.filter((t) => { const i = b.indexOf(t); if (i < 0) return true; b.splice(i, 1); return false; });
  if (missing.length) return `Missing code${missing.length > 1 ? "s" : ""}: ${missing.join(" ")}`;
  return `Extra code${b.length > 1 ? "s" : ""}: ${b.join(" ")}`;
}

function withTags(text) {
  const frag = document.createDocumentFragment();
  const re = tagRegex();
  if (!re) { frag.append(text); return frag; }
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    frag.append(text.slice(last, m.index), el("span", "tag", m[0]));
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

function isOwn(v) {
  return v.imported ? v.author_name.toLowerCase() === me.display_name.toLowerCase() : v.author === me.id;
}

function lineState(l) {
  const a = l.versions.some((v) => v.status === "approved");
  const p = l.versions.some((v) => v.status === "pending");
  return p ? "review" : a ? "done" : "untranslated";
}

function sceneState(s) {
  if (s.untranslated) return "open";
  return s.review ? "review" : "complete";
}

// ---------- signing in ----------
function showOnly(id) {
  for (const s of ["#login", "#noaccess", "#app"]) $(s).hidden = s !== id;
}

function setSignUpMode(on) {
  signUpMode = on;
  $("#login-hint").textContent = on
    ? "Use the email the admin invited, and choose a password (8 characters or more)."
    : "Sign in with the email the admin invited.";
  $("#login-submit").textContent = on ? "Create my account" : "Sign in";
  $("#login-toggle").textContent = on ? "I already have a password" : "First time here? Create your password";
  $("#login-pass").autocomplete = on ? "new-password" : "current-password";
  $("#login-msg").textContent = "";
}

function siteUrl() {
  return location.origin + location.pathname;
}

async function submitLogin(e) {
  e.preventDefault();
  const email = $("#login-email").value.trim().toLowerCase();
  const password = $("#login-pass").value;
  const msg = $("#login-msg");
  const btn = $("#login-submit");
  btn.disabled = true;
  msg.className = "msg";
  msg.textContent = signUpMode ? "Creating your account…" : "Signing in…";
  try {
    if (signUpMode) {
      const data = await must(sb.auth.signUp({ email, password, options: { emailRedirectTo: siteUrl() } }));
      if (!data.session) {
        setSignUpMode(false);
        msg.className = "msg ok";
        msg.textContent = "Almost done: open the link in the email we just sent you, then sign in here.";
      }
    } else {
      await must(sb.auth.signInWithPassword({ email, password }));
      msg.textContent = "";
    }
  } catch (err) {
    msg.className = "msg error";
    msg.textContent = explain(err);
  } finally {
    btn.disabled = false;
  }
}

async function forgotPassword(e) {
  e.preventDefault();
  const email = $("#login-email").value.trim().toLowerCase();
  const msg = $("#login-msg");
  if (!email) { msg.className = "msg error"; msg.textContent = "Type your email first."; $("#login-email").focus(); return; }
  try {
    await must(sb.auth.resetPasswordForEmail(email, { redirectTo: siteUrl() }));
    msg.className = "msg ok";
    msg.textContent = "If that email is on the team, a link to choose a new password is on its way.";
  } catch (err) {
    msg.className = "msg error";
    msg.textContent = explain(err);
  }
}

async function saveNewPassword(e) {
  e.preventDefault();
  const msg = $("#newpass-msg");
  try {
    await must(sb.auth.updateUser({ password: $("#newpass").value }));
    $("#newpass-form").hidden = true;
    $("#login-form").hidden = false;
    toast("Password saved.");
    start();
  } catch (err) {
    msg.className = "msg error";
    msg.textContent = explain(err);
  }
}

async function start() {
  const { data } = await sb.auth.getSession();
  if (!data.session) { me = null; showOnly("#login"); return; }
  const { data: prof } = await sb.from("profiles").select("*").eq("id", data.session.user.id).maybeSingle();
  if (!prof) { showOnly("#noaccess"); return; }
  me = prof;
  $("#me").textContent = me.display_name;
  $("#me").title = `${me.email}${me.is_admin ? " · admin" : me.can_review ? " · can approve" : ""}`;
  $("#admin-btn").hidden = !me.is_admin;
  $("#dash-btn").hidden = !me.is_admin;
  showDash(false);
  showOnly("#app");
  await loadProjects();
}

// ---------- projects, scenes ----------
async function loadProjects() {
  projects = await must(sb.from("projects").select("*").order("created_at"));
  const sel = $("#project-select");
  sel.textContent = "";
  for (const p of projects) sel.append(Object.assign(el("option", "", p.name), { value: p.id }));
  if (!projects.length) {
    project = null;
    showDash(false);
    $("#lines").textContent = "";
    $("#title").textContent = "No project yet";
    $("#crumb").textContent = "";
    $("#scenes").textContent = "";
    $("#group-select").textContent = "";
    $("#lines").append(el("p", "empty", me.is_admin
      ? "Open Admin → Projects → Import a game file to start."
      : "The admin hasn't added a game file yet."));
    return;
  }
  const remembered = Number(localGet("project"));
  await openProject(projects.find((p) => p.id === remembered) || projects[0]);
}

function localGet(k) { try { return localStorage.getItem("tt." + k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem("tt." + k, v); } catch { /* private window */ } }

async function openProject(p) {
  project = p;
  $("#project-select").value = p.id;
  localSet("project", p.id);
  document.title = `${p.name} · Team Translation`;
  drafts = {};
  subscribe();
  await loadStats();
  if (!$("#dash").hidden) loadDash().catch((err) => toast(explain(err), true));
  const groups = [...new Set(stats.map((s) => s.grp))];
  const savedView = (() => { try { return JSON.parse(localGet("view." + p.id) || "null"); } catch { return null; } })();
  const first = savedView && stats.find((s) => s.grp === savedView.grp && s.scene === savedView.scene)
    || stats.find((s) => s.untranslated || s.review) || stats[0];
  renderGroups(groups, first?.grp);
  if (first) await openScene(first.grp, first.scene);
}

async function loadStats() {
  stats = await must(sb.rpc("scene_stats", { p_project: project.id }));
  claims = await must(sb.from("claims").select("*").eq("project_id", project.id));
  renderProgress();
}

function sum(rows) {
  return rows.reduce((t, s) => ({
    total: t.total + Number(s.total), done: t.done + Number(s.done),
    review: t.review + Number(s.review), untranslated: t.untranslated + Number(s.untranslated),
  }), { total: 0, done: 0, review: 0, untranslated: 0 });
}

function progressText(c) {
  const n = (x) => x.toLocaleString();
  if (!c.total) return "";
  if (!c.untranslated && !c.review) return `✓ Complete · all ${n(c.total)} lines approved`;
  const pct = Math.floor(100 * c.done / c.total);
  return `${n(c.done)} of ${n(c.total)} approved (${pct}%)` +
    (c.review ? ` · ⚑ ${n(c.review)} waiting for review` : "") +
    (c.untranslated ? ` · ${n(c.untranslated)} untranslated` : "");
}

function renderProgress() {
  const c = sum(stats);
  $("#progress-text").textContent = progressText(c);
  $("#progress .done").style.width = c.total ? `${100 * c.done / c.total}%` : "0";
  $("#progress .review").style.width = c.total ? `${100 * c.review / c.total}%` : "0";
  renderGroupStats();
  renderScenes();
}

function renderGroups(groups, chosen) {
  const sel = $("#group-select");
  sel.textContent = "";
  for (const g of groups) {
    const c = sum(stats.filter((s) => s.grp === g));
    const o = el("option", "", `${g || "All lines"} — ${c.untranslated || c.review ? `${c.done}/${c.total}` : "✓"}`);
    o.value = g;
    sel.append(o);
  }
  if (chosen != null) sel.value = chosen;
}

function renderGroupStats() {
  const g = $("#group-select").value;
  $("#group-stats").textContent = progressText(sum(stats.filter((s) => s.grp === g)));
  const c = sum(stats);
  $("#review-all").textContent = c.review ? `⚑ Everything waiting for review (${c.review.toLocaleString()})` : "⚑ Nothing waiting for review";
  $("#review-all").disabled = !c.review;
}

function renderScenes() {
  const nav = $("#scenes");
  const g = $("#group-select").value;
  const q = $("#scene-filter").value.trim().toLowerCase();
  nav.textContent = "";
  for (const s of stats.filter((x) => x.grp === g && (!q || x.scene.toLowerCase().includes(q)))) {
    const b = el("button", `scene is-${sceneState(s)}`);
    b.type = "button";
    if (view && view.grp === s.grp && view.scene === s.scene) b.classList.add("active");
    b.append(el("span", "scene-title", s.scene || "(no scene)"));
    const meta = el("span", "scene-meta");
    const st = sceneState(s);
    meta.append(st === "complete" ? el("span", "done", "✓ Complete") : el("span", "", `${s.done}/${s.total}`));
    if (Number(s.review)) meta.append(el("span", "flag", `⚑ ${s.review}`));
    for (const c of claims.filter((c) => c.grp === s.grp && c.scene === s.scene)) meta.append(el("span", "claimed", `✋ ${c.user_name}`));
    b.append(meta);
    b.addEventListener("click", () => openScene(s.grp, s.scene));
    nav.append(b);
  }
}

// ---------- lines ----------
async function openScene(grp, scene) {
  view = { grp, scene };
  localSet("view." + project.id, JSON.stringify(view));
  $("#search").value = "";
  if ($("#group-select").value !== grp) { $("#group-select").value = grp; renderGroupStats(); }
  renderScenes();
  $("#crumb").textContent = grp || "";
  $("#title").textContent = scene || "(no scene)";
  renderClaim();
  await loadLines();
}

async function loadLines() {
  const args = { p_project: project.id, p_state: $("#filter").value || null };
  if (view.search) Object.assign(args, { p_search: view.search, p_limit: 300 });
  else if (view.review) Object.assign(args, { p_state: "review", p_limit: 300 });
  else Object.assign(args, { p_grp: view.grp, p_scene: view.scene });
  const box = $("#lines");
  box.textContent = "";
  box.append(el("p", "empty", "Loading…"));
  try {
    lines = await must(sb.rpc("get_lines", args));
  } catch (err) {
    box.textContent = "";
    box.append(el("p", "empty", explain(err)));
    return;
  }
  box.textContent = "";
  if (!lines.length) {
    box.append(el("p", "empty", view.search ? "Nothing found." : $("#filter").value ? "No lines like that here." : "This scene is empty."));
    return;
  }
  for (const l of lines) box.append(renderLine(l));
  if ((view.search || view.review) && lines.length >= 300) box.append(el("p", "empty", "Showing the first 300 – search more precisely to see others."));
}

async function refreshLines(ids, flash = false) {
  if (!ids.length) return;
  const fresh = await must(sb.rpc("get_lines", { p_project: project.id, p_ids: ids, p_limit: ids.length }));
  for (const l of fresh) {
    const i = lines.findIndex((x) => x.id === l.id);
    if (i < 0) continue;
    lines[i] = l;
    const old = $(`.line[data-id="${l.id}"]`);
    if (!old) continue;
    const card = renderLine(l);
    old.replaceWith(card);
    if (flash) card.classList.add("flash");
  }
}

function renderLine(l) {
  const st = lineState(l);
  const card = el("article", `line is-${st}`);
  card.dataset.id = l.id;

  const head = el("div", "line-head");
  head.append(el("span", "", `#${l.idx + 1}`));
  if (l.speaker) head.append(el("span", "speaker", l.speaker));
  if (l.key) head.append(el("span", "", l.key));
  if (view.search || view.review) head.append(el("span", "", `${l.grp} › ${l.scene}`));
  card.append(head);

  const src = el("p", "source");
  src.append(withTags(l.source));
  card.append(src);
  if (l.reference) card.append(el("p", "reference", l.reference));

  const approved = l.versions.find((v) => v.status === "approved");
  const main = el("div", "main" + (approved ? "" : " none"));
  if (approved) {
    main.append(el("div", "main-text", approved.text),
      el("div", "who", `✓ by ${approved.author_name || "?"} · approved by ${approved.decided_by_name || "?"} ${timeAgo(approved.decided_at)}`));
  } else {
    main.append(el("div", "who", "No approved translation yet"));
  }
  card.append(main);

  const pending = l.versions.filter((v) => v.status === "pending");
  if (pending.length) {
    const list = el("div", "versions");
    for (const v of pending) list.append(renderVersion(l, v));
    card.append(list);
  }
  const old = l.versions.filter((v) => v.status === "rejected" || v.status === "superseded");
  if (old.length) {
    const d = el("details", "history");
    d.append(el("summary", "", `History (${old.length} earlier version${old.length > 1 ? "s" : ""})`));
    const list = el("div", "versions");
    for (const v of old.slice().reverse()) list.append(renderVersion(l, v));
    d.append(list);
    card.append(d);
  }

  card.append(renderEditor(l, approved));
  card.append(renderNotes(l));
  return card;
}

function renderVersion(l, v) {
  const box = el("div", `version ${v.status === "pending" ? "pending" : "old"}`);
  const body = el("div", "version-body");
  body.append(el("div", "version-text", v.text));
  const label = { pending: "waiting for review", rejected: "not used", superseded: "replaced" }[v.status] || v.status;
  const who = el("div", "who muted");
  who.append(el("span", `chip ${v.status}`, label), ` ${v.author_name || "?"} · ${timeAgo(v.created_at)}`);
  if (v.decided_by_name && v.status !== "pending") who.append(` · decided by ${v.decided_by_name}`);
  const problem = tagProblem(l.source, v.text);
  if (problem) who.append(el("span", "tag-warn", ` · ${problem}`));
  body.append(who);
  box.append(body);

  const actions = el("div", "version-actions");
  const own = isOwn(v);
  const mayDecide = (me.can_review || me.is_admin) && (!own || me.is_admin); // the admin may approve their own
  if (v.status === "pending") {
    if (me.can_review || me.is_admin) {
      const ok = el("button", "small primary", "✓ Approve");
      ok.type = "button";
      ok.disabled = !mayDecide;
      ok.title = mayDecide ? "Make this the main translation" : "You can't approve your own translation – someone else checks it.";
      ok.addEventListener("click", () => decide(l, v, "approve_version"));
      actions.append(ok);
      if (mayDecide) {
        const no = el("button", "small", "Not this one");
        no.type = "button";
        no.addEventListener("click", () => decide(l, v, "reject_version"));
        actions.append(no);
      }
    }
    if (own && !v.imported) {
      const w = el("button", "small ghost", "Withdraw");
      w.type = "button";
      w.addEventListener("click", () => withdraw(l, v));
      actions.append(w);
    }
  } else if (mayDecide) {
    const ok = el("button", "small ghost", "Use this again");
    ok.type = "button";
    ok.addEventListener("click", () => decide(l, v, "approve_version"));
    actions.append(ok);
  }
  const copy = el("button", "small ghost", "Edit a copy");
  copy.type = "button";
  copy.title = "Start your own version from this one";
  copy.addEventListener("click", () => {
    const ta = $(`.line[data-id="${l.id}"] textarea`);
    ta.value = v.text;
    drafts[l.id] = v.text;
    ta.dispatchEvent(new Event("input"));
    ta.focus();
  });
  actions.append(copy);
  box.append(actions);
  return box;
}

function myPending(l) {
  return l.versions.find((v) => v.status === "pending" && !v.imported && v.author === me.id);
}

function renderEditor(l, approved) {
  const mine = myPending(l);
  const wrap = el("div", "editor");
  const ta = el("textarea");
  ta.rows = 2;
  ta.placeholder = approved ? "Suggest a better translation…" : "Your translation…";
  ta.value = drafts[l.id] ?? (mine ? mine.text : "");
  const foot = el("div", "editor-foot");
  const warn = el("span", "tag-warn");
  const send = el("button", "primary small", mine ? "Update my suggestion" : "Send for review");
  send.type = "button";
  const check = () => {
    warn.textContent = ta.value.trim() ? tagProblem(l.source, ta.value) : "";
    send.disabled = !ta.value.trim() || (mine && ta.value === mine.text);
  };
  ta.addEventListener("input", () => { drafts[l.id] = ta.value; check(); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!send.disabled) submit(l, ta.value, true); }
    if (e.key === "Escape") { delete drafts[l.id]; ta.value = mine ? mine.text : ""; check(); }
  });
  send.addEventListener("click", () => submit(l, ta.value, false));
  check();
  const hint = el("span", "muted small", mine ? "Your version is waiting for someone to approve it." : "Ctrl+Enter sends and goes to the next line");
  foot.append(hint, warn, send);
  wrap.append(ta, foot);
  return wrap;
}

function renderNotes(l) {
  const box = el("div", "notes");
  for (const n of l.notes) {
    const row = el("div", "note");
    row.append(el("strong", "", n.author_name || "?"), el("span", "note-body", n.body), el("span", "muted small", timeAgo(n.created_at)));
    if (n.author === me.id || me.is_admin) {
      const del = el("button", "link small", "delete");
      del.type = "button";
      del.addEventListener("click", async () => {
        try { await must(sb.from("notes").delete().eq("id", n.id)); await refreshLines([l.id]); } catch (err) { toast(explain(err), true); }
      });
      row.append(del);
    }
    box.append(row);
  }
  const form = el("form", "note-form");
  const input = el("input");
  input.placeholder = l.notes.length ? "Reply…" : "Add a note for the team…";
  input.maxLength = 4000;
  const add = el("button", "small", "Add note");
  add.type = "submit";
  form.append(input, add);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    add.disabled = true;
    try {
      await must(sb.from("notes").insert({ project_id: project.id, line_id: l.id, body }));
      await refreshLines([l.id]);
    } catch (err) {
      toast(explain(err), true);
      add.disabled = false;
    }
  });
  box.append(form);
  return box;
}

async function submit(l, text, next) {
  if (!text.trim()) return;
  const approved = l.versions.find((v) => v.status === "approved");
  if (approved && approved.text === text) { toast("That's already the approved translation."); return; }
  const mine = myPending(l);
  try {
    if (mine) await must(sb.from("versions").update({ text }).eq("id", mine.id));
    else await must(sb.from("versions").insert({ project_id: project.id, line_id: l.id, text }));
    delete drafts[l.id];
    await refreshLines([l.id]);
    scheduleStats();
    if (next) {
      const cards = $$(".line");
      const i = cards.findIndex((c) => c.dataset.id === String(l.id));
      const target = cards.slice(i + 1).find((c) => !c.classList.contains("is-done")) || cards[i + 1];
      target?.querySelector("textarea")?.focus();
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  } catch (err) {
    toast(explain(err), true);
  }
}

async function decide(l, v, fn) {
  try {
    await must(sb.rpc(fn, { p_id: v.id }));
    await refreshLines([l.id]);
    scheduleStats();
  } catch (err) {
    toast(explain(err), true);
  }
}

async function withdraw(l, v) {
  if (!confirm("Withdraw your suggestion?")) return;
  try {
    await must(sb.from("versions").delete().eq("id", v.id));
    await refreshLines([l.id]);
    scheduleStats();
  } catch (err) {
    toast(explain(err), true);
  }
}

// ---------- claims ----------
function renderClaim() {
  const btn = $("#claim-btn");
  if (!view || view.search || view.review) { btn.hidden = true; return; }
  const here = claims.filter((c) => c.grp === view.grp && c.scene === view.scene);
  const mine = here.find((c) => c.user_id === me.id);
  const others = here.filter((c) => c.user_id !== me.id).map((c) => c.user_name);
  btn.hidden = false;
  btn.textContent = mine ? "✋ You're on this scene – done" : "✋ I'm working on this scene";
  btn.title = others.length ? `Also here: ${others.join(", ")}` : "Lets the others know – it doesn't lock anything";
}

async function toggleClaim() {
  const mine = claims.find((c) => c.grp === view.grp && c.scene === view.scene && c.user_id === me.id);
  try {
    if (mine) await must(sb.from("claims").delete().match({ project_id: project.id, grp: view.grp, scene: view.scene, user_id: me.id }));
    else await must(sb.from("claims").insert({ project_id: project.id, grp: view.grp, scene: view.scene }));
    claims = await must(sb.from("claims").select("*").eq("project_id", project.id));
    renderClaim();
    renderScenes();
  } catch (err) {
    toast(explain(err), true);
  }
}

// ---------- live updates ----------
let statsTimer;
function scheduleStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(async () => {
    try { await loadStats(); renderClaim(); scheduleDash(); } catch { /* next change tries again */ }
  }, 800);
}

function subscribe() {
  if (channel) sb.removeChannel(channel);
  const filter = `project_id=eq.${project.id}`;
  const onChange = (payload) => {
    const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old || {};
    let lineId = row.line_id;
    if (!lineId && row.id) { // a delete only tells us the id
      const hit = lines.find((l) => l.versions.some((v) => v.id === row.id) || l.notes.some((n) => n.id === row.id));
      lineId = hit?.id;
    }
    const mineNow = row.author === me.id && payload.eventType !== "DELETE";
    if (lineId && lines.some((l) => l.id === lineId)) refreshLines([lineId], !mineNow).catch(() => {});
    scheduleStats();
  };
  channel = sb.channel(`project-${project.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "versions", filter }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "notes", filter }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "claims", filter }, () => scheduleStats())
    .subscribe();
}

// ---------- admin: team ----------
async function openAdmin() {
  $("#admin").showModal();
  await renderTeam();
  renderProjectAdmin();
}

async function renderTeam() {
  const [invites, people] = await Promise.all([
    must(sb.from("invites").select("*").order("created_at")),
    must(sb.from("profiles").select("*").order("created_at")),
  ]);
  const t = $("#team-table");
  t.textContent = "";
  const head = el("tr");
  for (const h of ["Name", "Email", "Status", "Can approve", ""]) head.append(el("th", "", h));
  t.append(head);
  for (const inv of invites) {
    const p = people.find((x) => x.email === inv.email);
    const tr = el("tr");
    tr.append(el("td", "", (p || inv).display_name), el("td", "", inv.email),
      el("td", "", inv.is_admin ? "admin" : p ? `joined ${timeAgo(p.created_at)}` : "invited – hasn't joined yet"));
    const td = el("td");
    const box = Object.assign(el("input"), { type: "checkbox", checked: (p || inv).can_review || inv.is_admin, disabled: inv.is_admin });
    box.addEventListener("change", async () => {
      try {
        await must(sb.from("invites").update({ can_review: box.checked }).eq("email", inv.email));
        if (p) await must(sb.from("profiles").update({ can_review: box.checked }).eq("id", p.id));
        toast(`${inv.display_name} ${box.checked ? "can" : "can't"} approve now.`);
      } catch (err) { toast(explain(err), true); box.checked = !box.checked; }
    });
    td.append(box);
    const act = el("td");
    if (!inv.is_admin) {
      const rm = el("button", "small", p ? "Remove from team" : "Cancel invite");
      rm.type = "button";
      rm.addEventListener("click", async () => {
        if (!confirm(`Remove ${inv.display_name}? They can't sign in to the team any more. Their translations stay.`)) return;
        try {
          if (p) await must(sb.from("profiles").delete().eq("id", p.id));
          await must(sb.from("invites").delete().eq("email", inv.email));
          await renderTeam();
        } catch (err) { toast(explain(err), true); }
      });
      act.append(rm);
    }
    tr.append(td, act);
    t.append(tr);
  }
}

async function invite(e) {
  e.preventDefault();
  const email = $("#invite-email").value.trim().toLowerCase();
  const name = $("#invite-name").value.trim();
  try {
    await must(sb.from("invites").insert({ email, display_name: name, can_review: $("#invite-review").checked }));
    $("#invite-email").value = "";
    $("#invite-name").value = "";
    toast(`${name} is invited. Send them the link to this site and tell them to use ${email}.`);
    await renderTeam();
  } catch (err) {
    toast(/duplicate key/.test(err.message || "") ? "That email is already invited." : explain(err), true);
  }
}

// ---------- admin: projects (export, import) ----------
function renderProjectAdmin() {
  const box = $("#project-admin");
  box.textContent = "";
  if (!projects.length) box.append(el("p", "hint", "No projects yet – import a game file below."));
  for (const p of projects) {
    const row = el("div", "project-row");
    const info = el("div", "grow");
    info.append(el("strong", "", p.name), el("div", "muted small", p.file_name));
    const pending = Object.assign(el("input"), { type: "checkbox" });
    const lab = el("label", "check small");
    lab.append(pending, "also lines still waiting for review");
    const exp = el("button", "primary small", "⬇ Export game file");
    exp.type = "button";
    exp.addEventListener("click", () => exportProject(p, pending.checked, exp));
    const del = el("button", "small", "Delete…");
    del.type = "button";
    del.addEventListener("click", () => deleteProject(p));
    row.append(info, lab, exp, del);
    box.append(row);
  }
}

async function fetchAll(build, size = 1000) {
  const out = [];
  for (let from = 0; ; from += size) {
    const part = await must(build().range(from, from + size - 1));
    out.push(...part);
    if (part.length < size) return out;
  }
}

async function exportProject(p, includePending, btn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Exporting…";
  try {
    const rows = await fetchAll(() => sb.from("lines").select("id, idx, cells, raw").eq("project_id", p.id).order("idx"));
    const states = includePending ? ["approved", "pending"] : ["approved"];
    const vers = await fetchAll(() => sb.from("versions").select("id, line_id, text, status, created_at")
      .eq("project_id", p.id).in("status", states).order("id"));
    const chosen = new Map();
    for (const v of vers) if (v.status === "approved") chosen.set(v.line_id, v.text);
    if (includePending) {
      for (const v of vers) if (v.status === "pending") chosen.set(v.line_id, v.text); // newest last
    }
    const d = p.delimiter, tc = p.target_col;
    const out = [p.header_raw != null ? p.header_raw : CSV.writeRow(p.header, d)];
    let changed = 0;
    for (const r of rows) {
      const text = chosen.get(r.id) ?? "";
      const cells = r.cells.slice();
      while (cells.length < p.header.length) cells.push("");
      if (r.raw != null && p.header_raw != null && (cells[tc] ?? "") === text) {
        out.push(r.raw);
      } else {
        cells[tc] = text;
        out.push(CSV.writeRow(cells, d));
        changed++;
      }
    }
    const body = out.join(p.newline) + (p.trailing_newline ? p.newline : "");
    const blob = new Blob(p.bom ? ["﻿", body] : [body], { type: "text/csv;charset=utf-8" });
    const a = Object.assign(el("a"), { href: URL.createObjectURL(blob), download: p.file_name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Exported ${p.file_name}: ${chosen.size.toLocaleString()} translated lines, ${changed.toLocaleString()} changed since the import.`);
  } catch (err) {
    toast(explain(err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function deleteProject(p) {
  const typed = prompt(`This deletes "${p.name}" with every translation, note and its history. Export it first!\n\nType the project name to delete it:`);
  if (typed !== p.name) { if (typed != null) toast("The name didn't match – nothing deleted."); return; }
  try {
    await must(sb.from("projects").delete().eq("id", p.id));
    toast("Deleted.");
    await loadProjects();
    renderProjectAdmin();
  } catch (err) { toast(explain(err), true); }
}

let imp = null; // what the import form is working on

async function readJsonFile(input) {
  const f = input.files[0];
  if (!f) return null;
  try { return JSON.parse(CSV.decode(await f.arrayBuffer()).text); } catch { throw new Error(`${f.name} isn't valid JSON.`); }
}

function fillSelect(sel, fields, chosen, allowNone = true) {
  sel.textContent = "";
  if (allowNone) sel.append(Object.assign(el("option", "", "(none)"), { value: "" }));
  for (const f of fields) sel.append(Object.assign(el("option", "", f), { value: f }));
  sel.value = fields.includes(chosen) ? chosen : allowNone ? "" : fields[0] || "";
}

async function prepareImport() {
  const msg = $("#imp-msg");
  msg.className = "msg";
  msg.textContent = "";
  $("#imp-go").disabled = true;
  const f = $("#imp-csv").files[0];
  if (!f) { $("#imp-map").hidden = true; return; }
  try {
    const { text, bom } = CSV.decode(await f.arrayBuffer());
    const t = CSV.parse(text);
    if (!t.header.length || !t.rows.length) throw new Error("That file has no lines.");
    const cfg = await readJsonFile($("#imp-cfg"));
    const notes = await readJsonFile($("#imp-notes"));
    imp = { file: f.name, table: t, bom, notes: notes || {} };
    const h = t.header;
    const c = cfg?.columns || {};
    const guess = (...names) => names.find((n) => h.includes(n)) || "";
    fillSelect($("#imp-source"), h, c.source || guess("english", "source", "text", "en"), false);
    fillSelect($("#imp-target"), h, c.target || guess("indonesian", "translation", "target", "id"));
    $("#imp-target").options[0].textContent = "(new column)";
    fillSelect($("#imp-key"), h, c.key || guess("key", "id"));
    fillSelect($("#imp-group"), h, c.group || guess("category", "group", "section"));
    fillSelect($("#imp-scene"), h, c.subgroup || guess("scene", "conversation", "subgroup"));
    fillSelect($("#imp-speaker"), h, c.speaker || guess("speaker", "character", "actor"));
    fillSelect($("#imp-reference"), h, c.reference || "");
    $("#imp-name").value = cfg?.name || f.name.replace(/\.[^.]+$/, "");
    $("#imp-label").value = c.labels?.target || "Indonesian";
    $("#imp-tags").value = cfg?.tag_pattern ?? "\\[[^\\]\\n]*\\]|\\{[^}\\n]*\\}|<[^>\\n]+>|%(?:\\d+\\$)?[-+ 0#]*\\d*(?:\\.\\d+)?[sdifxXc%]|\\\\[nrt]";
    $("#imp-map").hidden = false;
    const noteCount = Object.values(imp.notes).filter((m) => m && m.note).length;
    $("#imp-info").textContent = `${t.rows.length.toLocaleString()} lines, ${h.length} columns` +
      (notes ? ` · notes file: ${Object.keys(imp.notes).length} lines with a name, flag or note (${noteCount} notes)` : "");
    $("#imp-go").disabled = false;
  } catch (err) {
    msg.className = "msg error";
    msg.textContent = explain(err);
  }
}

async function runImport() {
  const msg = $("#imp-msg");
  const go = $("#imp-go");
  const t = imp.table;
  const col = (id) => $(id).value;
  const source = col("#imp-source");
  const pattern = $("#imp-tags").value;
  try { new RegExp(pattern, "gu"); } catch { msg.className = "msg error"; msg.textContent = "That code pattern isn't a valid regular expression."; return; }
  let header = t.header.slice();
  let targetName = col("#imp-target");
  let headerRaw = t.headerRaw;
  if (!targetName) {
    targetName = ($("#imp-label").value.trim() || "translation").toLowerCase();
    if (header.includes(targetName)) targetName += "_new";
    header.push(targetName);
    headerRaw = null;
  }
  if (targetName === source) { msg.className = "msg error"; msg.textContent = "The translation column can't be the text column."; return; }
  const tc = header.indexOf(targetName);
  const idx = (name) => (name ? t.header.indexOf(name) : -1);
  const [si, ki, gi, ci, pi, ri] = [source, col("#imp-key"), col("#imp-group"), col("#imp-scene"), col("#imp-speaker"), col("#imp-reference")].map(idx);
  const cell = (r, i) => (i >= 0 ? r.cells[i] ?? "" : "");

  go.disabled = true;
  msg.className = "msg";
  try {
    msg.textContent = "Creating the project…";
    const proj = await must(sb.from("projects").insert({
      name: $("#imp-name").value.trim() || imp.file, file_name: imp.file, header, header_raw: headerRaw,
      target_col: tc, delimiter: t.delimiter, newline: t.newline, bom: imp.bom, trailing_newline: t.trailingNewline,
      tag_pattern: pattern, target_label: $("#imp-label").value.trim() || "Translation",
      cols: { source, target: targetName, key: col("#imp-key"), group: col("#imp-group"), scene: col("#imp-scene"),
              speaker: col("#imp-speaker"), reference: col("#imp-reference") },
    }).select().single());

    const ids = new Map();
    const CHUNK = 400;
    for (let i = 0; i < t.rows.length; i += CHUNK) {
      msg.textContent = `Uploading lines… ${Math.min(i + CHUNK, t.rows.length).toLocaleString()} / ${t.rows.length.toLocaleString()}`;
      const part = t.rows.slice(i, i + CHUNK).map((r, j) => {
        const n = i + j;
        const page = Math.floor(n / 50) * 50;
        return {
          project_id: proj.id, idx: n, key: cell(r, ki), grp: cell(r, gi) || "All lines",
          scene: ci >= 0 ? cell(r, ci) : `Lines ${page + 1}–${page + 50}`, speaker: cell(r, pi),
          source: cell(r, si), reference: cell(r, ri), cells: r.cells, raw: r.raw,
        };
      });
      for (const row of await must(sb.from("lines").insert(part).select("id, idx"))) ids.set(row.idx, row.id);
    }

    // translations already in the file become approved versions (flagged ones wait for review),
    // keeping who wrote them and when; notes come along too
    const review = new Set(["review", "google", "machine", "CHECK TAGS"]);
    const versions = [], notes = [];
    const when = (s) => (s ? new Date(s * 1000).toISOString() : new Date().toISOString());
    t.rows.forEach((r, n) => {
      const m = imp.notes[String(n)] || {};
      const text = tc < r.cells.length ? r.cells[tc] : "";
      if (text && text.trim()) {
        const flagged = review.has(m.status);
        versions.push({
          project_id: proj.id, line_id: ids.get(n), text, author_name: m.by || "Imported", imported: true,
          status: flagged ? "pending" : "approved", created_at: when(m.at),
          decided_by_name: flagged ? null : "Imported", decided_at: flagged ? null : when(m.at),
        });
      }
      if (m.note) notes.push({ project_id: proj.id, line_id: ids.get(n), body: m.note, author_name: m.note_by || "Imported", imported: true, created_at: when(m.note_at || m.at) });
    });
    for (let i = 0; i < versions.length; i += CHUNK) {
      msg.textContent = `Uploading translations… ${Math.min(i + CHUNK, versions.length)} / ${versions.length}`;
      await must(sb.from("versions").insert(versions.slice(i, i + CHUNK)));
    }
    for (let i = 0; i < notes.length; i += CHUNK) await must(sb.from("notes").insert(notes.slice(i, i + CHUNK)));
    msg.className = "msg ok";
    msg.textContent = `Imported ${t.rows.length.toLocaleString()} lines, ${versions.length} translations, ${notes.length} notes.`;
    $("#imp-csv").value = $("#imp-cfg").value = $("#imp-notes").value = "";
    $("#imp-map").hidden = true;
    projects = await must(sb.from("projects").select("*").order("created_at"));
    renderProjectAdmin();
    await loadProjects();
    $("#project-select").value = proj.id;
    await openProject(projects.find((p) => p.id === proj.id));
  } catch (err) {
    msg.className = "msg error";
    msg.textContent = explain(err) + " – if the project was half created, delete it and import again.";
    go.disabled = false;
  }
}

// ---------- admin: dashboard ----------
const WEEKS = 12;
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
const KINDS = ["written", "approved", "reviewed", "notes"];
let dash = null;          // {weeks, activity, progress, people, oldWaiting, scenes}; weeks oldest first, one extra in front
let dashWeek = null;      // the week the report is about: its Monday, "2026-10-26"
let dashToken = 0;

const fmt = (n) => Number(n).toLocaleString();
const plural = (n, word) => `${fmt(n)} ${word}${Number(n) === 1 ? "" : "s"}`;
const compact = (n) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
function dayOf(w) { const [y, m, d] = w.split("-").map(Number); return new Date(y, m - 1, d); }
function shortDate(d) { return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }); }
function weekRange(w) {
  const a = dayOf(w), b = dayOf(w);
  b.setDate(b.getDate() + 6);
  return `${shortDate(a)} – ${shortDate(b)}`;
}
function isThisWeek(w) { return w === dash.weeks[dash.weeks.length - 1]; }
function prevWeek(w) { const i = dash.weeks.indexOf(w); return i > 0 ? dash.weeks[i - 1] : null; }
function approvedBy(w) { return Number(dash.progress.find((r) => r.week === w)?.approved ?? 0); }
function approvedIn(w) { const p = prevWeek(w); return p ? approvedBy(w) - approvedBy(p) : null; }

/** Everyone's work in one week, added up. Active = wrote, reviewed or wrote a note. */
function weekTotals(w) {
  const t = { written: 0, approved: 0, reviewed: 0, notes: 0, people: 0 };
  for (const r of dash.activity.filter((x) => x.week === w)) {
    for (const k of KINDS) t[k] += Number(r[k]);
    if (Number(r.written) || Number(r.reviewed) || Number(r.notes)) t.people++;
  }
  return t;
}

function showDash(on) {
  if (on && !project) { toast("Import a game file first (Admin → Projects)."); return; }
  $("#dash").hidden = !on;
  $(".layout").hidden = on;
  $("#dash-btn").textContent = on ? "← Translate" : "Dashboard";
  if (on) loadDash().catch((err) => toast(explain(err), true));
}

async function loadDash(quiet = false) {
  const token = ++dashToken;
  const p = project.id;
  $("#dash-title").textContent = project.name;
  if (!quiet) $("#dash").classList.add("loading");
  try {
    const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
    const [activity, progress, people, oldWaiting] = await Promise.all([
      must(sb.rpc("weekly_activity", { p_project: p, p_weeks: WEEKS + 1, p_tz: TZ })),
      must(sb.rpc("weekly_progress", { p_project: p, p_weeks: WEEKS + 1, p_tz: TZ })),
      must(sb.rpc("people_stats", { p_project: p })),
      sb.from("versions").select("id", { count: "exact", head: true })
        .eq("project_id", p).eq("status", "pending").lt("created_at", weekAgo)
        .then(({ count, error }) => { if (error) throw error; return count || 0; }),
    ]);
    if (token !== dashToken) return; // something newer is loading
    const weeks = progress.map((r) => r.week);
    dash = { weeks, activity, progress, people, oldWaiting, scenes: [] };
    if (!weeks.slice(1).includes(dashWeek)) dashWeek = weeks[weeks.length - 1];
    renderWeekSelect();
    renderTiles();
    renderCharts();
    renderHeat();
    renderContrib();
    await loadReport(token);
  } finally {
    if (token === dashToken) $("#dash").classList.remove("loading");
  }
}

let dashTimer;
function scheduleDash() {
  clearTimeout(dashTimer);
  dashTimer = setTimeout(() => { if (!$("#dash").hidden && project) loadDash(true).catch(() => {}); }, 3000);
}

function renderWeekSelect() {
  const sel = $("#dash-week");
  sel.textContent = "";
  dash.weeks.slice(1).reverse().forEach((w, i) => {
    const name = ["This week", "Last week"][i];
    sel.append(Object.assign(el("option", "", name ? `${name} · ${weekRange(w)}` : weekRange(w)), { value: w }));
  });
  sel.value = dashWeek;
}

function tile(label, value, sub, delta, hero = false) {
  const t = el("div", "tile card" + (hero ? " hero" : ""));
  t.append(el("div", "tile-label", label), el("div", "tile-value", value));
  if (sub) t.append(el("div", "tile-sub", sub));
  if (delta != null) {
    const d = el("div", "tile-delta " + (delta > 0 ? "up" : delta < 0 ? "down" : ""));
    d.textContent = `${delta > 0 ? "▲ +" : delta < 0 ? "▼ −" : "= "}${fmt(Math.abs(delta))} vs. the week before`;
    t.append(d);
  }
  return t;
}

function renderTiles() {
  const c = sum(stats), w = dashWeek, p = prevWeek(w);
  const now = weekTotals(w), before = weekTotals(p);
  const gained = approvedIn(w), gainedBefore = approvedIn(p);
  const when = isThisWeek(w) ? "this week" : "that week";
  const box = $("#dash-tiles");
  box.textContent = "";
  box.append(
    tile("Approved", c.total ? `${Math.floor(100 * c.done / c.total)}%` : "–", `${fmt(c.done)} of ${fmt(c.total)} lines`, null, true),
    tile("Newly approved", fmt(gained), `lines ${when}`, gainedBefore == null ? null : gained - gainedBefore),
    tile("Written", fmt(now.written), `translations ${when}`, now.written - before.written),
    tile("Active people", fmt(now.people), `wrote, reviewed or added notes ${when}`, now.people - before.people),
    tile("Waiting for review", fmt(c.review), dash.oldWaiting
      ? `${fmt(dash.oldWaiting)} suggestion${dash.oldWaiting > 1 ? "s" : ""} waiting more than a week`
      : "nothing waiting more than a week"),
    tile("Untranslated", fmt(c.untranslated), "lines"),
  );
}

// ---------- dashboard: charts (plain SVG) ----------
const SVGNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

/** A y scale from 0 with about four round steps (whole numbers only: these are counts). */
function niceScale(top) {
  const raw = Math.max(top, 1) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw));
  const n = Math.max(1, Math.ceil(top / step));
  return { max: step * n, ticks: Array.from({ length: n + 1 }, (_, i) => i * step) };
}

/** A column with a 4px rounded top, square at the baseline. */
function colPath(x, y, w, h) {
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** points: [{week, label, value}], oldest first. kind: "line" | "columns". */
function drawChart(box, points, kind, describe) {
  box.textContent = "";
  const W = Math.max(box.clientWidth, 260), H = 210;
  const m = { t: 18, r: kind === "line" ? 48 : 12, b: 26, l: 40 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const { max, ticks } = niceScale(Math.max(...points.map((p) => p.value)));
  const y = (v) => m.t + ih - (v / max) * ih;
  const band = iw / points.length;
  const x = (i) => m.l + band * (i + 0.5);
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H }, box);

  for (const t of ticks) {
    if (t) svg("line", { class: "grid", x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }, s);
    svg("text", { class: "axis", x: m.l - 8, y: y(t) + 4, "text-anchor": "end" }, s).textContent = compact(t);
  }
  const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(iw / 58))));
  points.forEach((p, i) => {
    if ((points.length - 1 - i) % every) return;
    svg("text", { class: "axis", x: x(i), y: H - 8, "text-anchor": "middle" }, s).textContent = p.label;
  });

  const sel = points.findIndex((p) => p.week === dashWeek);
  if (kind === "line") {
    const d = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join("");
    svg("path", { class: "area", d: `${d}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z` }, s);
    svg("path", { class: "line", d }, s);
    const last = points.length - 1;
    if (sel >= 0 && sel !== last) svg("circle", { class: "dot", cx: x(sel), cy: y(points[sel].value), r: 4 }, s);
    svg("circle", { class: "dot", cx: x(last), cy: y(points[last].value), r: 4 }, s);
    svg("text", { class: "value", x: x(last) + 9, y: y(points[last].value) + 4 }, s).textContent = compact(points[last].value);
  } else {
    const bw = Math.min(24, band - 6);
    points.forEach((p, i) => {
      const h = y(0) - y(p.value);
      if (h > 0) svg("path", { class: "col" + (i === sel ? " sel" : ""), d: colPath(x(i) - bw / 2, y(p.value), bw, h) }, s);
    });
    if (sel >= 0) {
      svg("text", { class: "value", x: x(sel), y: y(points[sel].value) - 6, "text-anchor": "middle" }, s)
        .textContent = compact(points[sel].value);
    }
  }
  svg("line", { class: "baseline", x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }, s);

  // hover and keyboard focus: one band per week, the whole height of the plot
  const tip = el("div", "chart-tip");
  tip.hidden = true;
  box.append(tip);
  const cross = kind === "line" ? svg("line", { class: "cross", y1: m.t, y2: y(0), visibility: "hidden" }, s) : null;
  points.forEach((p, i) => {
    const hit = svg("rect", { class: "hit", x: m.l + band * i, y: m.t, width: band, height: ih, tabindex: 0,
                              role: "img", "aria-label": describe(p, i).replace(/\n/g, ", ") }, s);
    const show = () => {
      tip.textContent = describe(p, i);
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(x(i), 90), W - 90)}px`;
      tip.style.top = `${y(p.value) - 10}px`;
      if (cross) { cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible"); }
    };
    const hide = () => { tip.hidden = true; cross?.setAttribute("visibility", "hidden"); };
    hit.addEventListener("mouseenter", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("mouseleave", hide);
    hit.addEventListener("blur", hide);
    hit.addEventListener("click", () => pickWeek(p.week));
  });
}

function renderCharts() {
  const weeks = dash.weeks.slice(1);
  const total = Number(dash.progress[0]?.total || 0);
  const pct = (n) => (total ? ` (${Math.floor(100 * n / total)}%)` : "");
  $("#chart-progress-sub").textContent = `Out of ${fmt(total)} lines, at the end of each week. Click a week for its report.`;
  drawChart($("#chart-progress"), weeks.map((w) => ({ week: w, label: shortDate(dayOf(w)), value: approvedBy(w) })), "line",
    (p) => `${weekRange(p.week)}\n${fmt(p.value)} lines approved${pct(p.value)}\n+${fmt(approvedIn(p.week))} that week`);
  drawChart($("#chart-written"), weeks.map((w) => ({ week: w, label: shortDate(dayOf(w)), value: weekTotals(w).written })), "columns",
    (p) => {
      const t = weekTotals(p.week);
      return `${weekRange(p.week)}\n${fmt(t.written)} written by ${t.people} ${t.people === 1 ? "person" : "people"}\n${plural(t.reviewed, "review")} · ${plural(t.notes, "note")}`;
    });

  const t = $("#weeks-table");
  t.textContent = "";
  const head = el("tr");
  for (const [h, c] of [["Week", ""], ["Lines approved", "num"], ["New that week", "num"], ["Written", "num"],
                        ["Reviews", "num"], ["Notes", "num"], ["Active people", "num"]]) head.append(el("th", c, h));
  t.append(head);
  for (const w of weeks.slice().reverse()) {
    const s = weekTotals(w);
    const tr = el("tr");
    tr.append(el("td", "", weekRange(w)));
    for (const v of [approvedBy(w), approvedIn(w), s.written, s.reviewed, s.notes, s.people]) tr.append(el("td", "num", fmt(v)));
    t.append(tr);
  }
}

// ---------- dashboard: the weekly report ----------
async function loadReport(token = dashToken) {
  const w = dashWeek;
  const scenes = await must(sb.rpc("week_scenes", { p_project: project.id, p_week: w, p_tz: TZ }));
  if (token !== dashToken || w !== dashWeek) return;
  dash.scenes = scenes;
  renderReport();
}

/** Who did what in the chosen week; people who were active the week before show up too, with nothing. */
function weekPeople(w) {
  const p = prevWeek(w);
  const rows = dash.activity.filter((r) => r.week === w);
  const names = [...new Set([...rows, ...dash.activity.filter((r) => r.week === p)].map((r) => r.name))];
  return names.map((name) => {
    const r = rows.find((x) => x.name === name) || {};
    const b = dash.activity.find((x) => x.week === p && x.name === name) || {};
    const o = { name, before: Number(b.written || 0) };
    for (const k of KINDS) o[k] = Number(r[k] || 0);
    return o;
  }).sort((a, b) => b.written + b.reviewed - (a.written + a.reviewed) || a.name.localeCompare(b.name));
}

function sceneNow(s) {
  const st = stats.find((x) => x.grp === s.grp && x.scene === s.scene);
  if (!st) return "";
  return sceneState(st) === "complete" ? "✓ complete" : `${st.done}/${st.total}`;
}

function reportSummary(w) {
  const t = weekTotals(w), b = weekTotals(prevWeek(w));
  const c = sum(stats);
  const diff = t.written - b.written;
  return `${t.people} ${t.people === 1 ? "person" : "people"} wrote ${plural(t.written, "translation")}` +
    ` (${diff >= 0 ? "+" : "−"}${fmt(Math.abs(diff))} vs. the week before), ${fmt(t.approved)} of theirs got approved,` +
    ` ${plural(t.reviewed, "review")} done, ${plural(t.notes, "note")}.` +
    ` Lines approved: ${fmt(approvedBy(prevWeek(w)))} → ${fmt(approvedBy(w))} of ${fmt(c.total)}.`;
}

function renderReport() {
  const w = dashWeek;
  $("#report-title").textContent = `Weekly report · ${weekRange(w)}${isThisWeek(w) ? " (so far)" : ""}`;
  $("#report-summary").textContent = reportSummary(w);

  const t = $("#week-people");
  t.textContent = "";
  const people = weekPeople(w);
  if (!people.length) {
    t.append(el("caption", "empty", "Nobody worked on this project that week."));
  } else {
    const head = el("tr");
    for (const [h, c] of [["Name", ""], ["Written", "num"], ["Approved", "num"], ["Reviews", "num"], ["Notes", "num"]]) head.append(el("th", c, h));
    t.append(head);
    for (const r of people) {
      const tr = el("tr");
      tr.append(el("td", "", r.name || "?"));
      const written = el("td", "num", fmt(r.written));
      const d = r.written - r.before;
      if (d) written.append(el("span", "muted small", ` (${d > 0 ? "+" : "−"}${fmt(Math.abs(d))})`));
      written.title = `${fmt(r.before)} the week before`;
      tr.append(written);
      for (const k of ["approved", "reviewed", "notes"]) tr.append(el("td", "num", fmt(r[k])));
      t.append(tr);
    }
  }

  const s = $("#week-scenes");
  s.textContent = "";
  if (!dash.scenes.length) {
    s.append(el("caption", "empty", "No scene was worked on that week."));
    return;
  }
  const head = el("tr");
  for (const [h, c] of [["Scene", ""], ["Written", "num"], ["Approved", "num"], ["Now", "num"]]) head.append(el("th", c, h));
  s.append(head);
  for (const r of dash.scenes) {
    const tr = el("tr");
    const name = el("td");
    name.append(el("div", "", r.scene || "(no scene)"), el("div", "muted small", [r.grp, r.people.join(", ")].filter(Boolean).join(" · ")));
    tr.append(name, el("td", "num", fmt(r.written)), el("td", "num", fmt(r.approved)), el("td", "num", sceneNow(r)));
    s.append(tr);
  }
}

/** The weekly report as plain text, to paste into the team chat. */
function reportText() {
  const w = dashWeek, c = sum(stats);
  const out = [
    `Weekly report – ${project.name} – ${weekRange(w)}, ${dayOf(w).getFullYear()}${isThisWeek(w) ? " (so far)" : ""}`,
    "",
    reportSummary(w),
    `Now: ${progressText(c)}.`,
  ];
  const people = weekPeople(w).filter((r) => r.written || r.reviewed || r.notes || r.approved);
  if (people.length) {
    out.push("", "Who did what:");
    for (const r of people) out.push(`- ${r.name}: ${fmt(r.written)} written, ${fmt(r.approved)} approved, ${plural(r.reviewed, "review")}, ${plural(r.notes, "note")}`);
  }
  if (dash.scenes.length) {
    out.push("", "Where the work went:");
    for (const s of dash.scenes) {
      out.push(`- ${s.grp ? `${s.grp} › ` : ""}${s.scene || "(no scene)"}: ${fmt(s.written)} written, ${fmt(s.approved)} approved` +
        `${s.people.length ? ` (${s.people.join(", ")})` : ""}${sceneNow(s) ? ` – now ${sceneNow(s)}` : ""}`);
    }
  }
  if (dash.oldWaiting) out.push("", `${fmt(dash.oldWaiting)} suggestion${dash.oldWaiting > 1 ? "s have" : " has"} been waiting for review for more than a week.`);
  return out.join("\n");
}

async function copyReport() {
  if (!dash) return;
  const text = reportText();
  try {
    await navigator.clipboard.writeText(text);
    toast("Weekly report copied – paste it into the team chat.");
  } catch {
    const a = Object.assign(el("a"), { href: URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })),
                                       download: `weekly-report-${dashWeek}.txt` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast("Couldn't copy, so the report was saved as a text file.");
  }
}

function pickWeek(w) {
  if (!dash || w === dashWeek) return;
  dashWeek = w;
  $("#dash-week").value = w;
  renderTiles();
  renderCharts();
  renderHeat();
  renderReport();
  loadReport().catch((err) => toast(explain(err), true));
}

// ---------- dashboard: week by week, and everything so far ----------
function renderHeat() {
  const k = $("#heat-measure").value;
  const weeks = dash.weeks.slice(1);
  const rows = dash.activity.filter((r) => weeks.includes(r.week));
  const total = (name) => rows.filter((r) => r.name === name).reduce((t, r) => t + Number(r[k]), 0);
  const names = [...new Set(rows.map((r) => r.name))].filter((n) => total(n)).sort((a, b) => total(b) - total(a) || a.localeCompare(b));
  const top = Math.max(1, ...rows.map((r) => Number(r[k])));
  const t = $("#heat-table");
  t.textContent = "";
  if (!names.length) { t.append(el("caption", "empty", "Nothing in the last 12 weeks.")); return; }
  const head = el("tr");
  head.append(el("th", "", "Name"));
  for (const w of weeks) {
    const th = el("th", "num" + (w === dashWeek ? " sel" : ""), shortDate(dayOf(w)));
    th.title = weekRange(w);
    head.append(th);
  }
  head.append(el("th", "num", "Total"));
  t.append(head);
  for (const name of names) {
    const tr = el("tr");
    tr.append(el("td", "", name || "?"));
    for (const w of weeks) {
      const r = rows.find((x) => x.week === w && x.name === name);
      const v = r ? Number(r[k]) : 0;
      const td = el("td", "num cell" + (w === dashWeek ? " sel" : ""), v ? fmt(v) : "");
      if (v) td.style.background = `color-mix(in srgb, var(--accent) ${Math.round(10 + 50 * v / top)}%, transparent)`;
      td.title = `${name} · ${weekRange(w)}: ` + (r ? `${fmt(r.written)} written, ${fmt(r.approved)} approved, ${plural(r.reviewed, "review")}, ${plural(r.notes, "note")}` : "nothing");
      tr.append(td);
    }
    tr.append(el("td", "num", fmt(total(name))));
    t.append(tr);
  }
}

function renderContrib() {
  const rows = dash.people;
  const t = $("#people-table");
  t.textContent = "";
  if (!rows.length) { t.append(el("caption", "empty", "No translations yet.")); return; }
  const allApproved = rows.reduce((s, r) => s + Number(r.approved), 0);
  const widest = Math.max(1, ...rows.map((r) => Number(r.approved) + Number(r.waiting) + Number(r.not_used)));
  const head = el("tr");
  for (const [h, c] of [["Name", ""], ["", "bar-col"], ["Approved", "num"], ["Waiting", "num"], ["Not used", "num"],
                        ["Reviews", "num"], ["Notes", "num"], ["Share", "num"], ["Last active", ""]]) head.append(el("th", c, h));
  t.append(head);
  for (const r of rows) {
    const tr = el("tr");
    tr.append(el("td", "", r.name === "Imported" ? "Imported (no name)" : r.name || "?"));
    const barCell = el("td", "bar-col");
    const bar = el("div", "stack");
    const n = Number(r.approved) + Number(r.waiting) + Number(r.not_used);
    bar.style.width = `${100 * n / widest}%`;
    for (const [k, cls] of [["approved", "done"], ["waiting", "review"], ["not_used", "todo"]]) {
      if (Number(r[k])) bar.append(Object.assign(el("span", cls), { style: `flex-grow: ${Number(r[k])}` }));
    }
    bar.title = `${fmt(r.approved)} approved · ${fmt(r.waiting)} waiting · ${fmt(r.not_used)} not used`;
    barCell.append(bar);
    tr.append(barCell);
    for (const k of ["approved", "waiting", "not_used", "reviewed", "notes"]) tr.append(el("td", "num", fmt(r[k])));
    tr.append(el("td", "num", allApproved ? `${Math.round(100 * Number(r.approved) / allApproved)}%` : "–"),
      el("td", "muted", r.last_active ? timeAgo(r.last_active) : ""));
    t.append(tr);
  }
}

// ---------- wiring ----------
function init() {
  $("#login-form").addEventListener("submit", submitLogin);
  $("#login-toggle").addEventListener("click", (e) => { e.preventDefault(); setSignUpMode(!signUpMode); });
  $("#login-forgot").addEventListener("click", forgotPassword);
  $("#newpass-form").addEventListener("submit", saveNewPassword);
  $("#logout").addEventListener("click", () => sb.auth.signOut());
  $("#noaccess-out").addEventListener("click", () => sb.auth.signOut());
  $("#project-select").addEventListener("change", (e) => {
    const p = projects.find((x) => x.id === Number(e.target.value));
    if (p) openProject(p);
  });
  $("#group-select").addEventListener("change", () => {
    renderGroupStats();
    renderScenes();
    const g = $("#group-select").value;
    const first = stats.find((s) => s.grp === g && (s.untranslated || s.review)) || stats.find((s) => s.grp === g);
    if (first) openScene(first.grp, first.scene);
  });
  $("#scene-filter").addEventListener("input", renderScenes);
  $("#filter").addEventListener("change", () => { if (view) loadLines(); });
  let searchTimer;
  $("#search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = $("#search").value.trim();
      if (!project) return;
      if (!q) { if (view?.search) openScene(stats[0].grp, stats[0].scene); return; }
      view = { search: q };
      $("#crumb").textContent = "Search";
      $("#title").textContent = `“${q}”`;
      renderClaim();
      renderScenes();
      loadLines();
    }, 350);
  });
  $("#review-all").addEventListener("click", () => {
    view = { review: true };
    $("#crumb").textContent = "Whole project";
    $("#title").textContent = "Waiting for review";
    $("#search").value = "";
    renderClaim();
    renderScenes();
    loadLines();
  });
  $("#claim-btn").addEventListener("click", toggleClaim);
  $("#admin-btn").addEventListener("click", openAdmin);
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".tab-panel").forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
  }));
  $("#dash-btn").addEventListener("click", () => showDash($("#dash").hidden));
  $("#dash-week").addEventListener("change", (e) => pickWeek(e.target.value));
  $("#dash-copy").addEventListener("click", copyReport);
  $("#heat-measure").addEventListener("change", () => { if (dash) renderHeat(); });
  let resizeFrame;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { if (dash && !$("#dash").hidden) renderCharts(); });
  }).observe($("#dash-charts"));
  $("#invite-form").addEventListener("submit", invite);
  for (const id of ["#imp-csv", "#imp-cfg", "#imp-notes"]) $(id).addEventListener("change", prepareImport);
  $("#imp-go").addEventListener("click", runImport);

  sb.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") {
      showOnly("#login");
      $("#login-form").hidden = true;
      $("#newpass-form").hidden = false;
      return;
    }
    if (event === "SIGNED_OUT") { me = null; if (channel) sb.removeChannel(channel); showOnly("#login"); return; }
    if (event === "SIGNED_IN" && !me) setTimeout(start, 0); // outside the auth callback (supabase-js advice)
  });
  start().catch((err) => { showOnly("#login"); $("#login-msg").textContent = explain(err); });
}

init();
