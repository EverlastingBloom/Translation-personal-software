# Translation Editor

A small app for translating game text by hand, one line at a time, instead of scrolling
through a huge CSV or JSON file. **Open a file, translate, it saves itself.** It runs on your own
computer, opens in your web browser, and needs nothing installed except Python. Translate as a
team from anywhere through a GitHub repository (one **Sync** button), or live over your Wi-Fi.

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

### Saving: straight into the file you opened

Open a file with **Open a file…** and the translation is saved **into that same file** – there is
nothing to choose and nothing to export.

- **CSV/TSV**: the editor works on the file itself. Every change is written into it a moment after
  you make it, and when the file changes on disk (a **Pull** in GitHub Desktop, a script, OneDrive)
  the editor reads it again – so after a Pull just open the project from **Your projects**.
  The CSV keeps exactly its columns (plus your translation column if it had none); "needs review"
  flags, notes and who translated what go into `<name>.notes.json` next to it.
- **JSON**: the file gets its texts replaced by the translation (the editor keeps the original
  texts in its own copy).

The file comes back in the original format:

- **JSON**: identical file, with each translated text in place of the original
  (numbers, nesting and order are kept), ready to drop back into the game or mod.
- **CSV/TSV**: the original columns plus your translation column, same delimiter.
- Untranslated lines keep the original text (default for JSON, so the game has every line) or
  stay empty (default for CSV, so you see what's missing). Change it in the **▾** menu next to
  Save, which also has **Download a copy** and lets you switch the file or turn off auto-updating.

Files dropped on the page don't tell the editor where they came from, so for those you pick the
place the first time you press Save. Use **Open a file…** to skip that.

**Older projects** (made before this version) keep their own copy and only *write* it into the
file, so they don't see a Pull. Their card in **Your projects** says *Old copy* – press
**Use <file> itself** on it. The file's text is kept (with your teammates' pulled lines), and
lines, review flags and notes only the copy has are added to it; the copy is moved to
`workspace/.old`. Until then such a copy refuses to write over a file that changed outside the
editor, so a Pull is never undone by Save.

## Working together – with people anywhere in the world

Everyone runs their own copy of this editor. The game text lives in a **GitHub repository**
(the "translation repo") that everybody downloads. The editor works on that CSV directly and the
**⇅ Sync** button shares your lines and brings in everyone else's – no exporting, no emailing
files around.

What makes this comfortable:

- **Small, clean changes.** Only the lines you translated are rewritten in the CSV; quoting,
  line endings and encoding of every other line stay byte-for-byte the same.
- **No git conflicts between lines.** The editor merges the CSV *game line by game line*, so two
  people translating neighbouring lines (or different scenes) never get in each other's way.
  Notes, scene claims and the glossary are merged the same way.
- **Same line, two translations?** After a Sync the editor shows both versions on that line
  (and a bar at the top: "1 line was translated differently") – click *Keep mine* or *Use theirs*.
- **Who does what:** your name is shown next to the lines you translate; **✋ Claim this scene**
  tells the team you're on it; notes travel with the file.
- **Team panel:** what you haven't shared yet, updates from teammates waiting (the editor checks
  GitHub every few minutes – the Sync button then shows ↓), and recent activity.

### Set up (once, by the project owner)

1. Create a GitHub repository with the game text CSV in it and download it to your computer –
   easiest with [GitHub Desktop](https://desktop.github.com/): *File → New repository* (or
   *Clone repository* if it already exists on GitHub).
2. Start the editor, press **Open a file…** and pick the CSV inside that folder.
3. Check the columns on the setup screen and press **Start translating**. The editor adds
   `<name>.translation.json` (the column setup) next to the CSV.
4. Press **⇅ Sync**. That uploads the setup; the first time a GitHub sign-in window may appear.
5. Invite your translators on GitHub: the repository → *Settings → Collaborators → Add people*.

### Join (each translator)

1. Install [Python 3](https://www.python.org/downloads/) (tick "Add python.exe to PATH") and
   [GitHub Desktop](https://desktop.github.com/), and sign in to GitHub there.
2. Download this editor: <https://github.com/EverlastingBloom/Translation-personal-software> →
   *Code → Download ZIP*, unzip.
3. In GitHub Desktop: *File → Clone repository* → the translation repo.
4. Start the editor (`START_EDITOR.bat`), press **Open a file…** and pick the CSV in the cloned
   folder. It opens with everything already set up.
5. Translate, and press **⇅ Sync** when you start, now and then, and when you stop.

Sync = save → commit your lines → bring in teammates' lines → upload. If something is in the way
the editor says what to do in plain words (no permission → ask the owner to add you; not signed
in → sign in once in GitHub Desktop; no internet; …). Pulling with GitHub Desktop or plain git is
fine too: once the editor has opened the project on that computer, git uses its line-by-line
merge, and if a pull ever stops with `<<<<<<<` conflict markers in the CSV, the editor finishes
that merge itself the next time it opens the project.

### Online: the team website (no installing, no git)

The `docs/` folder is a website for translating together from anywhere: sign in with a password,
translate in the browser, and see each other's work live. It runs on **GitHub Pages** (free) with
**Supabase** (free) as the database.

- **Invite only.** The admin adds emails in the admin panel; nobody else can create an account.
- **Welcome page.** After signing in you land on a home page: your time zone and local time, how
  long the project has been running (a live clock counting from the repository's first commit,
  set as `started` in `docs/config.js`), how far each project is (percentage finished and a
  progress bar), the scenes you've claimed, what you wrote this week, what's waiting for review,
  and your latest messages. **Continue translating** opens the project.
- **The header** has the pages in the middle (Home, Translate, Messages, Dashboard), the search
  on the right while translating (press **/** to jump into it), and your initials: click them for
  your account, the admin power switch, the Admin panel and Sign out. The thin line along the
  bottom of the header is the project's progress (hover it for the numbers).
- **Messages.** Write directly to anyone on the team. Only the two of you can read a conversation;
  new messages arrive live, and the *Messages* button shows how many are unread. A message shows
  up the moment you press Enter (and offers *Try again* if it couldn't be sent). **↩ Reply** quotes
  the message you answer; clicking a quote jumps to the original.
- **Reviewing per person.** *⚑ Everything waiting for review* has a tab for everyone and one tab
  per person with their count. Everyone has their own colour and initials, shown on each line
  ("⚑ from …") and on every version, so you can see at a glance who submitted what.
- **Nothing is overwritten.** Every translation is a *version* with its author and time. If two
  people translate the same line, both versions wait side by side; the approved one becomes the
  main translation, the rest stay in the line's history.
- **Approved by a 2/3 vote.** Everyone who "can vote" (set per person in *Admin → Team*) votes
  **👍 Agree** or **👎 Disagree** on the others' waiting translations – never on their own. A
  version is approved as soon as 2/3 of the people who can vote on it agree (e.g. 2 of 3, 3 of 4),
  and turned down once 2/3 can't be reached any more. Each version shows how many agree votes it
  still needs and who voted; the **🗳 Needs your vote** tab lists what you haven't voted on yet.
  Changing the words of a suggestion clears its votes. The **admin** doesn't vote: they can
  approve or turn down any version directly, at any time.
- **Admin power switch.** *Admin powers* in the menu under the admin's initials switches their
  admin powers off: they then translate and vote like everyone else (and count as a voter), and
  the Admin panel, Dashboard and direct approving are gone until they switch it back on.
- **Notes** are a small conversation on each line. **✋ Claim** tells the others you're on a scene
  (it doesn't lock it).
- **Admin panel:** invite or remove people, who can vote, import a game file (with the desktop
  editor's `.translation.json` and `.notes.json`, so names, review flags and notes come along),
  **export the game file** (only approved lines, or also the waiting ones).
  The exported CSV is byte-for-byte the original except the lines whose translation changed.
- **Dashboard (admin):** progress at a glance, a chart of approved lines and of translations
  written per week, and a **weekly report** for any of the last 12 weeks: who wrote, reviewed and
  commented how much (compared with the week before) and which scenes the work went into.
  **Copy weekly report** puts it on the clipboard as plain text for the team chat. Below that,
  each person's work week by week and their contributions so far.
- **Updating an older database:** a database set up before a feature existed needs its update run
  once, in order (Supabase → SQL Editor → New query → paste → Run):
  `update-1-admin-approves-own.sql`, `update-2-dashboard.sql` (the dashboard), `update-3-welcome-messages.sql` (messages and the
  welcome page's progress), `update-4-replies-review-tabs.sql` (replies, review tabs per person),
  `update-5-votes.sql` (approving by 2/3 vote),
  `update-6-admin-power.sql` (the admin power switch),
  all in `docs/supabase/`.

Set up once (admin):

1. In `docs/supabase/schema.sql`, put **your** email and name on the last line (marked *ADMIN*).
   In Supabase: **SQL Editor → New query**, paste the whole file, **Run**.
2. Supabase → **Authentication → URL Configuration**: set *Site URL* (and add it under *Redirect
   URLs*) to `https://everlastingbloom.github.io/Translation-personal-software/`.
3. Supabase → **Authentication → Sign In / Providers → Email**: keep *Allow new users to sign up*
   and *Confirm email* **on** (the database itself refuses emails that weren't invited).
4. GitHub → this repository → **Settings → Pages**: *Deploy from a branch*, branch `main`,
   folder `/docs`, **Save**. After a minute the site is at the address above.
5. Open the site → *First time here? Create your password* with your admin email → confirm the
   email → sign in → **Admin → Projects → Import a game file**.
6. **Admin → Team**: invite your translators and send them the link.

`docs/config.js` holds the Supabase address and its *publishable* key – both are meant to be
public. Never put the *secret / service_role* key in this repository.

### Same Wi-Fi: translate live in one editor

Double-click **`START_SHARED.bat`** (or `python translator.py --share`). The window shows a link;
send it to teammates on the same network. Lines others save appear on your screen within
seconds, you see who is on which line ("Ana is here"), and if two people change the same line at
once the editor asks which version to keep. Only people with the link (it contains a secret
code) get in; choosing files, Sync and *Apply* stay with the person running the editor. If
Windows asks, allow Python on private networks.

### Got a file from a teammate?

**Team → Merge a file…** brings in someone's saved/downloaded file of this project (or any file
with the same keys or original texts). Lines are matched by key, otherwise by identical original
text; merged lines are marked *needs review* by default and your existing translations are kept
unless you tick *Replace*.

If a project's CSV is changed by another program while the editor is open (an import script,
OneDrive, GitHub Desktop), the editor notices and loads the new version; edits you made that
weren't written yet are put back on top.

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
| (Team projects) ⇅ Sync | Share your lines, get your team's |
| Ctrl + Shift + C | Copy the original text into the box |
| Esc | Undo unsaved changes in this line |

## Where things are stored

A CSV/TSV you open has no copy: the editor edits the file itself and keeps these next to it
(in a GitHub repository they are all shared through git):

| File | What it is |
|---|---|
| `dialogue.csv` | The game text with your translation column |
| `dialogue.translation.json` | Which column is what, the code preset – teammates open the project with it |
| `dialogue.notes.json` | Notes, and who translated each line |
| `dialogue.claims.json` | Who is working on which scene |
| `dialogue.glossary.json` | The shared glossary |
| `.gitattributes` | Tells git to merge these files line by line (see `gitsync.py`) |

JSON files and dropped files are copied into the `workspace/` folder next to the app, one folder
per project (`original.*`, the working copy `lines.csv`, `project.json`, `glossary.json`,
`lines.notes.json`). To delete such a project, delete its folder.

Lines still to decide after a Sync are kept inside `.git/` (only on your computer).

Every edit is first written to a small journal file in `workspace/.local/` and put into the CSV a
moment later, so saving stays fast on big files and nothing is lost if the window is closed or
the computer crashes – the next start picks the journal up. Projects opened from other folders
are remembered in `settings.json`.

`workspace/`, `settings.json`, CSV files, game files and API keys are kept out of this app's git
repository by `.gitignore`.

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
| `formats.py` | Reading CSV/TSV/JSON (keeping the file's exact formatting), guessing columns, exporting |
| `gitsync.py` | Sync with a team through git, and the line-by-line merge git uses |
| `web/` | The editor's page, styles and script |
| `projects/` | Saved project files and their glossaries |
| `adapters/` | Game-specific export/import scripts (Chained Echoes) |
| `workspace/` | Your dropped-file projects (not in git) |
