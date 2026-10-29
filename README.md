# Translation Editor

A small app for translating game text by hand, one line at a time, instead of scrolling
through a huge CSV or JSON file. **Drag a file in, translate, export.** It runs on your own
computer, opens in your web browser, and needs nothing installed except Python.

Works with any game whose text you can get into a **CSV, TSV or JSON** file – for example
dialogue extracted from Stardew Valley, a mod's `i18n/default.json`, or a spreadsheet saved
as CSV.

## Start

1. Install [Python 3](https://www.python.org/downloads/) (tick "Add python.exe to PATH").
2. Download this repo (Code → Download ZIP) and unzip it.
3. Double-click **`START_EDITOR.bat`** (or run `python translator.py`).
   The editor opens at <http://127.0.0.1:8765/>.
4. **Drop your file** on the page (or click to choose it).
5. Check the setup screen – it guesses which column is the text, the speaker, the key, etc.
   – type the language you're translating into, and press **Start translating**.
6. When you're done (or any time), press **Export** to download the translated file.

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
- **Saves automatically** when you leave a box. Unsaved lines have an orange edge.
- **Export** gives the file back in its original format:
  - **JSON**: identical file, with each translated text in place of the original
    (numbers, nesting and order are kept), ready to drop back into the game or mod.
  - **CSV/TSV**: the original columns plus your translation column, same delimiter.
  - Choose whether untranslated lines keep the original text or stay empty.
- Light and dark mode, works on small screens too.

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
| Alt + ↓ / ↑ | Next / previous line |
| Ctrl + S | Save this line |
| Ctrl + Shift + C | Copy the original text into the box |
| Esc | Undo unsaved changes in this line |

## Where things are stored

Dropped files are copied into the `workspace/` folder next to the app, one folder per
project (`original.*`, the working copy `lines.csv`, `project.json` and `glossary.json`).
Your original file is never changed. To move a project to another computer, copy its folder
into that computer's `workspace/`. To delete a project, delete its folder.

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
`reviewed` = done, `machine`/`google`/`CHECK TAGS` = needs review), so you can mark
machine-translated lines for review from your own scripts.

### Example: Chained Echoes

`projects/chained-echoes.json` and `adapters/chained_echoes/` are a complete example: an
exporter that pulls all dialogue out of the game into a CSV, and an importer behind the
**Apply to game** button that writes the translation into one of the game's language slots
(French by default, English is never touched). Expected layout:

```
Chained Echoes/                     <- the game folder
├── translation/
│   ├── dialogue.csv                <- made by adapters/chained_echoes/export_dialogue.py
│   └── tools/.venv/                <- Python environment with UnityPy
└── Translation-personal-software/  <- this repo
```

Setup: `python -m venv tools\.venv`, `tools\.venv\Scripts\pip install UnityPy`, then
`tools\.venv\Scripts\python ..\Translation-personal-software\adapters\chained_echoes\export_dialogue.py --game .. --out .`
from inside `translation/`. In the game, pick *Français*.

## Files

| Path | What it is |
|---|---|
| `translator.py` | The editor (local web server, standard library only) |
| `formats.py` | Reading CSV/TSV/JSON, guessing columns, exporting |
| `web/` | The editor's page, styles and script |
| `projects/` | Saved project files and their glossaries |
| `adapters/` | Game-specific export/import scripts (Chained Echoes) |
| `workspace/` | Your dropped-file projects (not in git) |
