"""Translation Editor - a small local app for translating game text line by line.

Run:  python translator.py                        start screen: drop a CSV / TSV / JSON file
      python translator.py projects/x.json        open a saved project straight away

It opens the editor in your web browser. Everything stays on your computer: the server only
listens on 127.0.0.1. Dropped files are copied into the workspace/ folder and edited there;
use Export to get the translated file back in its original format.
Only the Python standard library is used, so there is nothing to install.
"""
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

APP_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, APP_DIR)  # find formats.py however the script is started
import formats  # noqa: E402

WEB_DIR = os.path.join(APP_DIR, "web")
PROJECTS_DIR = os.path.join(APP_DIR, "projects")
WORKSPACE_DIR = os.path.join(APP_DIR, "workspace")
REVIEW_STATES = {"google", "machine", "CHECK TAGS"}
PAGE_SIZE = 50  # lines per page when a file has no scene/section column
MAX_UPLOAD = 200 * 1024 * 1024
MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}


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
        self.source = cfg.get("source")  # set for dropped files: how to export back
        self.apply = cfg.get("apply")
        if self.apply:
            self.apply_cwd = os.path.normpath(os.path.join(self.base, self.apply.get("cwd", ".")))
        self.lock = threading.Lock()
        self.load()

    # ---- data -------------------------------------------------------------------------------
    def load(self):
        with open(self.csv_path, encoding="utf-8-sig", newline="") as fh:
            reader = csv.DictReader(fh)
            self.fieldnames = list(reader.fieldnames)
            self.rows = list(reader)
        for role in ("target", "status"):
            col = self.cols[role]
            if col not in self.fieldnames:
                self.fieldnames.append(col)
                for r in self.rows:
                    r[col] = ""

    def save(self):
        tmp = self.csv_path + ".tmp"
        with open(tmp, "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.DictWriter(fh, self.fieldnames)
            w.writeheader()
            w.writerows(self.rows)
        os.replace(tmp, self.csv_path)

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

    def subgroup_of(self, i, row):
        """(id, title) of the scene a line belongs to."""
        if self.col("subgroup"):
            title = row[self.cols["subgroup"]]
            return (row[self.cols["subgroup_id"]] if self.col("subgroup_id") else title), title
        # no scene column: split into pages, numbered within the group
        n = self.page_index[i]
        start = n * PAGE_SIZE + 1
        return f"page-{n}", f"Lines {start}–{start + PAGE_SIZE - 1}"

    @property
    def page_index(self):
        if not hasattr(self, "_pages"):
            counts, self._pages = {}, []
            for r in self.rows:
                g = self.group_of(r)
                self._pages.append(counts.get(g, 0) // PAGE_SIZE)
                counts[g] = counts.get(g, 0) + 1
        return self._pages

    def line(self, i):
        r = self.rows[i]
        sid, title = self.subgroup_of(i, r)
        return {
            "row": i,
            "group": self.group_of(r),
            "subgroup": title,
            "key": self.get(r, "key"),
            "speaker": self.get(r, "speaker"),
            "source": r[self.cols["source"]],
            "reference": self.get(r, "reference"),
            "target": r[self.cols["target"]],
            "status": r[self.cols["status"]],
            "state": self.state(r),
        }

    # ---- api --------------------------------------------------------------------------------
    def counts(self):
        c = {"total": 0, "untranslated": 0, "review": 0, "done": 0}
        for r in self.rows:
            c["total"] += 1
            c[self.state(r)] += 1
        return c

    def summary(self):
        groups = {}
        for r in self.rows:
            g = groups.setdefault(self.group_of(r), {"total": 0, "untranslated": 0, "review": 0, "done": 0})
            g["total"] += 1
            g[self.state(r)] += 1
        order = [g for g in self.group_order if g in groups] + [g for g in groups if g not in self.group_order]
        return {
            "name": self.name,
            "file": self.display_file(),
            "tag_pattern": self.tag_pattern,
            "labels": self.cols.get("labels", {}),
            "groups": [dict(name=g, **groups[g]) for g in order],
            "apply_label": self.apply.get("label", "Apply") if self.apply else None,
            "can_export": True,
        }

    def subgroups(self, group):
        out, index = [], {}
        for i, r in enumerate(self.rows):
            if self.group_of(r) != group:
                continue
            key, title = self.subgroup_of(i, r)
            if key not in index:
                index[key] = len(out)
                out.append({"id": key, "title": title, "total": 0, "untranslated": 0, "review": 0, "done": 0})
            s = out[index[key]]
            s["total"] += 1
            s[self.state(r)] += 1
        return out

    def lines(self, group=None, subgroup=None, search=None, state=None, limit=300):
        out = []
        needle = search.lower() if search else None
        for i, r in enumerate(self.rows):
            if group and self.group_of(r) != group:
                continue
            if subgroup is not None and self.subgroup_of(i, r)[0] != subgroup:
                continue
            if state and state != "all" and self.state(r) != state:
                continue
            if needle and not any(needle in self.get(r, role).lower() for role in ("source", "target", "speaker", "key")):
                continue
            out.append(self.line(i))
            if len(out) >= limit:
                break
        return out

    def update(self, row, target, status):
        with self.lock:
            r = self.rows[row]
            r[self.cols["target"]] = target
            r[self.cols["status"]] = status
            self.save()
            return self.line(row)

    def glossary(self):
        if not os.path.exists(self.glossary_path):
            return []
        with open(self.glossary_path, encoding="utf-8") as fh:
            return json.load(fh)

    def save_glossary(self, entries):
        clean = [{"source": e["source"].strip(), "target": e.get("target", "").strip(), "note": e.get("note", "").strip()}
                 for e in entries if e.get("source", "").strip()]
        with open(self.glossary_path, "w", encoding="utf-8") as fh:
            json.dump(clean, fh, ensure_ascii=False, indent=2)
        return clean

    def display_file(self):
        """Name of the file the user dropped (or the CSV of a saved project)."""
        if self.source:
            return self.source.get("filename") or os.path.basename(self.source["file"])
        return os.path.basename(self.csv_path)

    def export(self, fallback_to_source):
        source = self.source or {"format": "csv", "delimiter": ",", "had_status": True}
        original = os.path.join(self.base, self.source["file"]) if self.source else None
        data, ext = formats.export(source, original, self.fieldnames, self.rows, self.cols, fallback_to_source)
        stem = os.path.splitext(self.display_file())[0] or "translation"
        label = re.sub(r"[^\w-]+", "-", self.cols.get("labels", {}).get("target", "translated")).strip("-").lower()
        return data, f"{stem}.{label or 'translated'}{ext}"

    def run_apply(self):
        cmd = [os.path.normpath(os.path.join(self.apply_cwd, p)) if p.startswith(".") else p
               for p in self.apply["command"]]
        res = subprocess.run(cmd, cwd=self.apply_cwd, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", env=dict(os.environ, PYTHONIOENCODING="utf-8"))
        return {"ok": res.returncode == 0, "output": (res.stdout + res.stderr)[-4000:]}


class Library:
    """All projects the editor knows: saved configs in projects/ and dropped files in workspace/."""

    def __init__(self):
        self.loaded = {}
        self.lock = threading.Lock()
        self.extra = []  # project files opened from the command line, wherever they are

    def config_paths(self):
        paths = list(self.extra)
        if os.path.isdir(PROJECTS_DIR):
            paths += [os.path.join(PROJECTS_DIR, f) for f in sorted(os.listdir(PROJECTS_DIR))
                      if f.endswith(".json") and not f.endswith(".glossary.json")]
        if os.path.isdir(WORKSPACE_DIR):
            for d in sorted(os.listdir(WORKSPACE_DIR)):
                p = os.path.join(WORKSPACE_DIR, d, "project.json")
                if os.path.isfile(p):
                    paths.append(p)
        return paths

    @staticmethod
    def pid(path):
        try:
            return os.path.relpath(path, APP_DIR).replace("\\", "/")
        except ValueError:  # on another drive
            return os.path.abspath(path).replace("\\", "/")

    def get(self, pid):
        path = os.path.normpath(os.path.join(APP_DIR, pid or ""))
        if path not in [os.path.normpath(p) for p in self.config_paths()]:
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
                             **proj.counts())
            except Exception as e:  # e.g. a saved project whose CSV isn't on this computer
                entry.update(name=os.path.splitext(os.path.basename(p))[0], error=str(e))
            out.append(entry)
        out.sort(key=lambda e: -e["modified"])
        return out

    # ---- new project from a dropped file ----------------------------------------------------
    def import_file(self, filename, raw):
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
            "format": source["format"],
            "lines": len(rows),
            "fields": [f for f in fields if f != formats.PATH_COL],
            "preview": [{f: r.get(f, "") for f in fields if f != formats.PATH_COL} for r in rows[:6]],
            "guess": guess,
            "tag_presets": formats.TAG_PRESETS,
            "tag_guess": formats.guess_tag_preset(rows, guess.get("source", "")),
        }

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
        with open(os.path.join(folder, "project.json"), "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, ensure_ascii=False, indent=2)
        os.remove(os.path.join(folder, "draft.json"))
        return {"id": self.pid(os.path.join(folder, "project.json"))}

    def discard_draft(self, slug):
        folder = os.path.normpath(os.path.join(WORKSPACE_DIR, slug))
        if os.path.dirname(folder) == os.path.normpath(WORKSPACE_DIR) and os.path.isfile(os.path.join(folder, "draft.json")) \
                and not os.path.exists(os.path.join(folder, "project.json")):
            shutil.rmtree(folder)


def make_handler(library):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def local_only(self):
            # Refuse requests that didn't come from the editor page (other websites, DNS rebinding).
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
            origin = self.headers.get("Origin")
            if host not in ("127.0.0.1", "localhost") or (origin and urlparse(origin).hostname not in ("127.0.0.1", "localhost")):
                self.send_json({"error": "forbidden"}, 403)
                return False
            return True

        def send_json(self, data, code=200):
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def body(self):
            n = int(self.headers.get("Content-Length", 0))
            if n > MAX_UPLOAD:
                raise ValueError("File is too big (over 200 MB).")
            return self.rfile.read(n) if n else b""

        def do_GET(self):
            if not self.local_only():
                return
            url = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                if url.path == "/api/projects":
                    return self.send_json(library.listing())
                if url.path.startswith("/api/") and url.path != "/api/projects":
                    p = library.get(q.get("p"))
                    if url.path == "/api/summary":
                        return self.send_json(p.summary())
                    if url.path == "/api/subgroups":
                        return self.send_json(p.subgroups(q.get("group", "")))
                    if url.path == "/api/lines":
                        return self.send_json(p.lines(q.get("group"), q.get("subgroup"), q.get("search"),
                                                      q.get("state"), int(q.get("limit", 300))))
                    if url.path == "/api/glossary":
                        return self.send_json(p.glossary())
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
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)
            self.serve_static(url.path)

        def do_POST(self):
            if not self.local_only():
                return
            url = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                raw = self.body()
                if url.path == "/api/import":
                    return self.send_json(library.import_file(q.get("name", "file.csv"), raw))
                data = json.loads(raw.decode("utf-8")) if raw else {}
                if url.path == "/api/create":
                    return self.send_json(library.create(data))
                if url.path == "/api/discard":
                    library.discard_draft(data.get("draft", ""))
                    return self.send_json({"ok": True})
                p = library.get(q.get("p"))
                if url.path == "/api/line":
                    return self.send_json(p.update(int(data["row"]), data["target"], data["status"]))
                if url.path == "/api/glossary":
                    return self.send_json(p.save_glossary(data))
                if url.path == "/api/apply" and p.apply:
                    return self.send_json(p.run_apply())
                return self.send_json({"error": "not found"}, 404)
            except PermissionError:
                return self.send_json({"error": "The file is open in another program (Excel?). Close it and try again."}, 409)
            except formats.FormatError as e:
                return self.send_json({"error": str(e)}, 400)
            except (KeyError, ValueError, re.error) as e:
                return self.send_json({"error": str(e).strip("'")}, 400)

        def serve_static(self, path):
            name = "index.html" if path in ("/", "") else path.lstrip("/")
            full = os.path.normpath(os.path.join(WEB_DIR, name))
            if not full.startswith(WEB_DIR) or not os.path.isfile(full):
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


def main():
    # Older Windows consoles can't show every character (e.g. "→"); never crash over a print.
    sys.stdout.reconfigure(errors="replace")
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = 8765
    for a in sys.argv[1:]:
        if a.startswith("--port="):
            port = int(a.split("=", 1)[1])
    library = Library()
    url = f"http://127.0.0.1:{port}/"
    if args:
        path = os.path.abspath(args[0])
        if os.path.normpath(os.path.dirname(path)) != os.path.normpath(PROJECTS_DIR):
            library.extra.append(path)
        pid = Library.pid(path)
        library.get(pid)  # fail early with a clear error if the config is broken
        url += "#p=" + quote(pid)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(library))
    print("Translation Editor")
    print(f"Open {url} in your browser. Close this window to stop the editor.")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
