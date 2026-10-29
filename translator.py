"""Translation Editor - a small local app for translating game text line by line.

Run:  python translator.py [projects/your-project.json]

It opens the editor in your web browser. Everything stays on your computer: the server only
listens on 127.0.0.1 and reads/writes the CSV file named in the project config.
Only the Python standard library is used, so there is nothing to install.
"""
import csv
import json
import os
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

APP_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(APP_DIR, "web")
DEFAULT_PROJECT = os.path.join(APP_DIR, "projects", "chained-echoes.json")
DONE_STATES = {"reviewed", "copied", ""}  # "" = translated before the status column existed
REVIEW_STATES = {"google", "CHECK TAGS"}
MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}


class Project:
    def __init__(self, config_path):
        self.config_path = os.path.abspath(config_path)
        base = os.path.dirname(self.config_path)
        with open(self.config_path, encoding="utf-8") as fh:
            cfg = json.load(fh)
        self.name = cfg.get("name", "Translation project")
        self.csv_path = os.path.normpath(os.path.join(base, cfg["csv"]))
        self.cols = cfg["columns"]
        self.group_order = cfg.get("group_order", [])
        self.tag_pattern = cfg.get("tag_pattern", "")
        self.glossary_path = os.path.normpath(os.path.join(base, cfg["glossary"])) if cfg.get("glossary") else None
        self.apply = cfg.get("apply")
        if self.apply:
            self.apply_cwd = os.path.normpath(os.path.join(base, self.apply.get("cwd", ".")))
        self.lock = threading.Lock()
        self.load()

    # ---- data -------------------------------------------------------------------------------
    def load(self):
        with open(self.csv_path, encoding="utf-8-sig", newline="") as fh:
            reader = csv.DictReader(fh)
            self.fieldnames = list(reader.fieldnames)
            self.rows = list(reader)
        status = self.cols["status"]
        if status not in self.fieldnames:
            self.fieldnames.append(status)
            for r in self.rows:
                r[status] = ""

    def save(self):
        tmp = self.csv_path + ".tmp"
        with open(tmp, "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.DictWriter(fh, self.fieldnames)
            w.writeheader()
            w.writerows(self.rows)
        os.replace(tmp, self.csv_path)

    def state(self, row):
        """untranslated | review | done"""
        if not row[self.cols["target"]].strip():
            return "untranslated"
        if row[self.cols["status"]] in REVIEW_STATES:
            return "review"
        return "done"

    def line(self, i):
        r, c = self.rows[i], self.cols
        return {
            "row": i,
            "group": r[c["group"]],
            "subgroup": r[c["subgroup"]],
            "speaker": r.get(c.get("speaker", ""), ""),
            "source": r[c["source"]],
            "reference": r.get(c.get("reference", ""), ""),
            "target": r[c["target"]],
            "status": r[c["status"]],
            "state": self.state(r),
        }

    def subgroup_key(self, r):
        c = self.cols
        return r[c["subgroup_id"]] if c.get("subgroup_id") else r[c["subgroup"]]

    # ---- api --------------------------------------------------------------------------------
    def summary(self):
        groups = {}
        for r in self.rows:
            g = groups.setdefault(r[self.cols["group"]], {"total": 0, "untranslated": 0, "review": 0, "done": 0})
            g["total"] += 1
            g[self.state(r)] += 1
        order = [g for g in self.group_order if g in groups] + sorted(g for g in groups if g not in self.group_order)
        return {
            "name": self.name,
            "csv": self.csv_path,
            "tag_pattern": self.tag_pattern,
            "labels": self.cols.get("labels", {}),
            "groups": [dict(name=g, **groups[g]) for g in order],
            "apply_label": self.apply.get("label", "Apply") if self.apply else None,
        }

    def subgroups(self, group):
        out, index = [], {}
        for r in self.rows:
            if r[self.cols["group"]] != group:
                continue
            key = self.subgroup_key(r)
            if key not in index:
                index[key] = len(out)
                out.append({"id": key, "title": r[self.cols["subgroup"]], "total": 0,
                            "untranslated": 0, "review": 0, "done": 0})
            s = out[index[key]]
            s["total"] += 1
            s[self.state(r)] += 1
        return out

    def lines(self, group=None, subgroup=None, search=None, state=None, limit=300):
        out = []
        needle = search.lower() if search else None
        for i, r in enumerate(self.rows):
            if group and r[self.cols["group"]] != group:
                continue
            if subgroup is not None and self.subgroup_key(r) != subgroup:
                continue
            if state and state != "all" and self.state(r) != state:
                continue
            if needle and needle not in r[self.cols["source"]].lower() and needle not in r[self.cols["target"]].lower() \
                    and needle not in r.get(self.cols.get("speaker", ""), "").lower():
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
        if not self.glossary_path or not os.path.exists(self.glossary_path):
            return []
        with open(self.glossary_path, encoding="utf-8") as fh:
            return json.load(fh)

    def save_glossary(self, entries):
        clean = [{"source": e["source"].strip(), "target": e.get("target", "").strip(), "note": e.get("note", "").strip()}
                 for e in entries if e.get("source", "").strip()]
        with open(self.glossary_path, "w", encoding="utf-8") as fh:
            json.dump(clean, fh, ensure_ascii=False, indent=2)
        return clean

    def run_apply(self):
        cmd = [os.path.normpath(os.path.join(self.apply_cwd, p)) if p.startswith(".") else p
               for p in self.apply["command"]]
        res = subprocess.run(cmd, cwd=self.apply_cwd, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", env=dict(os.environ, PYTHONIOENCODING="utf-8"))
        return {"ok": res.returncode == 0, "output": (res.stdout + res.stderr)[-4000:]}


def make_handler(project):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send_json(self, data, code=200):
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def read_json(self):
            n = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

        def do_GET(self):
            url = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            if url.path == "/api/summary":
                return self.send_json(project.summary())
            if url.path == "/api/subgroups":
                return self.send_json(project.subgroups(q.get("group", "")))
            if url.path == "/api/lines":
                return self.send_json(project.lines(q.get("group"), q.get("subgroup"), q.get("search"),
                                                    q.get("state"), int(q.get("limit", 300))))
            if url.path == "/api/glossary":
                return self.send_json(project.glossary())
            self.serve_static(url.path)

        def do_POST(self):
            # Only accept requests from the editor page itself, not from other websites.
            origin = self.headers.get("Origin")
            if origin and urlparse(origin).hostname not in ("127.0.0.1", "localhost"):
                return self.send_json({"error": "forbidden"}, 403)
            url = urlparse(self.path)
            data = self.read_json()
            try:
                if url.path == "/api/line":
                    return self.send_json(project.update(int(data["row"]), data["target"], data["status"]))
                if url.path == "/api/glossary":
                    return self.send_json(project.save_glossary(data))
                if url.path == "/api/apply" and project.apply:
                    return self.send_json(project.run_apply())
            except PermissionError:
                return self.send_json({"error": "The CSV file is open in another program (Excel?). Close it and try again."}, 409)
            self.send_json({"error": "not found"}, 404)

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
    config = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else DEFAULT_PROJECT
    port = 8765
    for a in sys.argv[1:]:
        if a.startswith("--port="):
            port = int(a.split("=", 1)[1])
    project = Project(config)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(project))
    url = f"http://127.0.0.1:{port}/"
    print(f"Translation Editor: {project.name}")
    print(f"Editing {project.csv_path} ({len(project.rows)} lines)")
    print(f"Open {url} in your browser. Close this window to stop the editor.")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
