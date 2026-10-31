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
  if (/set_admin_power/i.test(m)) {
    return "Switching admin powers needs a database update: run docs/supabase/update-6-admin-power.sql in Supabase → SQL Editor.";
  }
  if (/need_my_vote|function public\.vote|p_unvoted/i.test(m)) {
    return "Voting isn't set up yet: the admin runs docs/supabase/update-5-votes.sql in Supabase → SQL Editor.";
  }
  if (/reply_to/i.test(m)) {
    return "Replies aren't set up yet: the admin runs docs/supabase/update-4-replies-review-tabs.sql in Supabase → SQL Editor.";
  }
  if (/messages|mark_read/i.test(m) && /schema cache|does not exist|could not find/i.test(m)) {
    return "Messages aren't set up yet: the admin runs docs/supabase/update-3-welcome-messages.sql in Supabase → SQL Editor.";
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

/** The admin with their admin powers on (they can switch them off and act like everyone else). */
function actingAdmin() { return !!me?.is_admin && me.admin_active !== false; }

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
  $("#me-name").textContent = me.display_name;
  $("#me-email").textContent = me.email;
  renderPower();
  setView("home", false);
  showOnly("#app");
  await Promise.all([loadProjects(), loadInbox()]);
  renderPower(); // the avatar's colour needs the team
  subscribeInbox();
  setView("home");
}

// ---------- pages: welcome, translating, dashboard, messages ----------
const VIEWS = { home: "#home", translate: ".layout", dash: "#dash", inbox: "#inbox" };
let current = null;       // the page on screen

function setView(name, render = true) {
  if ((name === "translate" || name === "dash") && !project) {
    toast(me.is_admin ? "Import a game file first (Admin → Projects)." : "The admin hasn't added a game file yet.");
    name = "home";
  }
  current = name;
  for (const [k, sel] of Object.entries(VIEWS)) $(sel).hidden = k !== name;
  $("#app").dataset.view = name;
  for (const b of $$(".nav [data-go]")) b.classList.toggle("active", b.dataset.go === name);
  document.title = name === "translate" || name === "dash" ? `${project.name} · Team Translation` : "Team Translation";
  if (!render) return;
  if (name === "home") renderHome().catch((err) => toast(explain(err), true));
  if (name === "dash") loadDash().catch((err) => toast(explain(err), true));
  if (name === "inbox") renderInbox();
}

// ---------- a newer version of the site ----------
// An open tab keeps running the code it loaded. When the site is updated, offer a reload, so nobody
// keeps using buttons the database no longer accepts.
const SITE_FILES = ["./", "app.js", "style.css", "csv.js", "config.js"];
let loadedTag = null;     // app.js as this tab loaded it (its ETag or Last-Modified)

function tagOf(r) { return r.ok ? r.headers.get("etag") || r.headers.get("last-modified") : null; }

async function checkForUpdate() {
  try {
    if (loadedTag == null) {
      loadedTag = tagOf(await fetch("app.js", { cache: "force-cache" })); // the copy this tab most likely runs
      if (loadedTag == null) return;
    }
    const now = tagOf(await fetch("app.js", { method: "HEAD", cache: "no-store" }));
    if (now && now !== loadedTag) $("#update-bar").hidden = false;
  } catch { /* offline: try again later */ }
}

async function reloadSite() {
  $("#update-reload").disabled = true;
  try { await Promise.all(SITE_FILES.map((f) => fetch(f, { cache: "reload" }))); } catch { /* reload anyway */ }
  location.reload();
}

// ---------- the admin's power switch ----------
function renderPower() {
  const on = actingAdmin();
  const b = $("#power-btn");
  b.hidden = !me.is_admin;
  b.setAttribute("aria-checked", String(on));
  b.title = on ? "On: you approve directly and manage the team. Off: you translate and vote like everyone else."
               : "Off: you translate and vote like everyone else. Switch on to approve directly and manage the team.";
  const role = me.is_admin ? (on ? "Admin" : "Admin · powers off") : me.can_review ? "Translator · can vote" : "Translator";
  $("#me-role").textContent = role;
  const av = $("#me-avatar");
  av.className = `avatar p${colorSlot(me.display_name)}`;
  av.textContent = initials(me.display_name);
  $("#me-btn").classList.toggle("admin-on", on);
  $("#me-btn").title = `${me.display_name} · ${role}`;
  $("#admin-btn").hidden = !on;
  $("#dash-btn").hidden = !on;
}

// ---------- the account menu ----------
function toggleMenu(open = $("#me-menu").hidden) {
  $("#me-menu").hidden = !open;
  $("#me-btn").setAttribute("aria-expanded", String(open));
  if (open) $("#me-menu .menu-item:not([hidden])")?.focus();
}

async function togglePower() {
  const on = !actingAdmin();
  const b = $("#power-btn");
  b.disabled = true;
  try {
    await must(sb.rpc("set_admin_power", { p_on: on }));
    me.admin_active = on;
    const mine = people.find((p) => p.id === me.id);
    if (mine) mine.admin_active = on;
    renderPower();
    if (!on && $("#admin").open) $("#admin").close();
    if (!on && current === "dash") setView("home");
    else if (current === "home") renderHome().catch(() => {});
    if (current === "translate" && view) {
      if (view.review) await loadReviewQueue();
      await loadLines();
    }
    toggleMenu(false);
    toast(on ? "Admin powers on – you can approve directly again." : "Admin powers off – you now translate and vote like everyone else.");
  } catch (err) {
    toast(explain(err), true);
  } finally {
    b.disabled = false;
  }
}

/** Open a project (and maybe one scene) on the translating page. */
async function goTranslate(p, grp, scene) {
  if (p && project?.id !== p.id) await openProject(p);
  setView("translate");
  if (scene != null && project) await openScene(grp, scene);
}

// ---------- projects, scenes ----------
async function loadProjects() {
  projects = await must(sb.from("projects").select("*").order("created_at"));
  const sel = $("#project-select");
  sel.textContent = "";
  for (const p of projects) sel.append(Object.assign(el("option", "", p.name), { value: p.id }));
  if (!projects.length) {
    project = null;
    if (current === "translate" || current === "dash") setView("home");
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
  if (current === "translate" || current === "dash") document.title = `${p.name} · Team Translation`;
  drafts = {};
  subscribe();
  await loadStats();
  if (current === "dash") loadDash().catch((err) => toast(explain(err), true));
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
  const text = progressText(c);
  $("#progress-pct").textContent = !c.total ? "" : !c.untranslated && !c.review ? "✓" : `${Math.floor(100 * c.done / c.total)}%`;
  $("#progress-pct").title = text;
  $("#progress").title = text;
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
  else if (view.review) {
    Object.assign(args, { p_state: "review", p_limit: 300 }, view.author ? { p_author: view.author } : {}, view.unvoted ? { p_unvoted: true } : {});
  }
  else Object.assign(args, { p_grp: view.grp, p_scene: view.scene });
  if (!view.review) $("#review-tabs").hidden = true;
  const asked = view;
  const box = $("#lines");
  box.textContent = "";
  box.append(el("p", "empty", "Loading…"));
  try {
    const got = await must(sb.rpc("get_lines", args));
    if (asked !== view) return; // another page of lines was asked for meanwhile
    lines = got;
  } catch (err) {
    box.textContent = "";
    box.append(el("p", "empty", explain(err)));
    return;
  }
  box.textContent = "";
  if (!lines.length) {
    box.append(el("p", "empty", view.search ? "Nothing found."
      : view.review ? (view.unvoted ? "Nothing is waiting for your vote. 🎉" : view.author ? `Nothing of ${view.author}'s is waiting for review.` : "Nothing is waiting for review.")
      : $("#filter").value ? "No lines like that here." : "This scene is empty."));
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
  const waitingFrom = [...new Set(l.versions.filter((v) => v.status === "pending").map((v) => v.author_name || "?"))];
  if (waitingFrom.length) {
    const flags = el("span", "waiting-from");
    flags.append("⚑ from ");
    for (const n of waitingFrom) flags.append(personChip(n));
    head.append(flags);
  }
  card.append(head);

  const src = el("p", "source");
  src.append(withTags(l.source));
  card.append(src);
  if (l.reference) card.append(el("p", "reference", l.reference));

  const approved = l.versions.find((v) => v.status === "approved");
  const main = el("div", "main" + (approved ? "" : " none"));
  if (approved) {
    const who = el("div", "who");
    who.append("✓ by ", personChip(approved.author_name || "?"),
      ` · approved by ${approved.decided_by_name || "?"} ${timeAgo(approved.decided_at)}`);
    main.append(el("div", "main-text", approved.text), who);
    if (approved.decided_by_name === "Team vote" && approved.votes?.length) main.append(voteRecord(approved));
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
  const box = el("div", `version ${v.status === "pending" ? "pending" : "old"} by p${colorSlot(v.author_name)}`);
  if (view.review && view.author && v.status === "pending") box.classList.add(v.author_name === view.author ? "focus" : "dim");
  const body = el("div", "version-body");
  body.append(el("div", "version-text", v.text));
  const label = { pending: "waiting for review", rejected: "not used", superseded: "replaced" }[v.status] || v.status;
  const who = el("div", "who muted");
  who.append(el("span", `chip ${v.status}`, label), " ", personChip(v.author_name || "?"), ` · ${timeAgo(v.created_at)}`);
  if (v.decided_by_name && v.status !== "pending") who.append(` · decided by ${v.decided_by_name}`);
  const problem = tagProblem(l.source, v.text);
  if (problem) who.append(el("span", "tag-warn", ` · ${problem}`));
  body.append(who);
  box.append(body);

  if (v.status === "pending") body.append(renderVotes(v));
  else if (v.decided_by_name === "Team vote" && v.votes?.length) body.append(voteRecord(v));

  const actions = el("div", "version-actions");
  const own = isOwn(v);
  const mayDecide = actingAdmin(); // everyone else votes
  if (v.status === "pending") {
    if (actingAdmin()) {
      const ok = el("button", "small primary", "✓ Approve");
      ok.type = "button";
      ok.title = "Approve now, without waiting for the vote";
      ok.addEventListener("click", () => decide(l, v, "approve_version"));
      const no = el("button", "small", "Not this one");
      no.type = "button";
      no.title = "Turn it down now, without waiting for the vote";
      no.addEventListener("click", () => decide(l, v, "reject_version"));
      actions.append(ok, no);
    } else if (canVoteOn(v)) {
      const mine = (v.votes || []).find((x) => x.voter === me.id);
      for (const [agree, label, done] of [[true, "👍 Agree", "👍 You agreed"], [false, "👎 Disagree", "👎 You disagreed"]]) {
        const pressed = mine?.agree === agree;
        const b = el("button", "small vote-btn" + (pressed ? (agree ? " voted-yes" : " voted-no") : agree ? " primary" : ""), pressed ? done : label);
        b.type = "button";
        b.setAttribute("aria-pressed", String(pressed));
        b.title = pressed ? "Click to take your vote back" : agree ? "This translation is good" : "This translation isn't right yet";
        b.addEventListener("click", () => castVote(l, v, pressed ? null : agree));
        actions.append(b);
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
    if (n.author === me.id || actingAdmin()) {
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

// ---------- voting: 2/3 of the people who can vote approve; the admin decides directly ----------
function isAuthorOf(v, p) {
  return v.imported ? (v.author_name || "").toLowerCase() === p.display_name.toLowerCase() : v.author === p.id;
}

/** Who may vote on this version: everyone who can vote, except the admin and its author. */
function votePool(v) {
  return people.filter((p) => (p.can_review || p.is_admin) && !(p.is_admin && p.admin_active !== false) && !isAuthorOf(v, p));
}

function canVoteOn(v) { return (me.can_review || me.is_admin) && !actingAdmin() && !isAuthorOf(v, me); }

function voteCount(v) {
  const pool = votePool(v);
  const ids = new Set(pool.map((p) => p.id));
  const counted = (v.votes || []).filter((x) => ids.has(x.voter));
  return { pool: pool.length, need: Math.ceil(pool.length * 2 / 3), yes: counted.filter((x) => x.agree), no: counted.filter((x) => !x.agree) };
}

function voterList(list, mark) {
  const s = el("span", "voters");
  for (const x of list) {
    const c = personChip(x.voter_name);
    c.prepend(el("span", "vote-mark", mark));
    s.append(c);
  }
  return s;
}

function renderVotes(v) {
  const c = voteCount(v);
  const box = el("div", "votes small");
  if (!c.pool) {
    box.append(el("span", "muted", "Nobody else can vote on this one – the admin decides."));
    return box;
  }
  const meter = el("span", "vote-meter");
  meter.setAttribute("role", "img");
  meter.setAttribute("aria-label", `${c.yes.length} of ${c.need} agree votes needed`);
  for (let i = 0; i < c.need; i++) meter.append(el("span", "pip" + (i < c.yes.length ? " yes" : "")));
  box.append(meter, el("span", "vote-text", `${c.yes.length} of ${c.need} agree needed (${c.pool} can vote)`));
  if (c.yes.length) box.append(voterList(c.yes, "👍"));
  if (c.no.length) box.append(voterList(c.no, "👎"));
  // say why there are no vote buttons, instead of leaving people guessing
  if (!actingAdmin() && !canVoteOn(v)) {
    box.append(el("span", "vote-why", isAuthorOf(v, me)
      ? "Your translation – the others vote on it."
      : "You can't vote yet – ask the admin to tick “can vote” for you (Admin → Team)."));
  }
  return box;
}

/** On a version the team voted on: who agreed and who didn't. */
function voteRecord(v) {
  const box = el("div", "votes small");
  const yes = v.votes.filter((x) => x.agree), no = v.votes.filter((x) => !x.agree);
  box.append(el("span", "muted", "Team vote:"));
  if (yes.length) box.append(voterList(yes, "👍"));
  if (no.length) box.append(voterList(no, "👎"));
  return box;
}

async function castVote(l, v, agree) {
  try {
    const result = await must(sb.rpc("vote", { p_id: v.id, p_agree: agree }));
    if (result === "approved") toast("That made 2/3 – the translation is approved. ✓");
    else if (result === "rejected") toast("Too many disagree now – that translation is turned down.");
    await refreshLines([l.id]);
    scheduleStats();
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

// ---------- review: everyone together, or one person at a time ----------
let reviewQueue = [];     // review_queue rows: who has how many lines waiting
let reviewQueueReady = true;
let myVotes = null;       // lines in this project waiting for my vote (null: I don't vote, or no update 5)
const VOTE_TAB = Symbol("needs my vote"); // the tab key for "Needs your vote" (never a person's name)

async function loadReviewQueue() {
  try {
    reviewQueue = await must(sb.rpc("review_queue", { p_project: project.id }));
    reviewQueueReady = true;
  } catch {
    reviewQueue = [];
    reviewQueueReady = false; // database without update 4: only the "Everyone" list
  }
  myVotes = null;
  if ((me.can_review || me.is_admin) && !actingAdmin()) {
    try {
      const rows = await must(sb.rpc("need_my_vote"));
      myVotes = Number(rows.find((r) => Number(r.project_id) === project.id)?.lines || 0);
    } catch { /* database without update 5 */ }
  }
  renderReviewTabs();
}

function renderReviewTabs() {
  const box = $("#review-tabs");
  box.hidden = !view?.review;
  if (box.hidden) return;
  box.textContent = "";
  const tab = (key, label, n, title) => {
    const on = key === VOTE_TAB ? !!view.unvoted : !view.unvoted && view.author === key;
    const b = el("button", "rtab" + (on ? " active" : "") + (key === VOTE_TAB ? " rtab-vote" : ""));
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(on));
    if (key && key !== VOTE_TAB) b.append(avatar(key));
    b.append(el("span", "", label), el("span", "rtab-count", fmt(n)));
    if (title) b.title = title;
    b.addEventListener("click", () => pickReviewer(key));
    box.append(b);
  };
  if (myVotes != null) tab(VOTE_TAB, "🗳 Needs your vote", myVotes, "Translations by others you haven't voted on yet");
  tab(null, "Everyone", sum(stats).review, "Every line waiting for review");
  const rows = reviewQueue.slice();
  if (view.author && !rows.some((r) => r.name === view.author)) rows.push({ name: view.author, lines: 0 });
  for (const r of rows) {
    tab(r.name, r.name === "Imported" ? "Imported (no name)" : r.name, Number(r.lines),
      r.oldest ? `${fmt(r.waiting)} translation${Number(r.waiting) === 1 ? "" : "s"} by ${r.name} waiting, the oldest from ${timeAgo(r.oldest)}` : "");
  }
  if (!reviewQueueReady) box.append(el("span", "hint", "One tab per person needs a database update (update-4-replies-review-tabs.sql)."));
}

function pickReviewer(name) {
  const unvoted = name === VOTE_TAB;
  view = { review: true, author: unvoted ? null : name, unvoted };
  $("#title").textContent = unvoted ? "Waiting for your vote" : name ? `Waiting for review · ${name}` : "Waiting for review";
  renderReviewTabs();
  loadLines();
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
    try { await loadStats(); renderClaim(); scheduleDash(); if (view?.review) await loadReviewQueue(); } catch { /* next change tries again */ }
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
    .on("postgres_changes", { event: "*", schema: "public", table: "votes", filter }, (payload) => {
      const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old || {};
      const lineId = row.line_id || lines.find((l) => l.versions.some((v) => v.id === row.version_id))?.id;
      if (lineId && lines.some((l) => l.id === lineId)) refreshLines([lineId], row.voter !== me.id).catch(() => {});
      scheduleStats();
    })
    .subscribe();
}

// ---------- welcome page ----------
async function count(query) {
  const { count: n, error } = await query;
  if (error) throw error;
  return n || 0;
}

function mondayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString();
}

/** Progress of every project: one call, or one per project on a database without update 3. */
async function projectProgress() {
  try {
    return await must(sb.rpc("project_progress"));
  } catch {
    return Promise.all(projects.map(async (p) => ({ project_id: p.id, ...sum(await must(sb.rpc("scene_stats", { p_project: p.id }))) })));
  }
}

function pctDone(c) { return c.total ? Math.floor(100 * c.done / c.total) : 0; }
function isComplete(c) { return c.total > 0 && !c.untranslated && !c.review; }

function progressBar(c, label) {
  const bar = el("div", "progress big");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(pctDone(c)));
  bar.setAttribute("aria-label", label);
  const done = el("span", "bar done"), review = el("span", "bar review");
  done.style.width = c.total ? `${100 * c.done / c.total}%` : "0";
  review.style.width = c.total ? `${100 * c.review / c.total}%` : "0";
  bar.append(done, review);
  return bar;
}

function progressLegend(c) {
  const lg = el("div", "legend small");
  for (const [cls, n, text] of [["done", c.done, "approved"], ["review", c.review, "waiting for review"], ["todo", c.untranslated, "untranslated"]]) {
    const s = el("span");
    s.append(el("i", `sw ${cls}`), `${fmt(n)} ${text}`);
    lg.append(s);
  }
  return lg;
}

function bigPercent(c) {
  const box = el("div", "big-pct");
  box.append(el("span", "big-pct-value", isComplete(c) ? "✓ 100%" : `${pctDone(c)}%`), el("span", "muted", isComplete(c) ? "complete" : "finished"));
  return box;
}

// ---------- welcome: where you are, and how long the project has been running ----------
/** "Western Indonesia Time · Jakarta, Asia · GMT+7 · 14:32" for the viewer's own time zone. */
function timeZoneText(now = new Date()) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const zoneName = (style) => new Intl.DateTimeFormat(undefined, { timeZoneName: style })
    .formatToParts(now).find((p) => p.type === "timeZoneName")?.value || "";
  const long = zoneName("long"), offset = zoneName("shortOffset");
  const [region, ...rest] = tz.split("/");
  const place = rest.length ? `${rest.reverse().join(", ").replace(/_/g, " ")}, ${region}` : tz;
  const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return [/^GMT|^UTC/.test(long) ? "" : long, place, offset, time].filter(Boolean).join(" · ");
}

/** When the project started: the repository's first commit (config.js), else the first project on the site. */
function projectStart() {
  const set = window.SITE?.started ? new Date(window.SITE.started) : null;
  if (set && !isNaN(set)) return { at: set, what: "the project's first commit" };
  const first = projects.map((p) => p.created_at).sort()[0];
  return first ? { at: new Date(first), what: "the first game file on this site" } : null;
}

function renderClock() {
  const start = projectStart();
  $("#project-clock").hidden = !start;
  if (!start) return;
  let left = Math.max(0, Math.floor((Date.now() - start.at) / 1000));
  const box = $("#clock-value");
  box.textContent = "";
  for (const [one, many, size, pad] of [["year", "years", 365 * 86400, false], ["day", "days", 86400, false],
                                        ["hour", "hours", 3600, true], ["minute", "minutes", 60, true], ["second", "seconds", 1, true]]) {
    const n = Math.floor(left / size);
    left -= n * size;
    if (one === "year" && !n) continue; // years only once there is one
    const unit = el("span", "clock-unit");
    unit.append(el("span", "clock-num", pad ? String(n).padStart(2, "0") : String(n)), el("span", "clock-name", n === 1 ? one : many));
    box.append(unit);
  }
  box.setAttribute("aria-label", `${box.innerText.replace(/\n/g, " ")}`);
  $("#clock-since").textContent = `since ${start.at.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} – ${start.what}`;
}

function tickHome() {
  if (current !== "home" || document.hidden || !me) return;
  $("#home-tz").textContent = `🌏 ${timeZoneText()}`;
  renderClock();
}

async function renderHome() {
  const h = new Date().getHours();
  $("#home-hello").textContent = `${h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}, ${me.display_name}`;
  $("#home-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  tickHome();
  renderHomeMessages();
  const cards = $("#home-projects");
  if (!projects.length) {
    $("#home-overall").hidden = true;
    $("#home-tiles").textContent = "";
    cards.textContent = "";
    const empty = el("section", "card project-card");
    empty.append(el("h3", "", "No project yet"), el("p", "hint", me.is_admin
      ? "Open Admin → Projects → Import a game file to start."
      : "The admin hasn't added a game file yet. You can already write to the team under Messages."));
    cards.append(empty);
    return;
  }
  const reviewer = me.can_review || me.is_admin;
  const voter = reviewer && !actingAdmin();
  const [prog, myClaims, waiting, toReview, thisWeek, voteRows] = await Promise.all([
    projectProgress(),
    must(sb.from("claims").select("*").eq("user_id", me.id)),
    count(sb.from("versions").select("id", { count: "exact", head: true }).eq("author", me.id).eq("status", "pending")),
    reviewer ? count(sb.from("versions").select("id", { count: "exact", head: true }).eq("status", "pending")
      .or(`author.is.null,author.neq.${me.id}`)) : Promise.resolve(null),
    count(sb.from("versions").select("id", { count: "exact", head: true }).eq("author", me.id).gte("created_at", mondayISO())),
    voter ? sb.rpc("need_my_vote").then(({ data, error }) => (error ? null : data)) : Promise.resolve(null),
  ]);
  if (current !== "home") return;
  const of = (p) => {
    const r = prog.find((x) => Number(x.project_id) === p.id) || {};
    return { total: Number(r.total || 0), done: Number(r.done || 0), review: Number(r.review || 0), untranslated: Number(r.untranslated || 0) };
  };

  // all projects together (only worth showing when there are several)
  const overall = $("#home-overall");
  overall.hidden = projects.length < 2;
  overall.textContent = "";
  if (projects.length > 1) {
    const all = projects.map(of).reduce((t, c) => ({ total: t.total + c.total, done: t.done + c.done, review: t.review + c.review,
                                                     untranslated: t.untranslated + c.untranslated }), { total: 0, done: 0, review: 0, untranslated: 0 });
    const head = el("div", "pc-head");
    head.append(el("h3", "", "All projects"), el("span", "muted small", `${fmt(all.total)} lines`));
    overall.append(head, bigPercent(all), progressBar(all, "All projects finished"), progressLegend(all));
  }

  cards.textContent = "";
  for (const p of projects) {
    const c = of(p);
    const card = el("section", "card project-card" + (project?.id === p.id ? " current" : ""));
    const head = el("div", "pc-head");
    head.append(el("h3", "", p.name), el("span", "muted small", `into ${p.target_label} · ${fmt(c.total)} lines`));
    card.append(head, bigPercent(c), progressBar(c, `${p.name} finished`), progressLegend(c));
    const claimsHere = myClaims.filter((x) => Number(x.project_id) === p.id);
    if (claimsHere.length) {
      const on = el("div", "pc-claims small");
      on.append("✋ You're on ");
      claimsHere.forEach((x, i) => {
        const b = el("button", "link", x.scene || "(no scene)");
        b.type = "button";
        b.title = x.grp;
        b.addEventListener("click", () => goTranslate(p, x.grp, x.scene));
        on.append(i ? ", " : "", b);
      });
      card.append(on);
    }
    const actions = el("div", "pc-actions");
    const go = el("button", "primary", isComplete(c) ? "Open" : project?.id === p.id ? "Continue translating" : "Start translating");
    go.type = "button";
    go.addEventListener("click", () => goTranslate(p));
    actions.append(go);
    if (c.review && reviewer) {
      const rv = el("button", "", `⚑ Review (${fmt(c.review)})`);
      rv.type = "button";
      rv.addEventListener("click", async () => { await goTranslate(p); $("#review-all").click(); });
      actions.append(rv);
    }
    card.append(actions);
    cards.append(card);
  }

  const tiles = $("#home-tiles");
  tiles.textContent = "";
  tiles.append(
    tile("You wrote this week", fmt(thisWeek), "translations since Monday"),
    tile("Yours, waiting for review", fmt(waiting), waiting ? "someone else will check them" : "nothing waiting"),
  );
  if (voteRows) {
    const here = Number(voteRows.find((r) => Number(r.project_id) === project?.id)?.lines || 0);
    const all = voteRows.reduce((t, r) => t + Number(r.lines), 0);
    tiles.append(clickable(tile("Needs your vote", fmt(all), all ? "👍 or 👎 on others' translations · open the list" : "you've voted on everything"), async () => {
      await goTranslate(project);
      $("#review-all").click();
      if (here) pickReviewer(VOTE_TAB);
    }));
  } else if (toReview != null) {
    tiles.append(clickable(tile("Waiting for your review", fmt(toReview), "translations by others · open the list"), async () => {
      await goTranslate(project);
      $("#review-all").click();
    }));
  }
  const unread = unreadCount();
  tiles.append(clickable(tile("Unread messages", dmReady ? fmt(unread) : "–",
    dmReady ? (unread ? "open Messages to read them" : "you're all caught up") : "not set up yet"), () => setView("inbox")));
}

function clickable(box, action) {
  box.classList.add("clickable");
  box.tabIndex = 0;
  box.setAttribute("role", "button");
  box.addEventListener("click", action);
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); action(); } });
  return box;
}

// ---------- people: a colour and initials for everyone ----------
let people = [];          // everyone on the team (me too), in the order they joined: that order picks their colour
let team = [];            // everyone else, by name

async function loadPeople() {
  people = await must(sb.from("profiles").select("*").order("created_at"));
  team = people.filter((p) => p.id !== me.id).sort((a, b) => a.display_name.localeCompare(b.display_name));
}

/** Colour slot 1-8 for a name: teammates by joining order, other (imported) names by a hash; 0 = no person. */
function colorSlot(name) {
  if (!name || name === "?" || name === "Imported") return 0;
  const i = people.findIndex((p) => p.display_name.toLowerCase() === name.toLowerCase());
  if (i >= 0) return (i % 8) + 1;
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return ((people.length + h) % 8) + 1;
}

function initials(name) {
  const words = (name || "?").trim().split(/\s+/).filter(Boolean);
  const chars = (w) => [...w];
  if (words.length > 1) return (chars(words[0])[0] + chars(words[1])[0]).toUpperCase();
  return chars(words[0] || "?").slice(0, 2).join("").toUpperCase();
}

function avatar(name) {
  const a = el("span", `avatar p${colorSlot(name)}`, initials(name));
  a.title = name || "?";
  a.setAttribute("aria-hidden", "true");
  return a;
}

/** A person's colour, initials and name together - colour is never the only thing telling people apart. */
function personChip(name) {
  const c = el("span", "person-chip");
  c.append(avatar(name), el("span", "", name || "?"));
  return c;
}

// ---------- direct messages ----------
let inbox = [];           // my recent messages (sent and received), newest first
const logs = new Map();   // person id -> that conversation, oldest first
const loadedLogs = new Set(); // conversations fetched in full
const extraMsgs = new Map();  // older messages fetched only because a reply quotes them
const chatDrafts = new Map(); // person id -> text typed but not sent yet
let chatWith = null;      // person id of the open conversation
let replyTo = null;       // the message being answered
let dmChannel = null;
let dmReady = false;      // false: the messages couldn't be loaded (e.g. the database lacks update 3)
let dmError = "";
let tmpSeq = 0;

async function loadInbox() {
  logs.clear();
  loadedLogs.clear();
  extraMsgs.clear();
  try { await loadPeople(); } catch { people = []; team = []; }
  try {
    inbox = await must(sb.from("messages").select("*").order("created_at", { ascending: false }).limit(500));
    dmReady = true;
  } catch (err) {
    inbox = [];
    dmReady = false;
    dmError = explain(err);
  }
  renderUnread();
}

function otherOf(m) { return m.sender === me.id ? m.recipient : m.sender; }

/** The conversation with one person, oldest first (built from the inbox until it's fetched in full). */
function logOf(id) {
  if (!logs.has(id)) logs.set(id, inbox.filter((m) => otherOf(m) === id).reverse());
  return logs.get(id);
}

function findMsg(id) {
  for (const log of logs.values()) { const m = log.find((x) => x.id === id); if (m) return m; }
  return inbox.find((x) => x.id === id) || extraMsgs.get(id);
}

async function fetchReplyTargets(list) {
  const ids = [...new Set(list.filter((m) => m.reply_to && !findMsg(m.reply_to)).map((m) => m.reply_to))];
  if (!ids.length) return;
  for (const m of await must(sb.from("messages").select("*").in("id", ids))) extraMsgs.set(m.id, m);
}

function unreadCount(from) {
  return inbox.filter((m) => m.recipient === me.id && !m.read_at && (!from || m.sender === from)).length;
}

function renderUnread() {
  const n = dmReady ? unreadCount() : 0;
  $("#unread").textContent = n > 99 ? "99+" : String(n);
  $("#unread").hidden = !n;
}

/** Everyone on the team, the ones I talked to most recently first. */
function conversations() {
  return team.map((p) => ({ p, last: inbox.find((m) => otherOf(m) === p.id), unread: unreadCount(p.id) }))
    .sort((a, b) => (b.last?.created_at || "").localeCompare(a.last?.created_at || "") || a.p.display_name.localeCompare(b.p.display_name));
}

function personButton({ p, last, unread }, onClick) {
  const b = el("button", "person" + (p.id === chatWith ? " active" : "") + (unread ? " unread" : ""));
  b.type = "button";
  b.dataset.id = p.id;
  const text = el("span", "person-text");
  const top = el("span", "person-top");
  top.append(el("span", "person-name", p.display_name));
  if (unread) top.append(el("span", "badge", String(unread)));
  else if (last) top.append(el("span", "muted small", timeAgo(last.created_at)));
  const preview = last ? `${last.sender === me.id ? "You: " : ""}${last.reply_to ? "↩ " : ""}${last.body}` : "No messages yet";
  text.append(top, el("span", "person-last small", last?.failed ? "⚠ Not sent" : preview));
  b.append(avatar(p.display_name), text);
  b.addEventListener("click", onClick);
  return b;
}

function renderHomeMessages() {
  const box = $("#home-messages");
  box.textContent = "";
  if (!dmReady) { box.append(el("p", "hint", dmError)); return; }
  const recent = conversations().filter((c) => c.last).slice(0, 4);
  if (!recent.length) {
    box.append(el("p", "hint", team.length ? "No messages yet – open Messages to write to someone on the team." : "Nobody else is on the team yet."));
    return;
  }
  for (const c of recent) box.append(personButton(c, () => { setView("inbox"); openChat(c.p.id); }));
}

function renderInbox() {
  renderPeopleList();
  renderChat();
  renderReplyBar();
}

function renderPeopleList() {
  const list = $("#people-list");
  list.textContent = "";
  if (!dmReady) { list.append(el("p", "empty", dmError)); return; }
  if (!team.length) list.append(el("p", "empty", "Nobody else is on the team yet."));
  for (const c of conversations()) list.append(personButton(c, () => openChat(c.p.id)));
}

async function openChat(id) {
  if (chatWith) chatDrafts.set(chatWith, $("#chat-input").value);
  chatWith = id;
  replyTo = null;
  $("#inbox").classList.add("chatting");
  $("#chat-input").value = chatDrafts.get(id) || "";
  renderInbox(); // shows what is already here at once; the full history follows
  if (matchMedia("(min-width: 761px)").matches) $("#chat-input").focus();
  if (unreadCount(id)) markRead(id);
  if (loadedLogs.has(id)) return;
  try {
    const rows = await must(sb.from("messages").select("*")
      .or(`and(sender.eq.${me.id},recipient.eq.${id}),and(sender.eq.${id},recipient.eq.${me.id})`)
      .order("created_at", { ascending: false }).limit(300));
    loadedLogs.add(id);
    const log = logOf(id);
    const known = new Set(log.map((m) => m.id));
    for (const m of rows) if (!known.has(m.id)) log.push(m);
    log.sort((a, b) => a.created_at.localeCompare(b.created_at));
    await fetchReplyTargets(log);
    if (chatWith === id) renderChat();
  } catch (err) {
    toast(explain(err), true);
  }
}

function closeChat() {
  if (chatWith) chatDrafts.set(chatWith, $("#chat-input").value);
  chatWith = null;
  replyTo = null;
  $("#inbox").classList.remove("chatting");
  renderInbox();
}

/** Marks what that person sent me as read: here at once, in the database right after. */
function markRead(from) {
  const now = new Date().toISOString();
  for (const m of inbox) if (m.sender === from && m.recipient === me.id && !m.read_at) m.read_at = now;
  for (const m of logs.get(from) || []) if (m.sender === from && !m.read_at) m.read_at = now;
  renderUnread();
  if (current === "inbox") renderPeopleList();
  if (current === "home") renderHomeMessages();
  sb.rpc("mark_read", { p_from: from }).then(() => {}, () => {});
}

function msgDay(m) {
  return new Date(m.created_at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function renderChat() {
  const p = team.find((x) => x.id === chatWith);
  const head = $("#chat-with");
  head.textContent = "";
  if (p) head.append(avatar(p.display_name), p.display_name);
  else head.textContent = "Messages";
  $("#chat-form").hidden = !p;
  $("#chat-new").hidden = true;
  const box = $("#chat-log");
  box.textContent = "";
  if (!p) {
    if (dmReady && team.length) box.append(el("p", "empty", "Pick someone to write to them."));
    return;
  }
  const log = logOf(p.id);
  if (!log.length) box.append(el("p", "empty", `No messages with ${p.display_name} yet. Say hello!`));
  let day = "";
  for (const m of log) {
    if (msgDay(m) !== day) { day = msgDay(m); box.append(el("div", "chat-day muted small", day)); }
    box.append(bubbleEl(m));
  }
  updateSeen();
  box.scrollTop = box.scrollHeight;
}

function bubbleEl(m) {
  const mine = m.sender === me.id;
  const row = el("div", "msg" + (mine ? " mine" : "") + (m.pending ? " sending" : "") + (m.failed ? " failed" : ""));
  row.dataset.id = m.id;
  const bubble = el("div", "bubble");
  if (m.reply_to) bubble.append(quoteEl(m.reply_to));
  bubble.append(el("div", "bubble-text", m.body));
  const foot = el("div", "msg-foot small");
  const meta = el("span", "msg-meta muted");
  meta.textContent = m.pending ? "Sending…" : m.failed ? "⚠ Not sent"
    : new Date(m.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  meta.title = new Date(m.created_at).toLocaleString();
  foot.append(meta);
  if (m.failed) {
    const retry = el("button", "link small", "Try again");
    retry.type = "button";
    retry.addEventListener("click", () => deliver(m));
    foot.append(retry);
  } else if (!m.pending) {
    const reply = el("button", "msg-reply link small", "↩ Reply");
    reply.type = "button";
    reply.addEventListener("click", () => startReply(m));
    foot.append(reply);
  }
  row.append(bubble, foot);
  return row;
}

function quoteEl(id) {
  const q = findMsg(id);
  const b = el("button", "quote");
  b.type = "button";
  b.append(el("span", "quote-who", q ? (q.sender === me.id ? "You" : q.sender_name) : "Earlier message"),
    el("span", "quote-text", q ? q.body : "(not loaded)"));
  b.title = "Show that message";
  b.addEventListener("click", () => {
    const row = $(`#chat-log .msg[data-id="${id}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("flash");
    void row.offsetWidth; // restart the animation
    row.classList.add("flash");
  });
  return b;
}

/** "· seen" under the last message of mine the other person has read. */
function updateSeen() {
  const box = $("#chat-log");
  for (const s of $$(".seen", box)) s.remove();
  const last = logOf(chatWith).filter((m) => m.sender === me.id && m.read_at).pop();
  const row = last && $(`.msg[data-id="${last.id}"] .msg-meta`, box);
  if (row) row.after(el("span", "seen muted", "· seen"));
}

function nearBottom(box) { return box.scrollHeight - box.scrollTop - box.clientHeight < 80; }

/** Adds one message to the open conversation without redrawing the rest. */
function appendMessage(m) {
  if (current !== "inbox" || chatWith !== otherOf(m)) return;
  const box = $("#chat-log");
  const stick = m.sender === me.id || nearBottom(box);
  $(".empty", box)?.remove();
  const log = logOf(chatWith);
  const before = log[log.indexOf(m) - 1];
  if (!before || msgDay(before) !== msgDay(m)) box.append(el("div", "chat-day muted small", msgDay(m)));
  box.append(bubbleEl(m));
  updateSeen();
  if (stick) box.scrollTop = box.scrollHeight;
  else $("#chat-new").hidden = false;
}

function redrawMessage(oldId, m) {
  const row = $(`#chat-log .msg[data-id="${oldId}"]`);
  if (row) row.replaceWith(bubbleEl(m));
  updateSeen();
  if (current === "inbox") renderPeopleList();
}

function startReply(m) {
  replyTo = m;
  renderReplyBar();
  $("#chat-input").focus();
}

function renderReplyBar() {
  const bar = $("#reply-bar");
  bar.hidden = !replyTo || !chatWith;
  if (bar.hidden) return;
  $(".quote-who", bar).textContent = `Replying to ${replyTo.sender === me.id ? "yourself" : replyTo.sender_name}`;
  $(".quote-text", bar).textContent = replyTo.body;
}

/** Shows the message at once and sends it in the background, so typing never waits for the server. */
function sendMessage(e) {
  e.preventDefault();
  const input = $("#chat-input");
  const body = input.value.trim();
  if (!body || !chatWith) return;
  const to = chatWith;
  const m = { id: `tmp-${++tmpSeq}`, sender: me.id, sender_name: me.display_name, recipient: to, body,
              reply_to: replyTo?.id ?? null, created_at: new Date().toISOString(), read_at: null, pending: true };
  input.value = "";
  chatDrafts.delete(to);
  replyTo = null;
  renderReplyBar();
  logOf(to).push(m); // before the inbox, which logOf may be built from
  inbox.unshift(m);
  appendMessage(m);
  renderPeopleList();
  deliver(m);
}

async function deliver(m) {
  const oldId = m.id;
  if (m.failed) { m.failed = false; m.pending = true; redrawMessage(oldId, m); }
  const row = { recipient: m.recipient, body: m.body };
  if (m.reply_to) row.reply_to = m.reply_to;
  try {
    const saved = await must(sb.from("messages").insert(row).select().single());
    Object.assign(m, saved);
    delete m.pending;
  } catch (err) {
    m.pending = false;
    m.failed = true;
    toast(explain(err), true);
  }
  redrawMessage(oldId, m);
}

function subscribeInbox() {
  if (dmChannel) sb.removeChannel(dmChannel);
  dmChannel = null;
  if (!dmReady) return;
  dmChannel = sb.channel(`inbox-${me.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `recipient=eq.${me.id}` },
      (payload) => receive(payload.new))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter: `sender=eq.${me.id}` }, (payload) => {
      for (const list of [inbox, ...logs.values()]) {
        for (const m of list) if (m.id === payload.new.id) m.read_at = payload.new.read_at;
      }
      if (current === "inbox" && chatWith === payload.new.recipient) updateSeen();
    })
    .subscribe();
}

async function receive(m) {
  if (inbox.some((x) => x.id === m.id)) return;
  if (!people.some((p) => p.id === m.sender)) await loadPeople().catch(() => {});
  if (logs.has(m.sender)) logs.get(m.sender).push(m);
  inbox.unshift(m);
  if (m.reply_to) await fetchReplyTargets([m]).catch(() => {});
  if (current === "inbox" && chatWith === m.sender) {
    appendMessage(m);
    if (!document.hidden) markRead(m.sender);
  } else if (current !== "inbox") {
    // on the messages page the list shows it; a pop-up there would cover the message box
    toast(`✉ ${m.sender_name}${m.reply_to ? " replied" : ""}: ${m.body.length > 80 ? m.body.slice(0, 80) + "…" : m.body}`);
  }
  renderUnread();
  if (current === "inbox") renderPeopleList();
  if (current === "home") renderHomeMessages();
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
  for (const h of ["Name", "Email", "Status", "Can vote", ""]) head.append(el("th", "", h));
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
        toast(`${inv.display_name} ${box.checked ? "can" : "can't"} vote on translations now.`);
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
    if (current === "home") renderHome().catch(() => {});
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
    if (current === "home") renderHome().catch(() => {});
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
  dashTimer = setTimeout(() => { if (current === "dash" && project) loadDash(true).catch(() => {}); }, 3000);
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
  $("#logout").addEventListener("click", () => { toggleMenu(false); sb.auth.signOut(); });
  $("#me-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
  $("#me-menu").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { if (!$("#me-menu").hidden) toggleMenu(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#me-menu").hidden) { toggleMenu(false); $("#me-btn").focus(); return; }
    // "/" jumps to the search box while translating, unless you're typing somewhere
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (e.key === "/" && !typing && current === "translate" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      $("#search").focus();
    }
  });
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
    view = { review: true, author: null };
    $("#crumb").textContent = "Whole project";
    $("#search").value = "";
    renderClaim();
    renderScenes();
    pickReviewer(null);
    loadReviewQueue();
  });
  $("#claim-btn").addEventListener("click", toggleClaim);
  $("#admin-btn").addEventListener("click", () => { toggleMenu(false); openAdmin(); });
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".tab-panel").forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
  }));
  $$("[data-go]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.go)));
  $("#home-btn").addEventListener("click", () => setView("home"));
  $("#power-btn").addEventListener("click", togglePower);
  $("#update-reload").addEventListener("click", reloadSite);
  setInterval(tickHome, 1000); // the clock and the time on the welcome page
  checkForUpdate();
  setInterval(checkForUpdate, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });
  $("#chat-form").addEventListener("submit", sendMessage);
  $("#chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#chat-form").requestSubmit(); }
    if (e.key === "Escape" && replyTo) { replyTo = null; renderReplyBar(); }
  });
  $("#chat-input").addEventListener("input", (e) => { if (chatWith) chatDrafts.set(chatWith, e.target.value); });
  $("#chat-back").addEventListener("click", closeChat);
  $("#reply-cancel").addEventListener("click", () => { replyTo = null; renderReplyBar(); $("#chat-input").focus(); });
  $("#chat-new").addEventListener("click", () => { const box = $("#chat-log"); box.scrollTop = box.scrollHeight; $("#chat-new").hidden = true; });
  $("#chat-log").addEventListener("scroll", (e) => { if (nearBottom(e.target)) $("#chat-new").hidden = true; });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && current === "inbox" && chatWith && unreadCount(chatWith)) markRead(chatWith);
  });
  $("#dash-week").addEventListener("change", (e) => pickWeek(e.target.value));
  $("#dash-copy").addEventListener("click", copyReport);
  $("#heat-measure").addEventListener("change", () => { if (dash) renderHeat(); });
  let resizeFrame;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { if (dash && current === "dash") renderCharts(); });
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
    if (event === "SIGNED_OUT") {
      me = null;
      if (channel) sb.removeChannel(channel);
      if (dmChannel) sb.removeChannel(dmChannel);
      chatWith = null;
      showOnly("#login");
      return;
    }
    if (event === "SIGNED_IN" && !me) setTimeout(start, 0); // outside the auth callback (supabase-js advice)
  });
  start().catch((err) => { showOnly("#login"); $("#login-msg").textContent = explain(err); });
}

init();
