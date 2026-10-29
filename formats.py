"""Reading text files people drop into the editor, and writing the translated file back out.

Supported:
  csv / tsv / txt   any delimiter (, ; tab |), with a header row
  json (tree)       {"key": "text", "nested": {"key": "text"}} - e.g. game i18n / dialogue files.
                    Every string value becomes one line; numbers, booleans etc. are kept as they are.
  json (records)    [{"id": 1, "text": "..."}, ...] - treated like a table, one object per line

The editor always works on a CSV copy (lines.csv); export rebuilds the original format:
JSON files come back identical except that each translated text replaces the original,
CSV/TSV files come back with the translation in its own column.
"""
import csv
import io
import json
import os
import re

TABLE_EXT = {".csv", ".tsv", ".txt"}
PATH_COL = "_path"  # internal column: where a json-tree line lives in the original file


class FormatError(Exception):
    pass


def decode(raw):
    """Bytes from an unknown text file -> str."""
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16")
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1")


def strip_json_comments(text):
    """Remove // and /* */ comments and trailing commas (common in game mod files) outside strings."""
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 1
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
            out.append(c)
        elif text.startswith("//", i):
            while i < n and text[i] not in "\r\n":
                i += 1
            continue
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        else:
            out.append(c)
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def load_json(text):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        try:
            return json.loads(strip_json_comments(text))
        except json.JSONDecodeError as e:
            raise FormatError(f"This JSON file could not be read: {e}") from None


def sniff_delimiter(text, ext):
    if ext == ".tsv":
        return "\t"
    sample = "\n".join(text.splitlines()[:50])
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        return ","


def unique_headers(names):
    out, seen = [], {}
    for i, name in enumerate(names):
        name = (name or "").strip() or f"column {i + 1}"
        if name in seen:
            seen[name] += 1
            name = f"{name} ({seen[name]})"
        else:
            seen[name] = 1
        out.append(name)
    return out


def walk_strings(node, path=()):
    """Yield (path, text) for every string inside nested dicts/lists."""
    if isinstance(node, str):
        yield path, node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from walk_strings(v, path + (k,))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk_strings(v, path + (i,))


def parse(filename, text):
    """Returns (fieldnames, rows, source_info). source_info is stored in the project config."""
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".json":
        data = load_json(text)
        if isinstance(data, list) and data and all(isinstance(x, dict) for x in data):
            fields = unique_headers(list(dict.fromkeys(k for obj in data for k in obj)))
            keys = list(dict.fromkeys(k for obj in data for k in obj))
            rows = [{f: as_text(obj.get(k, "")) for f, k in zip(fields, keys)} for obj in data]
            return fields, rows, {"format": "json-records", "keys": keys}
        if isinstance(data, (dict, list)):
            rows = [{"key": "/".join(str(p) for p in path), "text": value, PATH_COL: json.dumps(path)}
                    for path, value in walk_strings(data)]
            if not rows:
                raise FormatError("No text found in this JSON file.")
            return ["key", "text", PATH_COL], rows, {"format": "json-tree"}
        raise FormatError("This JSON file has no text to translate.")
    if ext in TABLE_EXT:
        delim = sniff_delimiter(text, ext)
        reader = csv.reader(io.StringIO(text), delimiter=delim)
        try:
            header = next(reader)
        except StopIteration:
            raise FormatError("The file is empty.") from None
        fields = unique_headers(header)
        rows = []
        for rec in reader:
            if not any(cell.strip() for cell in rec):
                continue
            rec = rec + [""] * (len(fields) - len(rec))
            rows.append(dict(zip(fields, rec[:len(fields)])))
        if not rows:
            raise FormatError("The file has a header but no lines.")
        return fields, rows, {"format": "csv", "delimiter": delim}
    raise FormatError(f"'{ext or filename}' files aren't supported yet. Use CSV, TSV or JSON "
                      "(Excel: File > Save As > CSV UTF-8).")


def as_text(v):
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)


def export(source, original_path, fieldnames, rows, cols, fallback_to_source):
    """Rebuild the original file format with translations filled in. Returns (bytes, extension)."""
    target, src, status = cols["target"], cols["source"], cols["status"]

    def value(r):
        t = r[target]
        return t if t.strip() or not fallback_to_source else r[src]

    fmt = source.get("format", "csv")
    if fmt == "json-tree":
        with open(original_path, encoding="utf-8") as fh:
            data = load_json(fh.read())
        for r in rows:
            node, path = data, json.loads(r[PATH_COL])
            for p in path[:-1]:
                node = node[p]
            node[path[-1]] = value(r)
        return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"), ".json"
    if fmt == "json-records":
        # Same file, same order and value types; only the text field of each object is replaced.
        with open(original_path, encoding="utf-8") as fh:
            data = load_json(fh.read())
        key = source["keys"][fieldnames.index(src)]
        for obj, r in zip(data, rows):
            obj[key] = value(r)
        return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"), ".json"
    # csv: original columns + the translation column, in the original delimiter
    keep = [f for f in fieldnames if f != status or source.get("had_status")]
    buf = io.StringIO()
    w = csv.DictWriter(buf, keep, delimiter=source.get("delimiter", ","), extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow(dict(r, **{target: value(r)}))
    ext = ".tsv" if source.get("delimiter") == "\t" else ".csv"
    return buf.getvalue().encode("utf-8-sig"), ext


# ---- guessing which column is which -----------------------------------------------------------
GUESS = {
    "source": ["english", "en", "en-us", "en_us", "source", "original", "text", "value", "string",
               "dialogue", "dialog", "line", "message", "content"],
    "target": ["translation", "translated", "target", "tl", "localized", "indonesian", "id-id", "id_id"],
    "speaker": ["speaker", "character", "actor", "npc", "name", "who", "talker"],
    "reference": ["reference", "german", "german_reference", "french", "japanese", "notes", "comment"],
    "group": ["file", "sheet", "category", "database", "chapter", "section", "group", "map", "source_file"],
    "subgroup": ["scene", "conversation", "conversation_title", "event", "quest", "subsection", "title"],
    "key": ["key", "id", "string_id", "entry_id", "name_id"],
}


def guess_columns(fieldnames, rows):
    names = {f.lower().strip(): f for f in fieldnames if f != PATH_COL}
    pick = {}
    for role, words in GUESS.items():
        for w in words:
            if w in names and names[w] not in pick.values():
                pick[role] = names[w]
                break
    if "source" not in pick:
        # longest average text wins
        def avg(f):
            vals = [r.get(f, "") for r in rows[:200]]
            return sum(len(v) for v in vals) / max(1, len(vals))
        choices = [f for f in fieldnames if f != PATH_COL and f not in pick.values()]
        if choices:
            pick["source"] = max(choices, key=avg)
    return pick


TAG_PRESETS = [
    {"id": "none", "label": "None", "pattern": ""},
    {"id": "auto", "label": "Common codes: [..] {..} <..> %s \\n", "pattern":
        r"\[[^\]\n]*\]|\{[^}\n]*\}|<[^>\n]+>|%(?:\d+\$)?[-+ 0#]*\d*(?:\.\d+)?[sdifxXc%]|\\[nrt]"},
    {"id": "brackets", "label": "Square brackets [..]", "pattern": r"\[[^\]\n]*\]"},
    {"id": "braces", "label": "Curly braces {..} / {{..}}", "pattern": r"\{\{[^}\n]*\}\}|\{[^}\n]*\}"},
    {"id": "html", "label": "HTML / rich text <..>", "pattern": r"<[^>\n]+>"},
    {"id": "printf", "label": "printf %s %d %1$s", "pattern": r"%(?:\d+\$)?[-+ 0#]*\d*(?:\.\d+)?[sdifxXc%]"},
    # $h/$s/$1 portraits, #$b# breaks, # pauses, @ player name, ^ gender split, %adj/%noun, {0}, [items]
    {"id": "stardew", "label": "Stardew Valley ($h #$b# @ ^ %name {0} [item])", "pattern":
        r"#\$[a-z]+#|\$[a-z0-9]+|%[a-z]+|[#@^]|\{\{[^}\n]*\}\}|\{\d+\}|\[[^\]\n]*\]"},
    {"id": "dialogue-system", "label": "Pixel Crushers Dialogue System ([panel=1] \\.)",
     "pattern": r"\[[^\]]*\]|\\[.,^<>|]"},
]


def guess_tag_preset(rows, source_col):
    sample = " ".join(r.get(source_col, "") for r in rows[:500])
    if re.search(r"\$[hsalu]\b|#\$[a-z]|\^", sample):
        return "stardew"
    if re.search(r"\[panel=\d+\]|\\\.", sample):
        return "dialogue-system"
    if re.search(r"\[[^\]]+\]|\{[^}]+\}|<[^>]+>|%[sd]", sample):
        return "auto"
    return "none"
