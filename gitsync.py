"""Translating together through git - e.g. a GitHub repository that holds the game text CSV.

Every translator downloads (clones) that repository and runs their own editor. The Sync button
commits your lines, brings in everyone else's and uploads yours. To make that painless, the
editor installs a merge driver: when two people changed the same file, git merges it game line
by game line instead of file line by file line. Different lines never conflict - even when they
sit next to each other - and when two people translated the same line differently, the editor
shows both versions and lets you choose.

git itself runs this file as that merge driver:   python gitsync.py merge BASE OURS THEIRS PATH
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

APP_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, APP_DIR)
import formats  # noqa: E402

DRIVER = "translation"
CONFIG_SUFFIX = ".translation.json"  # project file kept next to the CSV in the shared repository
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
MISSING = object()


class GitError(Exception):
    pass


def git(args, cwd, timeout=60, interactive=False, check=True, binary=False):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", LC_ALL="C", LANG="C")
    if not interactive:  # background checks must never pop up a sign-in window
        env["GCM_INTERACTIVE"] = "never"
    try:
        res = subprocess.run(["git", *args], cwd=cwd, capture_output=True, timeout=timeout, env=env,
                             creationflags=NO_WINDOW, **({} if binary else
                                                         {"text": True, "encoding": "utf-8", "errors": "replace"}))
    except FileNotFoundError:
        raise GitError("Git isn't installed on this computer. Install GitHub Desktop "
                       "(desktop.github.com) or Git (git-scm.com), then try again.") from None
    except subprocess.TimeoutExpired:
        raise GitError("git took too long – check your internet connection and try again.") from None
    if check and res.returncode:
        raise GitError(friendly(res.stderr + res.stdout if not binary else res.stderr.decode(errors="replace")))
    return res


def friendly(msg):
    m = msg.lower()
    if "permission to" in m or "403" in m or "denied to" in m or "write access" in m:
        return ("GitHub didn't accept your upload: you don't have permission to change this repository. "
                "Ask its owner to add you (on GitHub: the repository → Settings → Collaborators), then Sync again.")
    if "authentication failed" in m or "could not read username" in m or "terminal prompts disabled" in m:
        return ("GitHub needs you to sign in first. Sign in once in GitHub Desktop (or install Git Credential "
                "Manager), then Sync again.")
    if "could not resolve host" in m or "unable to access" in m or "connection" in m and "timed out" in m:
        return "Can't reach GitHub – check your internet connection and try again."
    if "would be overwritten" in m:
        return ("Other files in this folder have changes that clash with your teammates' changes. Commit or "
                "discard them (e.g. in GitHub Desktop) and Sync again.")
    if "not a git repository" in m:
        return "This folder isn't a git repository."
    lines = [ln for ln in msg.strip().splitlines() if ln.strip() and not ln.startswith("hint:")]
    return "git: " + " ".join(lines[-3:]) if lines else "git failed."


# ---- where things are ---------------------------------------------------------------------------
def repo_root(path):
    """The git repository a file belongs to, or None (also None when git ignores the file)."""
    folder = os.path.dirname(os.path.abspath(path))
    try:
        res = git(["rev-parse", "--show-toplevel"], folder, check=False, timeout=15)
    except GitError:
        return None
    if res.returncode:
        return None
    root = os.path.normpath(res.stdout.strip())
    if git(["check-ignore", "-q", "--", os.path.abspath(path)], root, check=False, timeout=15).returncode == 0:
        return None
    return root


def rel(root, path):
    return os.path.relpath(os.path.abspath(path), root).replace("\\", "/")


def git_dir(root):
    return os.path.normpath(git(["rev-parse", "--absolute-git-dir"], root, timeout=15).stdout.strip())


def conflicts_file(root, relpath):
    # inside .git: decisions you still have to make are yours alone, they are never committed
    return os.path.join(git_dir(root), "translation-conflicts", relpath.replace("/", "__") + ".json")


def load_conflicts(root, relpath):
    try:
        with open(conflicts_file(root, relpath), encoding="utf-8") as fh:
            return {int(k): v for k, v in json.load(fh).items()}
    except (OSError, ValueError, GitError):
        return {}


def save_conflicts(root, relpath, conflicts):
    path = conflicts_file(root, relpath)
    if not conflicts:
        if os.path.exists(path):
            os.remove(path)
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({str(k): v for k, v in sorted(conflicts.items())}, fh, ensure_ascii=False, indent=1)


def setup(root, files):
    """Install the merge driver for this repository and list our files in .gitattributes.
    Returns True when .gitattributes changed (it gets committed with the next Sync)."""
    script = os.path.abspath(__file__).replace("\\", "/")
    python = sys.executable.replace("\\", "/")
    driver = f'"{python}" "{script}" merge %O %A %B %P'
    current = git(["config", "--get", f"merge.{DRIVER}.driver"], root, check=False, timeout=15).stdout.strip()
    if current != driver:
        git(["config", f"merge.{DRIVER}.name", "Translation Editor: merge game text line by line"], root, timeout=15)
        git(["config", f"merge.{DRIVER}.driver", driver], root, timeout=15)
    attrs = os.path.join(root, ".gitattributes")
    have = open(attrs, encoding="utf-8").read() if os.path.exists(attrs) else ""
    lines = have.splitlines()
    wanted = [f"{rel(root, f).replace(' ', '[ ]')} merge={DRIVER}" for f in files
              if f.lower().endswith((".csv", ".tsv", ".txt", ".notes.json", ".claims.json", ".glossary.json"))]
    add = [w for w in wanted if w not in lines]
    if not add:
        return False
    with open(attrs, "a", encoding="utf-8", newline="\n") as fh:
        if have and not have.endswith("\n"):
            fh.write("\n")
        if not have:
            fh.write("# Translation Editor: merge translations line by line (see gitsync.py)\n")
        fh.write("\n".join(add) + "\n")
    return True


# ---- merging ------------------------------------------------------------------------------------
def project_columns(root, relpath):
    """Column roles from the project file next to the CSV (which column is the key, the translation...)."""
    folder = os.path.join(root, os.path.dirname(relpath))
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        if name.endswith(CONFIG_SUFFIX):
            try:
                with open(os.path.join(folder, name), encoding="utf-8") as fh:
                    cfg = json.load(fh)
            except (OSError, ValueError):
                continue
            if os.path.basename(cfg.get("csv", "")) == os.path.basename(relpath):
                return cfg.get("columns", {}), cfg.get("delimiter")
    return {}, None


def stamp(d):
    if not isinstance(d, dict):
        return 0
    return max([v for k, v in d.items() if k.endswith("at") and isinstance(v, (int, float))] or [0])


def merge3(b, o, t, side="o"):
    """Three-way merge of one value (MISSING = not there): whoever changed it wins. If both did,
    dicts are merged key by key, and where both changed the same thing the more recent edit
    (by its *_at time stamp) wins - otherwise ours ("o")."""
    if o == t or t == b:
        return o
    if o == b:
        return t
    if isinstance(o, dict) and isinstance(t, dict) and (b is MISSING or isinstance(b, dict)):
        bb = {} if b is MISSING else b
        if stamp(o) or stamp(t):
            side = "t" if stamp(t) > stamp(o) else "o"
        out = {}
        for k in list(o) + [k for k in t if k not in o]:
            v = merge3(bb.get(k, MISSING), o.get(k, MISSING), t.get(k, MISSING), side)
            if v is not MISSING:
                out[k] = v
        return out
    return t if side == "t" else o


def dump_json(data, path):
    """Notes and claims: one entry per line, so git diffs stay readable."""
    name = os.path.basename(path)
    if isinstance(data, dict) and name.endswith((".notes.json", ".claims.json")):
        body = ",\n".join(f"{json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False, sort_keys=True)}"
                          for k, v in sorted(data.items(), key=lambda kv: (len(kv[0]), kv[0])))
        return ("{\n" + body + "\n}\n" if body else "{}\n").encode("utf-8")
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def read_json(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    return formats.load_json(formats.decode(raw)) if raw.strip() else None


def merge_json(base, ours, theirs, relpath):
    b, o, t = read_json(base), read_json(ours), read_json(theirs)
    if isinstance(o, list) and isinstance(t, list):  # glossary: entries matched by their original term
        key = lambda e: e.get("source", "").strip().lower() if isinstance(e, dict) else json.dumps(e)  # noqa: E731
        bm = {key(e): e for e in b or []}
        om, tm = {key(e): e for e in o}, {key(e): e for e in t}
        out = []
        for k in list(om) + [k for k in tm if k not in om]:
            v = merge3(bm.get(k, MISSING), om.get(k, MISSING), tm.get(k, MISSING))
            if v is not MISSING:
                out.append(v)
        return dump_json(out, relpath), 0
    if not isinstance(o, dict) or not isinstance(t, dict):
        raise ValueError("not a JSON object")
    result = merge3(b if isinstance(b, dict) else MISSING, o, t)
    return dump_json(result, relpath), 0


def merge_table(base, ours, theirs, relpath, root):
    cols, delim = project_columns(root, relpath)
    ext = os.path.splitext(relpath)[1].lower()
    to = formats.read_table(ours, delim, ext)
    tb = formats.read_table(base, to.delimiter, ext) if os.path.getsize(base) else None
    tt = formats.read_table(theirs, to.delimiter, ext)
    key = cols.get("key")

    def ident(t):
        if t is None:
            return None
        if key and key in t.fieldnames:
            ks = [r[key] for r in t.rows]
            if len(set(ks)) == len(ks):
                return ks
        return None

    ko, kt = ident(to), ident(tt)
    kb = ident(tb) if tb else []
    if ko is None or kt is None or kb is None:  # no unique key: lines are matched by position
        if tb is None or not (len(to.rows) == len(tt.rows) == len(tb.rows)):
            raise ValueError("lines can't be matched (no unique key column and the line count changed)")
        ko = kt = list(range(len(to.rows)))
        kb = list(range(len(tb.rows)))
    bmap = dict(zip(kb, tb.rows)) if tb else {}
    tmap = dict(zip(kt, tt.rows))
    fields = to.fieldnames + [f for f in tt.fieldnames if f not in to.fieldnames]
    target, status = cols.get("target"), cols.get("status")
    rows, conflicts = [], {}
    for i, (k, ro) in enumerate(zip(ko, to.rows)):
        rb, rt = bmap.get(k, {}), tmap.get(k)
        if rt is None:
            rows.append(dict(ro))
            continue
        row = {}
        for f in fields:
            b = rb.get(f, "")
            o = ro[f] if f in to.fieldnames else b
            t = rt[f] if f in tt.fieldnames else b
            if o == t or t == b:
                row[f] = o
            elif o == b:
                row[f] = t
            else:  # both changed this cell differently: keep ours, remember theirs for the editor
                row[f] = o
                if f == target or not target:
                    conflicts[i] = {"theirs": t, "base": b, "column": f,
                                    "theirs_status": rt.get(status, "") if status else ""}
        if i in conflicts and status in ro:
            row[status] = ro[status]
        rows.append(row)
    known = set(ko) | set(bmap)
    rows += [dict(r) for k, r in zip(kt, tt.rows) if k not in known and isinstance(k, str)]  # new lines in theirs
    if conflicts:
        old = load_conflicts(root, relpath)
        old.update(conflicts)
        save_conflicts(root, relpath, old)
    return to.dump(fields, rows), 0


def merge_file(base, ours, theirs, relpath, root=None):
    """Merge THEIRS into OURS (the file is overwritten with the result). Returns git's exit code."""
    root = root or os.getcwd()
    try:
        if relpath.lower().endswith(".json"):
            data, code = merge_json(base, ours, theirs, relpath)
        else:
            data, code = merge_table(base, ours, theirs, relpath, root)
        with open(ours, "wb") as fh:
            fh.write(data)
        return code
    except Exception as e:  # anything unexpected: let git do its normal merge (with conflict markers)
        print(f"Translation Editor merge of {relpath}: {e}; using git's normal merge.", file=sys.stderr)
        return subprocess.run(["git", "merge-file", "-L", "yours", "-L", "base", "-L", "theirs",
                               ours, base, theirs], creationflags=NO_WINDOW).returncode


def resolve_unmerged(root, files, ident=()):
    """If a pull (in the editor or e.g. GitHub Desktop) stopped with conflicts in our files, merge
    them line by line now. Returns the conflicted files we could not take care of."""
    out = git(["diff", "--name-only", "--diff-filter=U", "-z"], root).stdout
    ours = {rel(root, f) for f in files}
    left = []
    for relpath in [p for p in out.split("\0") if p]:
        if relpath not in ours:
            left.append(relpath)
            continue
        tmp = tempfile.mkdtemp(prefix="te-merge-")
        try:
            paths = []
            for stage in (1, 2, 3):
                p = os.path.join(tmp, str(stage))
                res = git(["show", f":{stage}:{relpath}"], root, check=False, binary=True)
                with open(p, "wb") as fh:
                    fh.write(res.stdout if res.returncode == 0 else b"")
                paths.append(p)
            if merge_file(paths[0], paths[1], paths[2], relpath, root) != 0:
                left.append(relpath)
                continue
            shutil.copyfile(paths[1], os.path.join(root, relpath))
            git(["add", "--", relpath], root)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return left


# ---- status and sync ----------------------------------------------------------------------------
def changed_lines(numstat, relpath):
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) == 3 and parts[2] == relpath and parts[0].isdigit():
            return int(parts[0])
    return 0


def clean_url(url):
    return re.sub(r"//[^/@]+@", "//", url.strip())


def status(root, files, csv_path, fetch=False, log=0):
    """What the Team panel shows. fetch=True asks GitHub for news (no sign-in windows)."""
    info = {"repo": True, "root": root}
    remotes = git(["remote"], root, timeout=15).stdout.split()
    info["remote"] = clean_url(git(["remote", "get-url", remotes[0]], root, check=False, timeout=15).stdout) if remotes else ""
    if fetch and remotes:
        res = git(["fetch", "--quiet"], root, check=False, timeout=60)
        info["fetch_error"] = friendly(res.stderr) if res.returncode else ""
    info["branch"] = git(["rev-parse", "--abbrev-ref", "HEAD"], root, check=False, timeout=15).stdout.strip()
    ab = git(["rev-list", "--left-right", "--count", "HEAD...@{u}"], root, check=False, timeout=15)
    if ab.returncode == 0 and len(ab.stdout.split()) == 2:
        info["ahead"], info["behind"] = map(int, ab.stdout.split())
    else:
        info["ahead"] = info["behind"] = 0
        info["no_upstream"] = bool(remotes)
    rels = [rel(root, f) for f in files if os.path.exists(f)]
    diff = git(["diff", "--numstat", "HEAD", "--", *rels], root, check=False, timeout=15)
    info["changed"] = changed_lines(diff.stdout, rel(root, csv_path)) if diff.returncode == 0 else 0
    info["uncommitted"] = bool(diff.stdout.strip()) if diff.returncode == 0 else True
    if log:
        res = git(["log", f"-n{log}", "--no-merges", "--format=%an%x1f%at%x1f%s", "--", *rels], root, check=False, timeout=15)
        info["log"] = [dict(zip(("author", "at", "message"), ln.split("\x1f"))) for ln in res.stdout.splitlines()
                       if ln.count("\x1f") == 2]
        for e in info["log"]:
            e["at"] = int(e["at"])
    return info


def sync(root, files, csv_path, user):
    """Commit our files, pull teammates' work (merged line by line), push. Returns a summary."""
    setup(root, files)
    left = resolve_unmerged(root, files)
    if left:
        raise GitError(f"git is in the middle of a merge with other files ({', '.join(left[:3])}). "
                       "Finish or abort that merge (e.g. in GitHub Desktop) and Sync again.")
    csv_rel = rel(root, csv_path)
    rels = [rel(root, f) for f in files if os.path.exists(f)]
    if os.path.exists(os.path.join(root, ".gitattributes")):
        rels.append(".gitattributes")
    git(["add", "--", *rels], root)
    ident = []
    if not git(["config", "user.name"], root, check=False, timeout=15).stdout.strip():
        slug = re.sub(r"[^a-z0-9]+", ".", user.lower()).strip(".") or "translator"
        ident = ["-c", f"user.name={user}", "-c", f"user.email={slug}@translation-editor.invalid"]
    staged = git(["diff", "--cached", "--numstat"], root).stdout
    merging = os.path.exists(os.path.join(git_dir(root), "MERGE_HEAD"))
    sent = changed_lines(staged, csv_rel)
    if staged.strip() or merging:
        msg = f"Translate {sent} line{'s' if sent != 1 else ''} ({user})" if sent else f"Update translation ({user})"
        git([*ident, "commit", "--no-verify", "-m", msg], root)
    remotes = git(["remote"], root).stdout.split()
    if not remotes:
        return {"sent": sent, "received": 0, "local_only": True,
                "message": "Saved a version (commit). This folder isn't connected to GitHub, so nothing was uploaded."}
    remote = "origin" if "origin" in remotes else remotes[0]
    has_upstream = git(["rev-parse", "--abbrev-ref", "@{u}"], root, check=False).returncode == 0
    before = git(["rev-parse", "HEAD"], root).stdout.strip()

    def pull():
        res = git(["fetch"], root, timeout=180, interactive=True, check=False)
        if res.returncode:
            raise GitError(friendly(res.stderr + res.stdout))
        res = git([*ident, "merge", "--no-edit", "-m", f"Bring in teammates' translations ({user})", "@{u}"],
                  root, timeout=60, check=False)
        if res.returncode == 0:
            return
        # stopped with conflicts git couldn't merge itself (e.g. the merge driver wasn't set up yet)
        if resolve_unmerged(root, files):
            git(["merge", "--abort"], root, check=False)
            raise GitError(friendly(res.stderr + res.stdout))
        if not os.path.exists(os.path.join(git_dir(root), "MERGE_HEAD")):
            raise GitError(friendly(res.stderr + res.stdout))
        git([*ident, "commit", "--no-verify", "--no-edit"], root)

    if has_upstream:
        pull()
    for attempt in range(2):
        res = git(["push"] if has_upstream else ["push", "-u", remote, "HEAD"], root, timeout=180,
                  interactive=True, check=False)
        if res.returncode == 0:
            break
        out = (res.stderr + res.stdout).lower()
        if attempt == 0 and ("fetch first" in out or "non-fast-forward" in out or "rejected" in out and "permission" not in out):
            pull()  # someone uploaded in between: bring their work in and try once more
            has_upstream = True
            continue
        raise GitError(friendly(res.stderr + res.stdout))
    # `before` already has our commit, so this is only what teammates changed
    diff = git(["diff", "--numstat", before, "HEAD", "--", csv_rel], root, check=False).stdout
    return {"sent": sent, "received": changed_lines(diff, csv_rel)}


if __name__ == "__main__":
    if len(sys.argv) == 6 and sys.argv[1] == "merge":
        sys.exit(merge_file(*sys.argv[2:6]))
    print(__doc__)
    sys.exit(2)
