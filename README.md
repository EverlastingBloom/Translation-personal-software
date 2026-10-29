# Translation Editor

A small app for translating game text by hand, one line at a time, instead of scrolling
through a huge CSV or JSON file. **Open a file, translate, it saves itself.** It runs on your own
computer, opens in your web browser, and needs nothing installed except Python. Teammates can
join live over your Wi-Fi, or merge their work in later.

Works with any game whose text you can get into a **CSV, TSV or JSON** file – for example
dialogue extracted from Stardew Valley, a mod's `i18n/default.json`, or a spreadsheet saved
as CSV.

## Start

1. Install [Python 3](https://www.python.org/downloads/) (tick "Add python.exe to PATH").
2. Download this repo (Code → Download ZIP) and unzip it.
3. Double-click **`START_EDITOR.bat`** (or run `python translator.py`).
   The editor opens at <http://127.0.0.1:8765/>.
4. Press **Open a file…** and pick your CSV / JSON (or drop it on the page).
5. Check the setup screen – it guesses which column is the text, the speaker, the key, etc.
   – type the language you're translating into, choose **where the translation is saved**, and
   press **Start translating**.
6. Translate. That's it: the translated file is kept up to date by itself while you work.
   **Save** (Ctrl + S) writes it right away.

Your projects are listed on the start screen with their progress, so you can come back any
time. Click the logo in the top-left corner to get back to that list.

## What it does

- **Sidebar** with sections and scenes and a progress bar for each. Files without a scene
  column are split into pages of 50 lines.
- **One card per line**: who is speaking, the key/ID, the original text, an optional reference
  (e.g. an existing official translation), and a box for your translation.
- **Code guard**: game codes like `$h`, `#$b#`, `@`, `{0}`, `%s`, `[panel=1]` or `<color>`
  are highlighted. If one goes missing in your translation, the card warns you ("missing $s")
  and won't save, so the game can't break. Codes may move around – word order differs
  between languages.
- **Glossary**: terms from your glossary that appear in a line show up under it; click one to
  insert its fixed translation. Each project has its own glossary.
- **Search** everything (text, translation, speaker or key) and **filter** by
  untranslated / needs review / done. **Next unfinished** jumps to the next open line.
- **Saves automatically** a moment after you stop typing, and when you leave a box. Unsaved
  lines have an orange edge.
- **Needs review**: press **⚑ Review** (Ctrl + Shift + Enter) when you're unsure about a line.
  Fixing a flagged line keeps the flag until someone presses **Done** – filter by
  *Needs review* to go through them.
- **Notes** on any line, for yourself or your team (filter: *With notes*).
- **Fill identical lines**: after you translate a line, a button offers the same translation
  for every other untranslated line with exactly the same original text.
- Light and dark mode, works on small screens too. Long scenes load as you scroll, so even
  files with tens of thousands of lines stay quick.

### Saving: pick the file once, then just Save

The first time (on the setup screen, or with the **Save** button) you choose where the
translation goes – after that the editor is linked to that file and keeps it up to date. No more
exporting and replacing the old file.

- **Next to the original**, e.g. `dialogue.csv` → `dialogue.indonesian.csv` (recommended)
- **Into the original file**: a CSV keeps all its columns and gets your translation column;
  a JSON file gets its texts replaced by the translation
- **Somewhere else**: type a path or press **Browse…**

The file comes back in the original format:

- **JSON**: identical file, with each translated text in place of the original
  (numbers, nesting and order are kept), ready to drop back into the game or mod.
- **CSV/TSV**: the original columns plus your translation column, same delimiter.
- Untranslated lines keep the original text (default for JSON, so the game has every line) or
  stay empty (default for CSV, so you see what's missing). Change it in the **▾** menu next to
  Save, which also has **Download a copy** and lets you switch the file or turn off auto-updating.

Files dropped on the page don't tell the editor where they came from, so for those you pick the
place the first time you press Save. Use **Open a file…** to link it straight away.

## Working together

Press **Team** in the top bar. Set your name once (click it to change) – it's shown next to the
lines you translate and the notes you leave.

**Live, on the same network** – double-click **`START_SHARED.bat`** (or `python translator.py --share`).
The window shows a link; send it to your teammates on the same Wi-Fi / LAN. Then:

- lines others save appear on your screen within a few seconds (briefly highlighted),
- you see who is online, and which scene and line each person is on ("Ana is here"),
- if two people change the same line at once, the editor shows both versions and asks which to keep
  – nobody's work is silently overwritten,
- the glossary is shared.

Only people with the link (it contains a secret code) can get in. Choosing where files are saved,
opening files and *Apply* stay with the person running the editor. If Windows asks, allow Python
on private networks.

**Not on the same network?** Everyone translates their own copy, then use **Merge** to bring in
a teammate's file (their saved/exported file, or any file with the same keys or original texts).
Lines are matched by key, otherwise by identical original text; merged lines are marked
*needs review* by default and your existing translations are kept unless you tick *Replace*.

If a project's CSV is changed by another program while the editor is open (an import script,
OneDrive or git bringing in a teammate's version), the editor notices and loads the new version;
edits you made that weren't written yet are put back on top.

### Supported files

| File | How it is read |
|---|---|
| `.csv`, `.tsv`, `.txt` | Table with a header row. The delimiter (`,` `;` tab `|`) is detected. |
| `.json` – keys and texts | `{"Mon": "Hello!", "Event": {"intro": "Hi @"}}` – every text becomes a line, its path is the key. Comments and trailing commas (common in mod files) are fine. |
| `.json` – list of objects | `[{"id": 1, "text": "Hello"}, ...]` – read like a table. |

Excel files: use *File → Save As → CSV UTF-8* first.

### Code presets

Pick the one that matches your game on the setup screen (it guesses for you):

| Preset | Protects |
|---|---|
| Common codes | `[..]` `{..}` `<..>` `%s %d` `\n` |
| Stardew Valley | `$h $s $1` portraits, `#$b#` breaks, `#`, `@` player name, `^` gender split, `%noun` `%adj`, `{0}`, `[item]` |
| Square brackets / Curly braces / HTML / printf | just that kind |
| Pixel Crushers Dialogue System | `[panel=1]`, `\.` pauses |
| Custom | your own regular expression |

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl + Enter | Save, mark done, go to the next line |
| Ctrl + Shift + Enter | Save, mark "needs review", go to the next line |
| Alt + ↓ / ↑ | Next / previous line |
| Ctrl + S | Save everything to the file |
| Ctrl + Shift + C | Copy the original text into the box |
| Esc | Undo unsaved changes in this line |

## Where things are stored

Opened and dropped files are copied into the `workspace/` folder next to the app, one folder per
project (`original.*`, the working copy `lines.csv`, `project.json`, `glossary.json`, and
`lines.notes.json` with notes and who translated what). Your original file is only changed if you
choose *Into the original file*. To move a project to another computer, copy its folder into that
computer's `workspace/`. To delete a project, delete its folder.

Every edit is first written to a small journal file (`*.journal`) and put into the CSV a moment
later, so saving stays fast on big files and nothing is lost if the window is closed or the
computer crashes – the next start picks the journal up.

`workspace/`, CSV files, game files and API keys are kept out of git by `.gitignore`.

## Advanced: saved project files

Instead of dropping a file you can describe a project in `projects/<name>.json`. It then
shows up on the start screen and can point at a CSV anywhere and add an **Apply** button that
runs your own script (for example to put the translation straight into the game).
Open one directly with `python translator.py projects/<name>.json`.

```json
{
  "name": "My Game → Indonesian",
  "csv": "path/to/lines.csv",
  "glossary": "my-game.glossary.json",
  "columns": {
    "group": "file", "subgroup": "scene", "subgroup_id": "", "key": "id",
    "speaker": "character", "source": "english", "reference": "",
    "target": "translation", "status": "status",
    "labels": { "target": "Indonesian" }
  },
  "tag_pattern": "\\{[^}]*\\}|<[^>]+>",
  "apply": { "label": "Apply to game", "cwd": ".", "command": ["python", "my_import.py"] }
}
```

Paths are relative to the project file. `status` is added to the CSV if missing (empty or
`reviewed` = done, `review`/`machine`/`google`/`CHECK TAGS` = needs review), so you can mark
machine-translated lines for review from your own scripts. Saved projects edit their CSV
directly – every change is written into it a moment later, nothing to export.

### Example: Chained Echoes

`projects/chained-echoes.json` and `adapters/chained_echoes/` are a complete example: an
exporter that pulls all dialogue out of the game into a CSV, and an importer behind the
**Apply to game** button that writes the translation into one of the game's language slots
(French by default, English is never touched). Expected layout:

```
Chained Echoes/                         <- the game folder
└── translation/                        <- everything for the translation, in one place
    ├── dialogue.csv                    <- made by adapters/chained_echoes/export_dialogue.py
    ├── backup_original/                <- untouched game files the importer starts from
    ├── tools/.venv/                    <- Python environment with UnityPy
    └── Translation-personal-software/  <- this repo
```

Setup: `python -m venv tools\.venv`, `tools\.venv\Scripts\pip install UnityPy`, then
`tools\.venv\Scripts\python Translation-personal-software\adapters\chained_echoes\export_dialogue.py --game .. --out . --backup backup_original`
from inside `translation/`. Both adapter scripts take `--backup` (default `<game>/_backup_original`).
In the game, pick *Français*.

## Files

| Path | What it is |
|---|---|
| `translator.py` | The editor (local web server, standard library only) |
| `START_EDITOR.bat` / `START_SHARED.bat` | Start it (on its own / with teammates on your network) |
| `formats.py` | Reading CSV/TSV/JSON, guessing columns, exporting |
| `web/` | The editor's page, styles and script |
| `projects/` | Saved project files and their glossaries |
| `adapters/` | Game-specific export/import scripts (Chained Echoes) |
| `workspace/` | Your dropped-file projects (not in git) |
