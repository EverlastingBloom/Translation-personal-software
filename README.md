# Translation Editor

A small app for translating game dialogue by hand, one line at a time, instead of scrolling
through a huge CSV or JSON file. It runs on your own computer and opens in your web browser.

It was built for an Indonesian fan translation of **Chained Echoes**, but works with any
CSV file that has a source-text column and a translation column.

## What it does

- **Sections and scenes in a sidebar** with progress bars, so you always know where you are.
- **One card per line**: who is speaking, the original text, an optional reference
  translation (e.g. the official German), and a box for your translation.
- **Tag guard**: game codes like `[panel=1]` are highlighted. If your translation does not
  keep exactly the same tags, it warns you and refuses to save, so the game cannot break.
- **Glossary**: terms from your glossary that appear in a line show up under it; click one to
  insert its fixed translation. Edit the glossary inside the app.
- **Search** all lines (original, translation or speaker) and **filter** by
  untranslated / needs review / done.
- **Saves automatically** to the CSV when you leave a box. Lines from machine translation
  are marked "Needs review" until you confirm them.
- **Apply button** (optional) runs your own script to put the translation into the game.
- Light and dark mode, works on small screens too.

Only the Python standard library is used, so the editor itself needs nothing installed.

## Quick start (Chained Echoes)

Expected folder layout:

```
Chained Echoes/                     <- the game folder
├── translation/
│   ├── dialogue.csv                <- created by the export script
│   └── tools/.venv/                <- Python environment with UnityPy (for export/apply)
└── Translation-personal-software/  <- this repo
```

1. Install [Python 3](https://www.python.org/downloads/) (tick "Add python.exe to PATH").
2. First time only: create the tools environment and export the dialogue:
   ```
   cd "Chained Echoes\translation"
   python -m venv tools\.venv
   tools\.venv\Scripts\pip install UnityPy
   tools\.venv\Scripts\python ..\Translation-personal-software\adapters\chained_echoes\export_dialogue.py --game .. --out .
   ```
3. Double-click **`START_EDITOR.bat`**. The editor opens at <http://127.0.0.1:8765/>.
4. Translate. When you want to see it in the game, press **Apply to game**, start the game
   and choose **Français** in the language options.

The first Apply copies the original game files to `Chained Echoes/_backup_original`.
Every Apply starts from those originals, so it is safe to run as often as you like.
To undo everything, copy the files from `_backup_original` back into the game.

### Why French?

Chained Echoes has no room for a new language, so the translation replaces one of the
existing ones. English is never touched. To replace a different language, add
`"--slot", "de"` (or `jp`, `ko`, `zh`) to the `apply` command in `projects/chained-echoes.json`.

Menus, items and skills are not covered: the game only has those in English.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl + Enter | Save, mark done, go to the next line |
| Alt + ↓ / ↑ | Next / previous line |
| Ctrl + S | Save this line |
| Ctrl + Shift + C | Copy the original text into the box |
| Esc | Undo unsaved changes in this line |

## Using it for another game

Make a project file, e.g. `projects/my-game.json`, and start the editor with it:
`python translator.py projects/my-game.json`

```json
{
  "name": "My Game → Indonesian",
  "csv": "path/to/lines.csv",
  "glossary": "my-game.glossary.json",
  "columns": {
    "group": "file",
    "subgroup": "scene",
    "speaker": "character",
    "source": "english",
    "reference": "",
    "target": "translation",
    "status": "status",
    "labels": { "target": "Indonesian" }
  },
  "tag_pattern": "\\{[^}]*\\}|<[^>]+>"
}
```

- Paths are relative to the project file.
- `group` and `subgroup` are the columns used for the sidebar (e.g. chapter and scene).
  Add `subgroup_id` if scene titles are not unique.
- `status` is created automatically if the CSV doesn't have it. Values: empty or `reviewed`
  = done, `google` or `CHECK TAGS` = needs review.
- `tag_pattern` is a regular expression for codes that must not be changed. Leave it empty
  if your game has none.
- `apply` (optional) adds a button that runs a command:
  `{"label": "Apply to game", "cwd": ".", "command": ["python", "my_import.py"]}`.

## Files

| Path | What it is |
|---|---|
| `translator.py` | The editor (local web server) |
| `web/` | The editor's page, styles and script |
| `projects/` | Project settings and glossaries |
| `adapters/chained_echoes/` | Export dialogue from / write a translation into Chained Echoes |

Your CSV files, game files and API keys are kept out of git by `.gitignore`.
