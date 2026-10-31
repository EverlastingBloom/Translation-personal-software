"""Translation Editor - a small local app for translating game text line by line.

Run:  python translator.py                        start screen: open or drop a CSV / TSV / JSON file
      python translator.py projects/x.json        open a saved project straight away
      python translator.py --share                let teammates on your network join (prints a link)

It opens the editor in your web browser. Everything stays on your computer: the server only
listens on 127.0.0.1 (unless you start it with --share). Files are copied into the workspace/
folder and edited there; once you pick where the translation goes (Save), the editor keeps that
file up to date by itself. Only the Python standard library is used, so there is nothing to install.
"""
import csv
import hashlib
import io
import json
import os
import queue
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

APP_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, APP_DIR)  # find formats.py however the script is started
import formats  # noqa: E402
import gitsync  # noqa: E402

WEB_DIR = os.path.join(APP_DIR, "web")
PROJECTS_DIR = os.path.join(APP_DIR, "projects")
WORKSPACE_DIR = os.path.join(APP_DIR, "workspace")
LOCAL_DIR = os.path.join(WORKSPACE_DIR, ".local")       # this computer only: edit journals
SETTINGS_PATH = os.path.join(APP_DIR, "settings.json")  # this computer only: projects opened from elsewhere
REVIEW_STATES = {"review", "google", "machine", "CHECK TAGS"}
PAGE_SIZE = 50  # lines per page when a file has no scene/section column
MAX_UPLOAD = 200 * 1024 * 1024
MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}
FLUSH_IDLE = 1.5    # seconds without edits before the working file is written to disk
FLUSH_MAX = 10      # ...but edits never wait longer than this (they are in the journal meanwhile)
RETRY_WRITE = 5     # seconds between attempts when a file is locked (open in Excel)
ONLINE_SECONDS = 20  # someone counts as online this long after their browser last checked in
SHARE = None        # access code when started with --share
COUNT_KEYS = ("total", "untranslated", "review", "done")
GIT_STATUS_EVERY = 15   # seconds between local git status checks
GIT_FETCH_EVERY = 180   # seconds between asking GitHub whether teammates uploaded something


def new_counts():
    return dict.fromkeys(COUNT_KEYS, 0)


def write_atomic(path, data):
    """Write the whole file or nothing, so a crash never leaves half a file behind."""
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            # OneDrive or a virus scanner may hold the file for a moment; Excel holds it until closed
            if attempt == 4:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                raise
            time.sleep(0.2)


class Project:
    def __init__(self, config_path):
        self.config_path = os.path.abspath(config_path)
        self.base = os.path.dirname(self.config_path)
        with open(self.config_path, encoding="utf-8") as fh:
            cfg = json.load(fh)
        self.cfg = cfg
        self.name = cfg.get("name", "Translation project")
        self.csv_path = os.path.normpath(os.path.join(self.base, cfg["csv"]))
        self.cols = cfg["columns"]
        self.group_order = cfg.get("group_order", [])
        self.tag_pattern = cfg.get("tag_pattern", "")
        self.glossary_path = os.path.normpath(os.path.join(self.base, cfg.get("glossary", "glossary.json")))
        self.source = cfg.get("source")  # set for opened/dropped files: how to write them back
        self.output = cfg.get("output")  # {"path", "auto", "fallback"}: the file Save writes to
        self.apply = cfg.get("apply")
        if self.apply:
            self.apply_cwd = os.path.normpath(os.path.join(self.base, self.apply.get("cwd", ".")))
        self.delimiter = cfg.get("delimiter") or ("," if self.source else None)
        # Who wrote which line, notes and who works on which scene live next to the CSV, so the
        # CSV itself stays clean and a team sharing the folder (git) shares them too.
        stem = os.path.splitext(self.csv_path)[0]
        self.meta_path = stem + ".notes.json"
        self.claims_path = stem + ".claims.json"
        # Unwritten edits are kept on this computer only - never inside a shared folder.
        key = hashlib.sha1(os.path.normcase(self.csv_path).encode("utf-8")).hexdigest()[:16]
        name = re.sub(r"[^\w-]+", "-", os.path.basename(stem))
        self.journal_path = os.path.join(LOCAL_DIR, f"{name}-{key}.journal")
        # Projects whose CSV lives in a git repository (e.g. on GitHub) get the Sync button.
        self.repo = gitsync.repo_root(self.csv_path) if not self.source else None
        self.git_lock = threading.Lock()
        self.git = {"repo": bool(self.repo)}
        self.git_checked = self.git_fetched = 0
        self.syncing = False
        self.conflicts = {}
        self.lock = threading.RLock()
        self.version = 0
        self.reloaded_at = 0
        self.changes = deque(maxlen=20000)  # (version, row) of every edit, for live updates
        self.presence = {}                  # browser session -> {name, row, scene, at}
        self.dirty_since = None
        self.last_edit = 0
        self.saved_at = None
        self.write_error = None
        self.next_try = 0
        self.output_dirty = False
        self.output_saved_at = None
        self.output_error = None
        self.output_next_try = 0
        self.load()
        if self.repo:
            try:
                gitsync.setup(self.repo, self.team_files())
            except (gitsync.GitError, OSError):
                pass

    # ---- data -------------------------------------------------------------------------------
    def load(self):
        with self.lock:
            if self.repo and self.has_conflict_markers():
                # a pull outside the editor stopped halfway: finish it line by line
                gitsync.resolve_unmerged(self.repo, self.team_files())
            if self.has_conflict_markers():
                raise formats.FormatError(f"{os.path.basename(self.csv_path)} has unresolved git conflicts "
                                          "(<<<<<<< lines). Finish the merge in GitHub Desktop first.")
            self.table = formats.read_table(self.csv_path, self.delimiter)
            self.fieldnames = list(self.table.fieldnames)
            self.rows = self.table.rows
            # A game's CSV usually has no status column. Editing it in place, the "needs review"
            # flags go into the notes file instead, so the CSV keeps exactly the game's columns.
            self.virtual_status = not self.source and self.cols["status"] not in self.fieldnames
            for role in ("target", "status"):
                col = self.cols[role]
                if col not in self.fieldnames:
                    self.fieldnames.append(col)
                    for r in self.rows:
                        r[col] = ""
            for r in self.rows:  # short rows come back as None
                for f in self.fieldnames:
                    if r.get(f) is None:
                        r[f] = ""
            self.meta = {}
            if os.path.exists(self.meta_path):
                try:
                    with open(self.meta_path, encoding="utf-8") as fh:
                        self.meta = {int(k): v for k, v in json.load(fh).items()}
                except (ValueError, OSError):
                    pass
            status = self.cols["status"]
            for i, m in self.meta.items():
                if m.get("status") and i < len(self.rows) and not self.rows[i][status]:
                    self.rows[i][status] = m["status"]
            self.claims = self.read_json(self.claims_path, {})
            if self.repo:
                found = gitsync.load_conflicts(self.repo, gitsync.rel(self.repo, self.csv_path))
                self.conflicts = {i: c for i, c in found.items() if i < len(self.rows)}
            self.disk_stamp = self.stamp_files()
            replayed = self.replay_journal()
            self.build_index()
            if replayed:
                self.mark_dirty()

    def has_conflict_markers(self):
        with open(self.csv_path, "rb") as fh:
            data = fh.read()
        return data.startswith(b"<<<<<<< ") or b"\n<<<<<<< " in data

    @staticmethod
    def read_json(path, default):
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return default

    def team_files(self):
        """Everything a team shares about this project (only the ones inside the repository)."""
        files = [self.csv_path, self.meta_path, self.claims_path, self.glossary_path, self.config_path]
        root = os.path.normcase(self.repo or "") + os.sep
        return [f for f in files if os.path.normcase(f).startswith(root)]

    def replay_journal(self):
        """Edits not yet written into the CSV (the editor was closed in the meantime)."""
        legacy = self.csv_path + ".journal"  # where older versions kept it
        if os.path.exists(legacy) and not os.path.exists(self.journal_path):
            os.makedirs(LOCAL_DIR, exist_ok=True)
            shutil.move(legacy, self.journal_path)
        if not os.path.exists(self.journal_path):
            return 0
        n = 0
        with open(self.journal_path, encoding="utf-8") as fh:
            for raw in fh:
                try:
                    self.apply_entry(json.loads(raw))
                    n += 1
                except (ValueError, KeyError, IndexError, TypeError):
                    continue  # a line cut off by a crash
        return n

    def apply_entry(self, e):
        i = e["row"]
        r = self.rows[i]
        m = self.meta.setdefault(i, {})
        if "target" in e:
            r[self.cols["target"]] = e["target"]
            r[self.cols["status"]] = e["status"]
            if self.virtual_status and e["status"] in REVIEW_STATES:
                m["status"] = e["status"]
            else:
                m.pop("status", None)
        for k in ("by", "at", "note", "note_by", "note_at"):
            if k in e:
                m[k] = e[k]
        if not m.get("note"):
            for k in ("note", "note_by", "note_at"):
                m.pop(k, None)
        if not m:
            del self.meta[i]

    def build_index(self):
        """Group/scene membership never changes while translating, so work it out once."""
        self.states = [self.state(r) for r in self.rows]
        self.groups, self.sub_of = {}, []
        self.totals = new_counts()
        page_count = {}
        for i, r in enumerate(self.rows):
            gname = self.group_of(r)
            g = self.groups.setdefault(gname, {"rows": [], "counts": new_counts(), "subs": {}})
            if self.col("subgroup"):
                title = r.get(self.cols["subgroup"], "")
                sid = r.get(self.cols["subgroup_id"], "") if self.col("subgroup_id") else title
            else:  # no scene column: split into pages, numbered within the group
                n = page_count.get(gname, 0) // PAGE_SIZE
                page_count[gname] = page_count.get(gname, 0) + 1
                start = n * PAGE_SIZE + 1
                sid, title = f"page-{n}", f"Lines {start}–{start + PAGE_SIZE - 1}"
            s = g["subs"].setdefault(sid, {"id": sid, "title": title, "rows": [], "counts": new_counts()})
            self.sub_of.append(sid)
            for bucket in (g, s):
                bucket["rows"].append(i)
                bucket["counts"]["total"] += 1
                bucket["counts"][self.states[i]] += 1
            self.totals["total"] += 1
            self.totals[self.states[i]] += 1
        self.search_text = ["\n".join(self.get(r, role) for role in ("source", "speaker", "key")).lower()
                            for r in self.rows]
        self.by_source = None

    def set_state(self, i):
        old, new = self.states[i], self.state(self.rows[i])
        if old == new:
            return
        g = self.groups[self.group_of(self.rows[i])]
        for counts in (self.totals, g["counts"], g["subs"][self.sub_of[i]]["counts"]):
            counts[old] -= 1
            counts[new] += 1
        self.states[i] = new

    def commit(self, entry):
        """Record one change: journal first (survives a crash), then memory, disk a moment later."""
        os.makedirs(LOCAL_DIR, exist_ok=True)
        with open(self.journal_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        self.apply_entry(entry)
        self.set_state(entry["row"])
        self.version += 1
        self.changes.append((self.version, entry["row"]))
        self.mark_dirty()

    def mark_dirty(self):
        now = time.time()
        if self.dirty_since is None:
            self.dirty_since = now
        self.last_edit = now
        if self.output and self.output.get("path"):
            self.output_dirty = True

    def stamp_files(self):
        """When the CSV, notes and claims were last changed. Flags, names and notes live in the
        notes file, so a Pull that only brings those must be noticed too."""
        out = []
        for path in (self.csv_path, self.meta_path, self.claims_path):
            try:
                out.append(os.path.getmtime(path))
            except OSError:
                out.append(None)
        return out

    def external_change(self):
        stamp = self.stamp_files()
        return stamp[0] is not None and stamp != self.disk_stamp

    def reload_from_disk(self):
        """Someone else (a script, OneDrive, a teammate) changed the CSV: take their version.
        Our own edits that are not written yet are still in the journal and go back on top."""
        self.load()
        self.version += 1
        self.reloaded_at = self.version

    def save(self):
        if self.external_change():
            self.reload_from_disk()
        # only rows that changed are rewritten: small, clean diffs for git
        write_atomic(self.csv_path, self.table.dump(self.csv_fields(), self.rows))
        if self.meta or os.path.exists(self.meta_path):
            notes = gitsync.dump_json({str(k): v for k, v in self.meta.items()}, self.meta_path)
            write_atomic(self.meta_path, notes)
        self.disk_stamp = self.stamp_files()
        try:
            os.remove(self.journal_path)
        except FileNotFoundError:
            pass
        self.dirty_since = None
        self.saved_at = time.time()
        self.write_error = None

    def csv_fields(self):
        """The columns written into the CSV."""
        return [f for f in self.fieldnames if not (self.virtual_status and f == self.cols["status"])]

    def tick(self, force=False):
        """Called twice a second by the background writer."""
        if self.syncing and not force:
            return  # git is merging the file right now; edits wait in the journal
        with self.lock:
            now = time.time()
            if self.dirty_since is None:
                if self.external_change():
                    self.reload_from_disk()
            elif force or (now >= self.next_try and (now - self.last_edit >= FLUSH_IDLE
                                                     or now - self.dirty_since >= FLUSH_MAX)):
                try:
                    self.save()
                except PermissionError:
                    self.write_error = f"Can't write {os.path.basename(self.csv_path)} – is it open in Excel?"
                    self.next_try = now + RETRY_WRITE
            auto = self.output and self.output.get("path") and self.output.get("auto", True)
            if self.output_dirty and auto and self.dirty_since is None and (force or now >= self.output_next_try):
                self.write_output()

    def col(self, role):
        return self.cols.get(role) or None

    def get(self, row, role):
        c = self.col(role)
        return row.get(c, "") if c else ""

    def state(self, row):
        """untranslated | review | done"""
        if not row[self.cols["target"]].strip():
            return "untranslated"
        if row[self.cols["status"]] in REVIEW_STATES:
            return "review"
        return "done"

    def group_of(self, row):
        return self.get(row, "group") or "All lines"

    def line(self, i):
        r = self.rows[i]
        g = self.groups[self.group_of(r)]
        m = self.meta.get(i, {})
        return {
            "row": i,
            "group": self.group_of(r),
            "subgroup": g["subs"][self.sub_of[i]]["title"],
            "key": self.get(r, "key"),
            "speaker": self.get(r, "speaker"),
            "source": r[self.cols["source"]],
            "reference": self.get(r, "reference"),
            "target": r[self.cols["target"]],
            "status": r[self.cols["status"]],
            "state": self.states[i],
            "by": m.get("by", ""),
            "at": m.get("at"),
            "note": m.get("note", ""),
            "note_by": m.get("note_by", ""),
            "conflict": self.conflicts.get(i),
        }

    # ---- api --------------------------------------------------------------------------------
    def counts(self):
        return dict(self.totals)

    def summary(self, owner):
        order = [g for g in self.group_order if g in self.groups] + [g for g in self.groups if g not in self.group_order]
        return {
            "name": self.name,
            "file": self.display_file(),
            "tag_pattern": self.tag_pattern,
            "labels": self.cols.get("labels", {}),
            "groups": [dict(name=g, **self.groups[g]["counts"]) for g in order],
            "apply_label": self.apply.get("label", "Apply") if self.apply and owner else None,
            "version": self.version,
            "save": self.save_info(owner),
            "git": self.git_info() if owner else {"repo": False},
        }

    def subgroups(self, group):
        g = self.groups.get(group)
        if not g:
            return []
        return [dict(id=s["id"], title=s["title"], claimed=self.claims.get(self.claim_key(group, s["id"])),
                     **s["counts"]) for s in g["subs"].values()]

    @staticmethod
    def claim_key(group, scene):
        return f"{group}\t{scene}"

    def claim(self, group, scene, user, on):
        """"I'm translating this scene" - so teammates pick another one. Shared with the team via git."""
        with self.lock:
            if self.dirty_since is None and self.external_change():
                self.reload_from_disk()  # don't write over claims a Pull just brought
            key = self.claim_key(group, scene)
            if on:
                self.claims[key] = {"name": user, "at": time.time()}
            else:
                self.claims.pop(key, None)
            write_atomic(self.claims_path, gitsync.dump_json(self.claims, self.claims_path))
            self.disk_stamp[2] = os.path.getmtime(self.claims_path)
            self.version += 1
            return {"claimed": self.claims.get(key)}

    def resolve(self, row, keep, user):
        """Settle a line two translators changed differently (found while syncing)."""
        with self.lock:
            c = self.conflicts.pop(row, None)
            if c and keep == "theirs":
                status = c.get("theirs_status") or "reviewed"
                self.commit({"row": row, "target": c["theirs"], "status": status, "by": user, "at": time.time()})
            else:
                self.version += 1
                self.changes.append((self.version, row))
            if self.repo:
                gitsync.save_conflicts(self.repo, gitsync.rel(self.repo, self.csv_path), self.conflicts)
            return {"line": self.line(row)}

    # ---- git ----------------------------------------------------------------------------------
    def refresh_git(self, fetch=False):
        """Background: how far this copy is from the team's (never blocks editing)."""
        if not self.git_lock.acquire(blocking=False):
            return
        try:
            info = gitsync.status(self.repo, self.team_files(), self.csv_path, fetch=fetch)
            info["last_sync"] = self.git.get("last_sync")
            if not fetch:
                info["fetch_error"] = self.git.get("fetch_error", "")
            self.git = info
        except gitsync.GitError as e:
            self.git = dict(self.git, error=str(e))
        finally:
            self.git_lock.release()

    def git_info(self):
        return dict(self.git, conflicts=len(self.conflicts))

    def git_details(self):
        with self.git_lock:
            info = gitsync.status(self.repo, self.team_files(), self.csv_path, log=15)
        info.update(conflicts=len(self.conflicts), last_sync=self.git.get("last_sync"),
                    fetch_error=self.git.get("fetch_error", ""),
                    files=[gitsync.rel(self.repo, f) for f in self.team_files()])
        return info

    def sync(self, user):
        if not self.repo:
            raise ValueError("This project isn't in a git repository, so there is nothing to sync.")
        with self.git_lock:
            self.tick(force=True)  # everything typed so far goes into this commit
            with self.lock:
                if self.write_error:
                    raise ValueError(self.write_error)
                self.syncing = True
            try:
                res = gitsync.sync(self.repo, self.team_files(), self.csv_path, user)
            finally:
                with self.lock:
                    self.syncing = False
                    # teammates' lines came in: load the merged file, edits made meanwhile go on top
                    self.reload_from_disk()
            self.git = dict(gitsync.status(self.repo, self.team_files(), self.csv_path), last_sync=time.time())
        self.git_checked = time.time()
        res["conflicts"] = len(self.conflicts)
        return res

    def lines(self, group=None, subgroup=None, search=None, state=None, limit=300):
        if search:
            needle = search.lower()
            tc = self.cols["target"]
            idx = (i for i in range(len(self.rows))
                   if needle in self.search_text[i] or needle in self.rows[i][tc].lower())
        elif group is not None:
            g = self.groups.get(group)
            if not g:
                return []
            if subgroup is None:
                idx = g["rows"]
            else:
                s = g["subs"].get(subgroup)
                idx = s["rows"] if s else []
        else:
            idx = range(len(self.rows))
        out = []
        for i in idx:
            st = self.states[i]
            if state == "todo" and st == "done":
                continue
            if state == "notes" and not self.meta.get(i, {}).get("note"):
                continue
            if state == "conflicts" and i not in self.conflicts:
                continue
            if state in ("untranslated", "review", "done") and st != state:
                continue
            out.append(self.line(i))
            if len(out) >= limit:
                break
        return out

    def update(self, row, target, status, user, base=None, force=False):
        with self.lock:
            r = self.rows[row]
            if not force and base is not None and r[self.cols["target"]] != base:
                # someone else changed this line after this browser loaded it
                return {"conflict": True, "line": self.line(row)}
            self.commit({"row": row, "target": target, "status": status, "by": user, "at": time.time()})
            return {"line": self.line(row), "same": len(self.same_open(row))}

    def set_note(self, row, note, user):
        with self.lock:
            self.rows[row]  # IndexError for a bad row
            self.commit({"row": row, "note": note.strip(), "note_by": user, "note_at": time.time()})
            return {"line": self.line(row)}

    def same_open(self, row):
        """Other untranslated lines with exactly the same original text."""
        if self.by_source is None:
            self.by_source = {}
            sc = self.cols["source"]
            for i, r in enumerate(self.rows):
                self.by_source.setdefault(r[sc], []).append(i)
        src = self.rows[row][self.cols["source"]]
        return [j for j in self.by_source.get(src, []) if j != row and self.states[j] == "untranslated"]

    def fill_same(self, row, user):
        with self.lock:
            r = self.rows[row]
            target, status = r[self.cols["target"]], r[self.cols["status"]]
            if not target.strip():
                return {"filled": 0}
            same = self.same_open(row)
            for j in same:
                self.commit({"row": j, "target": target, "status": status, "by": user, "at": time.time()})
            return {"filled": len(same)}

    def merge(self, filename, raw, user, overwrite, review):
        """Take translations from someone else's file (an export of this project, or any file
        with the same keys / original texts) and fill them in."""
        fields, theirs, info = formats.parse(filename, formats.decode(raw))
        tc, sc = self.cols["target"], self.cols["source"]
        if info["format"] == "json-tree":
            if not (self.source and self.source.get("format") == "json-tree"):
                raise ValueError("That is a JSON file of keys and texts; this project isn't. Use a file like the one you started with.")
            found = {r["key"]: r["text"] for r in theirs}
            lookup = lambda r: found.get(self.get(r, "key"))  # noqa: E731
        else:
            tcol = next((f for f in fields if f.lower() == tc.lower()), None)
            if not tcol:
                raise ValueError(f"That file has no '{tc}' column with translations.")
            kc = self.col("key")
            if kc and kc in fields:
                found = {r[kc]: r[tcol] for r in theirs if r[tcol].strip()}
                lookup = lambda r: found.get(r.get(kc, ""))  # noqa: E731
            elif sc in fields:
                found = {}
                for r in theirs:
                    if r[tcol].strip():
                        found.setdefault(r[sc], r[tcol])
                lookup = lambda r: found.get(r[sc])  # noqa: E731
            else:
                raise ValueError(f"Can't match the lines: that file has neither a '{kc or 'key'}' nor a '{sc}' column.")
        res = {"filled": 0, "kept": 0, "same": 0, "missing": 0}
        with self.lock:
            for i, r in enumerate(self.rows):
                t = lookup(r)
                # same as the original = not translated there (exports fill gaps with the original text)
                if t is None or not t.strip() or t == r[sc]:
                    res["missing"] += 1
                elif t == r[tc]:
                    res["same"] += 1
                elif r[tc].strip() and not overwrite:
                    res["kept"] += 1
                else:
                    self.commit({"row": i, "target": t, "status": "review" if review else "reviewed",
                                 "by": user, "at": time.time()})
                    res["filled"] += 1
        return res

    def poll(self, since, session, user, row, scene):
        """Live updates: lines others changed since `since`, and who else is here."""
        with self.lock:
            now = time.time()
            if session:
                self.presence[session] = {"name": user, "row": row, "scene": scene, "at": now}
            for sid in [s for s, p in self.presence.items() if now - p["at"] > ONLINE_SECONDS]:
                del self.presence[sid]
            people = [{"name": p["name"], "row": p["row"], "scene": p["scene"]}
                      for sid, p in self.presence.items() if sid != session]
            changed = []
            for v, r in reversed(self.changes):
                if v <= since:
                    break
                changed.append(r)
            reload = since < self.reloaded_at or len(changed) > 500 or \
                (self.changes and since < self.changes[0][0] - 1 and since < self.version)
            rows = [] if reload else sorted(set(changed))
            return {"version": self.version, "reload": bool(reload), "lines": [self.line(r) for r in rows],
                    "people": people}

    def online(self):
        now = time.time()
        return sorted({p["name"] for p in self.presence.values() if now - p["at"] <= ONLINE_SECONDS})

    def glossary(self):
        if not os.path.exists(self.glossary_path):
            return []
        with open(self.glossary_path, encoding="utf-8") as fh:
            return json.load(fh)

    def save_glossary(self, entries):
        clean = [{"source": e["source"].strip(), "target": e.get("target", "").strip(), "note": e.get("note", "").strip()}
                 for e in entries if e.get("source", "").strip()]
        write_atomic(self.glossary_path, json.dumps(clean, ensure_ascii=False, indent=2).encode("utf-8"))
        return clean

    def display_file(self):
        """Name of the file the user opened (or the CSV of a saved project)."""
        if self.source:
            return self.source.get("filename") or os.path.basename(self.source["file"])
        return os.path.basename(self.csv_path)

    # ---- saving to the user's file ----------------------------------------------------------
    def export_bytes(self, fallback_to_source):
        source = self.source or {"format": "csv", "delimiter": self.table.delimiter, "had_status": True}
        original = os.path.join(self.base, self.source["file"]) if self.source else None
        return formats.export(source, original, self.fieldnames, self.rows, self.cols, fallback_to_source)

    def export_name(self):
        stem = os.path.splitext(self.display_file())[0] or "translation"
        label = re.sub(r"[^\w-]+", "-", self.cols.get("labels", {}).get("target", "translated")).strip("-").lower()
        ext = ".json" if self.source and self.source.get("format", "").startswith("json") else \
            ".tsv" if (self.source or {"delimiter": self.table.delimiter}).get("delimiter") == "\t" else ".csv"
        return f"{stem}.{label or 'translated'}{ext}"

    def export(self, fallback_to_source):
        data, _ = self.export_bytes(fallback_to_source)
        return data, self.export_name()

    def suggestions(self):
        """Where Save could write, when we know where the original file is."""
        origin = (self.source or {}).get("origin")
        if not origin:
            return []
        return [{"id": "original", "path": origin, "label": "Into the original file (it gets your translation column)"
                 if self.source.get("format") == "csv" else "Into the original file (replaces its texts!)"}]

    def save_info(self, owner=True):
        with self.lock:
            pending = self.dirty_since is not None
            if not self.source:  # saved project: its CSV is the file
                return {"mode": "direct", "name": os.path.basename(self.csv_path),
                        "path": self.csv_path if owner else "", "pending": pending,
                        "saved_at": self.saved_at, "error": self.write_error}
            out = self.output or {}
            if not out.get("path"):
                return {"mode": "none", "suggest": self.suggestions() if owner else [], "export_name": self.export_name(),
                        "pending": pending, "error": self.write_error}
            return {"mode": "linked", "name": os.path.basename(out["path"]), "path": out["path"] if owner else "",
                    "auto": out.get("auto", True), "fallback": out.get("fallback", self.default_fallback()),
                    "pending": pending or self.output_dirty, "saved_at": self.output_saved_at,
                    "error": self.output_error or self.write_error,
                    "suggest": self.suggestions() if owner else [], "export_name": self.export_name()}

    def write_output(self):
        out = self.output
        written = out.get("written_mtime")
        try:
            changed = written is not None and os.path.getmtime(out["path"]) != written
        except OSError:
            changed = False
        if changed:
            self.output_error = (f"{os.path.basename(out['path'])} was changed outside the editor (a Pull?), so it was "
                                 "not overwritten. On the start screen, press “Use the file itself” on this project.")
            self.output_next_try = time.time() + 3600
            return False
        try:
            data, _ = self.export_bytes(out.get("fallback", self.default_fallback()) == "source")
            write_atomic(out["path"], data)
        except PermissionError:
            self.output_error = f"Can't write {os.path.basename(out['path'])} – is it open in Excel or another program?"
            self.output_next_try = time.time() + RETRY_WRITE
            return False
        except OSError as e:
            self.output_error = f"Can't write {out['path']}: {e.strerror or e}"
            self.output_next_try = time.time() + RETRY_WRITE
            return False
        self.output_dirty = False
        self.output_error = None
        self.output_saved_at = time.time()
        out["written_mtime"] = os.path.getmtime(out["path"])
        self.cfg["output"] = out
        write_atomic(self.config_path, json.dumps(self.cfg, ensure_ascii=False, indent=2).encode("utf-8"))
        return True

    def linked_csv(self):
        """For an older project that keeps its own copy: the CSV on disk that copy is written into."""
        if not self.source or self.source.get("format") != "csv":
            return None
        for path in ((self.output or {}).get("path"), self.source.get("origin")):
            if path and path.lower().endswith((".csv", ".tsv")) and os.path.isfile(path):
                return path
        return None

    def default_fallback(self):
        # A game JSON must be complete to work; in a table an empty cell shows what is still missing.
        return "source" if self.source and self.source.get("format", "").startswith("json") else "empty"

    def set_output(self, path, auto=True, fallback=None):
        fallback = fallback or self.default_fallback()
        if not self.source:
            raise ValueError("This project already saves straight into its CSV file.")
        path = os.path.normpath(os.path.expanduser((path or "").strip().strip('"')))
        if not os.path.isabs(path):
            raise ValueError("Use a full path, like C:\\Games\\MyGame\\dialogue.indonesian.csv")
        if not os.path.isdir(os.path.dirname(path)):
            raise ValueError(f"The folder {os.path.dirname(path)} doesn't exist.")
        if os.path.isdir(path):
            raise ValueError("That is a folder – add a file name.")
        if not os.path.splitext(path)[1]:
            path += os.path.splitext(self.export_name())[1]
        with self.lock:
            self.output = {"path": path, "auto": bool(auto), "fallback": "empty" if fallback == "empty" else "source"}
            self.cfg["output"] = self.output
            write_atomic(self.config_path, json.dumps(self.cfg, ensure_ascii=False, indent=2).encode("utf-8"))
            self.output_dirty = True
            self.output_error = None
        return self.save_now()

    def save_now(self):
        """The Save button: write everything to disk now."""
        with self.lock:
            if self.dirty_since is not None:
                try:
                    self.save()
                except PermissionError:
                    self.write_error = f"Can't write {os.path.basename(self.csv_path)} – is it open in Excel?"
            if self.output and self.output.get("path"):
                self.write_output()
            return self.save_info()

    def run_apply(self):
        self.tick(force=True)  # the script reads the CSV from disk
        cmd = [os.path.normpath(os.path.join(self.apply_cwd, p)) if p.startswith(".") else p
               for p in self.apply["command"]]
        res = subprocess.run(cmd, cwd=self.apply_cwd, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", env=dict(os.environ, PYTHONIOENCODING="utf-8"))
        return {"ok": res.returncode == 0, "output": (res.stdout + res.stderr)[-4000:]}


def is_project_file(path):
    try:
        with open(path, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        return False
    return isinstance(cfg, dict) and "csv" in cfg and "columns" in cfg


def project_file_for(csv_path):
    """A shared project file (x.translation.json) next to this CSV, if a teammate already made one."""
    folder = os.path.dirname(csv_path)
    for name in sorted(os.listdir(folder)):
        if name.endswith(gitsync.CONFIG_SUFFIX):
            p = os.path.join(folder, name)
            try:
                with open(p, encoding="utf-8") as fh:
                    cfg = json.load(fh)
            except (OSError, ValueError):
                continue
            if os.path.normcase(os.path.normpath(os.path.join(folder, cfg.get("csv", "")))) == os.path.normcase(csv_path):
                return p
    return None


class Library:
    """All projects the editor knows: saved configs in projects/, opened files in workspace/, and
    shared project files elsewhere on this computer (e.g. in a cloned GitHub repository)."""

    def __init__(self):
        self.loaded = {}
        self.lock = threading.Lock()
        self.extra = []  # project files opened from the command line, wherever they are

    def remembered(self):
        try:
            with open(SETTINGS_PATH, encoding="utf-8") as fh:
                return [p for p in json.load(fh).get("projects", []) if os.path.isfile(p)]
        except (OSError, ValueError, AttributeError):
            return []

    def remember(self, path):
        path = os.path.normpath(os.path.abspath(path))
        try:
            with open(SETTINGS_PATH, encoding="utf-8") as fh:
                settings = json.load(fh)
        except (OSError, ValueError):
            settings = {}
        projects = settings.setdefault("projects", [])
        if path not in projects:
            projects.append(path)
            write_atomic(SETTINGS_PATH, json.dumps(settings, ensure_ascii=False, indent=2).encode("utf-8"))

    def config_paths(self):
        paths = list(self.extra) + self.remembered()
        if os.path.isdir(PROJECTS_DIR):
            paths += [os.path.join(PROJECTS_DIR, f) for f in sorted(os.listdir(PROJECTS_DIR))
                      if f.endswith(".json") and not f.endswith((".glossary.json", ".notes.json", ".claims.json"))]
        if os.path.isdir(WORKSPACE_DIR):
            for d in sorted(os.listdir(WORKSPACE_DIR)):
                p = os.path.join(WORKSPACE_DIR, d, "project.json")
                if os.path.isfile(p):
                    paths.append(p)
        seen, out = set(), []
        for p in paths:
            key = os.path.normcase(os.path.normpath(p))
            if key not in seen:
                seen.add(key)
                out.append(p)
        return out

    @staticmethod
    def pid(path):
        try:
            return os.path.relpath(path, APP_DIR).replace("\\", "/")
        except ValueError:  # on another drive
            return os.path.abspath(path).replace("\\", "/")

    def get(self, pid):
        with self.lock:
            if pid in self.loaded:
                return self.loaded[pid]
        path = os.path.normpath(os.path.join(APP_DIR, pid or ""))
        if os.path.normcase(path) not in [os.path.normcase(os.path.normpath(p)) for p in self.config_paths()]:
            raise KeyError("Unknown project")
        with self.lock:
            if pid not in self.loaded:
                self.loaded[pid] = Project(path)
            return self.loaded[pid]

    def listing(self):
        out = []
        for p in self.config_paths():
            pid = self.pid(p)
            entry = {"id": pid, "kind": "workspace" if pid.startswith("workspace/") else "saved",
                     "modified": os.path.getmtime(p)}
            try:
                proj = self.get(pid)
                entry.update(name=proj.name, file=proj.display_file(), modified=os.path.getmtime(proj.csv_path),
                             online=proj.online(), shared=bool(proj.repo), behind=proj.git.get("behind", 0),
                             **proj.counts())
                linked = proj.linked_csv()
                if linked:  # an older project with its own copy: it can't see a Pull
                    entry.update(old_copy=os.path.basename(linked))
            except Exception as e:  # e.g. a saved project whose CSV isn't on this computer
                entry.update(name=os.path.splitext(os.path.basename(p))[0], error=str(e))
            out.append(entry)
        out.sort(key=lambda e: -e["modified"])
        return out

    def writer(self):
        """Background thread: writes edited projects to disk shortly after the last change, and
        now and then checks whether teammates uploaded something (git projects)."""
        while True:
            time.sleep(0.5)
            now = time.time()
            for proj in list(self.loaded.values()):
                try:
                    proj.tick()
                except Exception as e:  # never let one broken project stop the others being saved
                    print(f"Could not save {proj.name}: {e}")
                if proj.repo and not proj.syncing:
                    fetch = now - proj.git_fetched >= GIT_FETCH_EVERY
                    if fetch or now - proj.git_checked >= GIT_STATUS_EVERY:
                        proj.git_checked = now
                        if fetch:
                            proj.git_fetched = now
                        threading.Thread(target=proj.refresh_git, args=(fetch,), daemon=True).start()

    def flush_all(self):
        for proj in list(self.loaded.values()):
            try:
                proj.tick(force=True)
            except Exception as e:
                print(f"Could not save {proj.name}: {e}")

    # ---- new project from a file ------------------------------------------------------------
    def import_file(self, filename, raw, origin=None):
        filename = os.path.basename(filename) or "file.csv"
        text = formats.decode(raw)
        fields, rows, source = formats.parse(filename, text)
        stem = re.sub(r"[^\w.-]+", "-", os.path.splitext(filename)[0]).strip("-") or "project"
        os.makedirs(WORKSPACE_DIR, exist_ok=True)
        slug, n = stem, 2
        while os.path.exists(os.path.join(WORKSPACE_DIR, slug)):
            slug, n = f"{stem}-{n}", n + 1
        folder = os.path.join(WORKSPACE_DIR, slug)
        os.makedirs(folder)
        ext = os.path.splitext(filename)[1].lower()
        source["file"] = "original" + ext
        source["filename"] = filename
        if origin:
            source["origin"] = origin
        with open(os.path.join(folder, source["file"]), "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        with open(os.path.join(folder, "lines.csv"), "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.DictWriter(fh, fields)
            w.writeheader()
            w.writerows(rows)
        with open(os.path.join(folder, "draft.json"), "w", encoding="utf-8") as fh:
            json.dump(source, fh)
        guess = formats.guess_columns(fields, rows)
        if source["format"] == "json-tree":
            guess = {"source": "text", "key": "key"}
        return {
            "draft": slug,
            "filename": filename,
            "origin": origin,
            "format": source["format"],
            "lines": len(rows),
            "fields": [f for f in fields if f != formats.PATH_COL],
            "preview": [{f: r.get(f, "") for f in fields if f != formats.PATH_COL} for r in rows[:6]],
            "guess": guess,
            "tag_presets": formats.TAG_PRESETS,
            "tag_guess": formats.guess_tag_preset(rows, guess.get("source", "")),
        }

    def open_path(self, path):
        """Open a file from disk: a shared project file, a CSV that already has one next to it
        (a teammate set it up - you join their project), or any other file (new project)."""
        path = os.path.normpath(os.path.abspath((path or "").strip().strip('"')))
        if not os.path.isfile(path):
            raise ValueError(f"There is no file at {path}")
        cfg = path if path.lower().endswith(".json") and is_project_file(path) else project_file_for(path)
        if cfg:
            self.remember(cfg)
            pid = self.pid(cfg)
            self.get(pid)
            return {"project": pid}
        return self.import_path(path)

    def import_path(self, path):
        with open(path, "rb") as fh:
            raw = fh.read()
        return self.import_file(os.path.basename(path), raw, origin=path)

    def create(self, data):
        slug = data["draft"]
        folder = os.path.normpath(os.path.join(WORKSPACE_DIR, slug))
        if os.path.dirname(folder) != os.path.normpath(WORKSPACE_DIR) or not os.path.isfile(os.path.join(folder, "draft.json")):
            raise KeyError("Unknown draft")
        with open(os.path.join(folder, "draft.json"), encoding="utf-8") as fh:
            source = json.load(fh)
        m = data["columns"]
        with open(os.path.join(folder, "lines.csv"), encoding="utf-8-sig", newline="") as fh:
            fields = csv.DictReader(fh).fieldnames
        target = (m.get("target") or "").strip() or "translation"
        status = "status" if "status" not in fields or m.get("source") == "status" else "_status"
        source["had_status"] = status in fields
        if m.get("source") not in fields:
            raise ValueError("Pick the column with the text to translate.")
        if target == m["source"]:
            raise ValueError("The translation column can't be the same as the text column.")
        if target in (m.get("group"), m.get("subgroup"), m.get("key"), m.get("speaker")):
            raise ValueError(f"'{target}' is already used for something else – pick another translation column.")
        label = (data.get("target_label") or "").strip() or "Translation"
        cfg = {
            "name": (data.get("name") or "").strip() or source["filename"],
            "csv": "lines.csv",
            "glossary": "glossary.json",
            "columns": {
                "source": m["source"],
                "target": target,
                "status": status,
                "speaker": m.get("speaker") or "",
                "reference": m.get("reference") or "",
                "group": m.get("group") or "",
                "subgroup": m.get("subgroup") or "",
                "key": m.get("key") or "",
                "labels": {"target": label, "reference": m.get("reference") or "Reference"},
            },
            "tag_pattern": data.get("tag_pattern", ""),
            "source": source,
        }
        re.compile(cfg["tag_pattern"])  # refuse a broken custom pattern now, not later in the browser
        save_to = data.get("save_to") or {}
        if save_to and source.get("origin") and source.get("format") == "csv":
            return self.create_shared(cfg, source, folder)  # the opened file itself is the project
        with open(os.path.join(folder, "project.json"), "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, ensure_ascii=False, indent=2)
        os.remove(os.path.join(folder, "draft.json"))
        pid = self.pid(os.path.join(folder, "project.json"))
        if save_to:
            proj = self.get(pid)
            path = save_to.get("path")
            if save_to.get("choice") in ("original", "inplace"):
                path = source["origin"]
            proj.set_output(path, save_to.get("auto", True))
        return {"id": pid}

    def create_shared(self, cfg, source, folder):
        """Edit the opened CSV itself, with the project file next to it - so a team that shares
        the folder (a GitHub repository) gets the whole setup when they download it."""
        origin = source.get("origin")
        if not origin or source.get("format") != "csv":
            raise ValueError("Only a CSV/TSV opened with “Open a file…” can be edited in place.")
        if os.path.exists(os.path.splitext(origin)[0] + gitsync.CONFIG_SUFFIX):
            raise ValueError(f"{os.path.basename(origin)} already has a project – open that file instead.")
        pid = self.make_shared(cfg, origin, source.get("delimiter", ","))
        shutil.rmtree(folder)  # the copy in workspace/ isn't needed
        return {"id": pid}

    def make_shared(self, cfg, csv_path, delimiter):
        stem = os.path.splitext(csv_path)[0]
        cfg_path = stem + gitsync.CONFIG_SUFFIX
        shared = {
            "name": cfg["name"],
            "csv": os.path.basename(csv_path),
            "delimiter": delimiter,
            "glossary": os.path.basename(stem) + ".glossary.json",
            "columns": cfg["columns"],
            "tag_pattern": cfg.get("tag_pattern", ""),
        }
        write_atomic(cfg_path, (json.dumps(shared, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        self.remember(cfg_path)
        pid = self.pid(cfg_path)
        proj = self.get(pid)
        if proj.csv_fields() != proj.table.fieldnames:  # add the translation column right away
            with proj.lock:
                proj.mark_dirty()
                proj.save()
        return pid

    def convert(self, pid):
        """Switch an older project (its own copy, written into a file) to editing that file itself,
        so a Pull shows up. The file's text wins; the copy adds what the file doesn't have yet -
        lines not written into it, "needs review" flags and notes. The copy goes to workspace/.old."""
        old = self.get(pid)
        path = old.linked_csv()
        if not path:
            raise ValueError("This project isn't linked to a CSV file on this computer.")
        with old.lock:
            if old.dirty_since is not None:
                old.save()  # its own copy only - the linked file may hold teammates' newer lines
        cfg_path = project_file_for(path)
        if cfg_path:
            self.remember(cfg_path)
            new_pid = self.pid(cfg_path)
        else:
            new_pid = self.make_shared(old.cfg, path, formats.read_table(path).delimiter)
        new = self.get(new_pid)
        done = {"lines": 0, "flags": 0, "notes": 0, "theirs": 0}
        with new.lock:
            okey, nkey = old.col("key"), new.col("key")
            if okey and nkey:
                where = {}
                for j, r in enumerate(new.rows):
                    where.setdefault(r.get(nkey, ""), j)
                pairs = [(i, where[r.get(okey, "")]) for i, r in enumerate(old.rows) if r.get(okey, "") in where]
            else:
                pairs = [(i, i) for i in range(len(old.rows))] if len(old.rows) == len(new.rows) else []
            ot, ost, nt = old.cols["target"], old.cols["status"], new.cols["target"]
            for i, j in pairs:
                r, m, nm = old.rows[i], old.meta.get(i, {}), new.meta.get(j, {})
                mine, theirs, status = r.get(ot, ""), new.rows[j].get(nt, ""), r.get(ost, "")
                by, at = m.get("by", ""), m.get("at") or time.time()
                if mine.strip() and not theirs.strip():  # never got written into the file
                    new.commit({"row": j, "target": mine, "status": status, "by": by, "at": at})
                    done["lines"] += 1
                elif mine.strip() and mine != theirs:  # changed in the file since (a teammate): theirs stays
                    done["theirs"] += 1
                elif mine.strip() and status in REVIEW_STATES and new.states[j] != "review":
                    new.commit({"row": j, "target": theirs, "status": status, "by": by, "at": at})
                    done["flags"] += 1
                if m.get("note") and not nm.get("note"):
                    new.commit({"row": j, "note": m["note"], "note_by": m.get("note_by", ""),
                                "note_at": m.get("note_at") or time.time()})
                    done["notes"] += 1
            if new.dirty_since is not None:
                new.save()
        with self.lock:
            self.loaded.pop(pid, None)
        trash = os.path.join(WORKSPACE_DIR, ".old")
        os.makedirs(trash, exist_ok=True)
        name = os.path.basename(old.base)
        dest, n = os.path.join(trash, name), 2
        while os.path.exists(dest):
            dest, n = os.path.join(trash, f"{name}-{n}"), n + 1
        shutil.move(old.base, dest)
        return dict(done, id=new_pid, file=os.path.basename(path))

    def discard_draft(self, slug):
        folder = os.path.normpath(os.path.join(WORKSPACE_DIR, slug))
        if os.path.dirname(folder) == os.path.normpath(WORKSPACE_DIR) and os.path.isfile(os.path.join(folder, "draft.json")) \
                and not os.path.exists(os.path.join(folder, "project.json")):
            shutil.rmtree(folder)


# ---- native "Open" / "Save as" windows (tkinter ships with Python on Windows and macOS) ----------
class FilePicker:
    """Tk must stay on one thread, so a single worker thread owns it and does every dialog."""

    def __init__(self):
        self.jobs = queue.Queue()
        self.thread = None
        self.lock = threading.Lock()
        try:
            import tkinter  # noqa: F401
            self.available = True
        except ImportError:
            self.available = False

    def ask(self, kind, **kw):
        if not self.available:
            return None
        with self.lock:
            if not self.thread:
                self.thread = threading.Thread(target=self.run, daemon=True)
                self.thread.start()
            done = queue.Queue()
            self.jobs.put((kind, kw, done))
            ok, value = done.get()
        if not ok:
            raise ValueError(value)
        return os.path.normpath(value) if value else None

    def run(self):
        import tkinter
        from tkinter import filedialog
        root = tkinter.Tk()
        root.withdraw()
        types = [("Text and game files", "*.csv *.tsv *.txt *.json"), ("All files", "*.*")]
        while True:
            kind, kw, done = self.jobs.get()
            try:
                root.attributes("-topmost", True)
                root.lift()
                root.update()
                if kind == "open":
                    value = filedialog.askopenfilename(parent=root, title="Open a file to translate", filetypes=types)
                else:
                    value = filedialog.asksaveasfilename(
                        parent=root, title="Save the translation as", filetypes=types,
                        initialdir=kw.get("dir") or None, initialfile=kw.get("name") or "",
                        defaultextension=kw.get("ext") or "")
                done.put((True, value or None))
            except Exception as e:
                done.put((False, f"Couldn't open the file window: {e}"))


PICKER = FilePicker()


def make_handler(library):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def check_access(self, q):
            """The editor's own page on this computer, or (with --share) someone with the link.
            Requests from other websites (or DNS rebinding) are refused."""
            host_hdr = self.headers.get("Host") or ""
            host = (urlparse("//" + host_hdr).hostname or "").lower()
            origin = self.headers.get("Origin")
            if origin and origin != "null" and urlparse(origin).netloc.lower() != host_hdr.lower():
                return self.forbid()
            self.owner = self.client_address[0] in ("127.0.0.1", "::1") and host in ("127.0.0.1", "localhost")
            if self.owner:
                return True
            if SHARE:
                cookie = SimpleCookie(self.headers.get("Cookie") or "").get("te_key")
                if cookie and secrets.compare_digest(cookie.value, SHARE):
                    return True
                if secrets.compare_digest(q.get("key", ""), SHARE):
                    self.send_response(303)
                    self.send_header("Set-Cookie", f"te_key={SHARE}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000")
                    self.send_header("Location", "/")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return False
            return self.forbid()

        def forbid(self):
            if SHARE:
                self.send_json({"error": "Ask the person running the editor for the share link."}, 403)
            else:
                self.send_json({"error": "forbidden"}, 403)
            return False

        def user(self):
            return unquote(self.headers.get("X-User") or "").strip()[:40] or "Someone"

        def send_json(self, data, code=200):
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def body(self):
            n = int(self.headers.get("Content-Length", 0))
            if n > MAX_UPLOAD:
                raise ValueError("File is too big (over 200 MB).")
            return self.rfile.read(n) if n else b""

        def query(self):
            url = urlparse(self.path)
            # keep_blank_values: a scene can be called "" and must not turn into "every scene"
            return url, {k: v[0] for k, v in parse_qs(url.query, keep_blank_values=True).items()}

        def owner_only(self):
            if not self.owner:
                raise PermissionError("owner")

        def do_GET(self):
            url, q = self.query()
            if not self.check_access(q):
                return
            try:
                if url.path == "/api/projects":
                    return self.send_json({"projects": library.listing(), "owner": self.owner,
                                           "can_pick": PICKER.available and self.owner})
                if url.path == "/api/share":
                    return self.send_json(share_info(self.owner))
                if url.path.startswith("/api/"):
                    p = library.get(q.get("p"))
                    if url.path == "/api/summary":
                        return self.send_json(dict(p.summary(self.owner), owner=self.owner,
                                                   can_pick=PICKER.available and self.owner, shared=bool(SHARE)))
                    if url.path == "/api/subgroups":
                        return self.send_json(p.subgroups(q.get("group", "")))
                    if url.path == "/api/lines":
                        return self.send_json(p.lines(q.get("group"), q.get("subgroup"), q.get("search"),
                                                      q.get("state"), int(q.get("limit", 300))))
                    if url.path == "/api/poll":
                        res = p.poll(int(q.get("since", 0)), q.get("session", ""), self.user(),
                                     int(q["row"]) if q.get("row", "").isdigit() else None, q.get("scene", ""))
                        res["save"] = p.save_info(self.owner)
                        if self.owner and p.repo:
                            res["git"] = p.git_info()
                        return self.send_json(res)
                    if url.path == "/api/glossary":
                        return self.send_json(p.glossary())
                    if url.path == "/api/git":
                        self.owner_only()
                        return self.send_json(p.git_details() if p.repo else {"repo": False})
                    if url.path == "/api/export":
                        data, name = p.export(q.get("fallback", "source") == "source")
                        self.send_response(200)
                        self.send_header("Content-Type", "application/octet-stream")
                        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(name)}")
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                    return self.send_json({"error": "not found"}, 404)
            except KeyError:
                return self.send_json({"error": "This project doesn't exist any more."}, 404)
            except PermissionError:
                return self.send_json({"error": "Only the person running the editor can do this."}, 403)
            except gitsync.GitError as e:
                return self.send_json({"error": str(e)}, 400)
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)
            self.serve_static(url.path)

        def do_POST(self):
            url, q = self.query()
            if not self.check_access(q):
                return
            try:
                raw = self.body()
                if url.path == "/api/import":
                    return self.send_json(library.import_file(q.get("name", "file.csv"), raw))
                data = json.loads(raw.decode("utf-8")) if raw and url.path != "/api/merge" else {}
                if url.path == "/api/open":
                    self.owner_only()
                    path = data.get("path") or PICKER.ask("open")
                    if not path:
                        return self.send_json({"cancelled": True})
                    return self.send_json(library.open_path(path))
                if url.path == "/api/create":
                    return self.send_json(library.create(data))
                if url.path == "/api/discard":
                    library.discard_draft(data.get("draft", ""))
                    return self.send_json({"ok": True})
                if url.path == "/api/convert":
                    self.owner_only()
                    return self.send_json(library.convert(data.get("id", "")))
                p = library.get(q.get("p"))
                user = self.user()
                if url.path == "/api/line":
                    res = p.update(int(data["row"]), data["target"], data["status"], user,
                                   data.get("base"), bool(data.get("force")))
                    return self.send_json(res, 409 if res.get("conflict") else 200)
                if url.path == "/api/note":
                    return self.send_json(p.set_note(int(data["row"]), data.get("note", ""), user))
                if url.path == "/api/resolve":
                    return self.send_json(p.resolve(int(data["row"]), data.get("keep"), user))
                if url.path == "/api/claim":
                    return self.send_json(p.claim(data.get("group", ""), data.get("scene", ""), user, bool(data.get("on"))))
                if url.path == "/api/sync":
                    self.owner_only()
                    return self.send_json(dict(p.sync(user), git=p.git_info()))
                if url.path == "/api/fill-same":
                    return self.send_json(p.fill_same(int(data["row"]), user))
                if url.path == "/api/merge":
                    return self.send_json(p.merge(q.get("name", "file.csv"), raw, user,
                                                  q.get("overwrite") == "1", q.get("review") != "0"))
                if url.path == "/api/glossary":
                    return self.send_json(p.save_glossary(data))
                if url.path == "/api/save":
                    p.save_now()
                    return self.send_json(p.save_info(self.owner))
                if url.path == "/api/output":
                    self.owner_only()
                    path = data.get("path")
                    if data.get("pick"):
                        name = os.path.basename(path) if path else p.export_name()
                        folder = os.path.dirname(path) if path else os.path.dirname((p.source or {}).get("origin", ""))
                        path = PICKER.ask("save", dir=folder, name=name, ext=os.path.splitext(name)[1])
                        if not path:
                            return self.send_json({"cancelled": True})
                    return self.send_json(p.set_output(path, data.get("auto", True), data.get("fallback")))
                if url.path == "/api/apply" and p.apply:
                    self.owner_only()
                    return self.send_json(p.run_apply())
                return self.send_json({"error": "not found"}, 404)
            except PermissionError as e:
                if str(e) == "owner":
                    return self.send_json({"error": "Only the person running the editor can do this."}, 403)
                return self.send_json({"error": "The file is open in another program (Excel?). Close it and try again."}, 409)
            except (formats.FormatError, gitsync.GitError) as e:
                return self.send_json({"error": str(e)}, 400)
            except (KeyError, ValueError, IndexError, re.error) as e:
                return self.send_json({"error": str(e).strip("'")}, 400)
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        def serve_static(self, path):
            name = "index.html" if path in ("/", "") else path.lstrip("/")
            full = os.path.normpath(os.path.join(WEB_DIR, name))
            # inside web/ itself – a plain prefix test would also let "../web-old/…" through
            inside = os.path.normcase(os.path.commonpath([full, WEB_DIR])) == os.path.normcase(os.path.normpath(WEB_DIR))
            if not inside or not os.path.isfile(full):
                self.send_error(404)
                return
            with open(full, "rb") as fh:
                body = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", MIME.get(os.path.splitext(full)[1], "application/octet-stream") + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    return Handler


SHARE_URLS = []


def share_info(owner):
    if not SHARE:
        return {"shared": False}
    return {"shared": True, "urls": SHARE_URLS if owner else []}


def lan_addresses():
    ips = set()
    try:  # the address this computer uses to reach the network (nothing is actually sent)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        ips.update(a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def main():
    global SHARE
    # Older Windows consoles can't show every character (e.g. "→"); never crash over a print.
    sys.stdout.reconfigure(errors="replace")
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = 8765
    for a in sys.argv[1:]:
        if a.startswith("--port="):
            port = int(a.split("=", 1)[1])
    share = "--share" in sys.argv
    library = Library()
    url = f"http://127.0.0.1:{port}/"
    if args:
        path = os.path.abspath(args[0])
        if os.path.isfile(path) and not is_project_file(path):  # a CSV: open its shared project file
            path = project_file_for(path) or sys.exit(f"{args[0]} has no project file next to it yet. "
                                                      "Start the editor and use “Open a file…” to set it up.")
        if os.path.normpath(os.path.dirname(path)) != os.path.normpath(PROJECTS_DIR):
            library.remember(path)
        pid = Library.pid(path)
        library.get(pid)  # fail early with a clear error if the config is broken
        url += "#p=" + quote(pid)
    if share:
        SHARE = secrets.token_urlsafe(9)
        SHARE_URLS.extend(f"http://{ip}:{port}/?key={SHARE}" for ip in lan_addresses())
    server = ThreadingHTTPServer(("0.0.0.0" if share else "127.0.0.1", port), make_handler(library))
    server.daemon_threads = True
    threading.Thread(target=library.writer, daemon=True).start()
    print("Translation Editor")
    print(f"Open {url} in your browser. Close this window to stop the editor.")
    if share:
        print()
        print("Sharing is ON. Teammates on the same network (Wi-Fi / LAN) can join with:")
        for u in SHARE_URLS or [f"http://<this computer's IP>:{port}/?key={SHARE}"]:
            print("   ", u)
        print("Only people with this link can get in. If Windows asks, allow Python on private networks.")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        library.flush_all()


if __name__ == "__main__":
    main()
