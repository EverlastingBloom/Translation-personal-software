"""Export all Chained Echoes dialogue into dialogue.csv + speaker_names.csv for translating.

Usage:  python export_dialogue.py --game "D:/GOG/Chained Echoes" --out "D:/GOG/Chained Echoes/translation"

Reads the ORIGINAL dialogue bundles from <game>/_backup_original if they are there (so a game
that already has a translation applied still exports the shipped text), otherwise from the game.
Requires: pip install UnityPy
"""
import argparse
import csv
import os
import sys

import UnityPy

BUNDLES = [
    "packedassets_assets_all.bundle",
    "duplicateassetisolation6_assets_all_0912e6789a7419e465e2306a084992fe.bundle",
]
ORDER = ["Prologue", "Main", "Mainquest Act I", "Mainquest Act II", "Mainquest Act III", "Mainquest Act IV",
         "Sidequest", "NPC", "Others", "Mainquest DLC", "NPC DLC"]
PREFIX = "Dialogue Database "


def fields(fs):
    return {f["title"]: f["value"] for f in fs}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", required=True, help="Chained Echoes install folder")
    ap.add_argument("--out", required=True, help="folder to write dialogue.csv and speaker_names.csv into")
    ap.add_argument("--target-column", default="indonesian", help="name of the empty translation column")
    ap.add_argument("--force", action="store_true", help="overwrite existing CSV files")
    args = ap.parse_args()

    out_csv = os.path.join(args.out, "dialogue.csv")
    if os.path.exists(out_csv) and not args.force:
        sys.exit(f"{out_csv} already exists. Use --force to overwrite it (your translations in it would be lost).")
    backup = os.path.join(args.game, "_backup_original")
    live = os.path.join(args.game, "Chained Echoes_Data", "StreamingAssets", "aa", "StandaloneWindows64")
    dbs = {}
    for name in BUNDLES:
        path = os.path.join(backup, name) if os.path.exists(os.path.join(backup, name)) else os.path.join(live, name)
        for obj in UnityPy.load(path).objects:
            if obj.type.name != "MonoBehaviour":
                continue
            tt = obj.read_typetree()
            if tt.get("m_Name", "").startswith(PREFIX):
                dbs[tt["m_Name"][len(PREFIX):]] = tt

    rows, speakers = [], {}
    for db in ORDER:
        tt = dbs[db]
        actors = {}
        for a in tt["actors"]:
            f = fields(a["fields"])
            name = f.get("Display Name") or f.get("Name", "")
            actors[str(a["id"])] = name
            if name and name not in speakers:
                speakers[name] = f.get("Display Name de", "")
        for conv in tt["conversations"]:
            title = fields(conv["fields"]).get("Title", "")
            for entry in conv["dialogueEntries"]:
                f = fields(entry["fields"])
                for fld in ("Dialogue Text", "Menu Text"):
                    english = f.get(fld, "")
                    if english.strip():
                        rows.append([db, conv["id"], entry["id"], fld, title,
                                     actors.get(f.get("Actor", ""), ""), english, f.get("de", ""), ""])

    os.makedirs(args.out, exist_ok=True)
    with open(out_csv, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["database", "conversation_id", "entry_id", "field", "conversation_title", "speaker",
                    "english", "german_reference", args.target_column])
        w.writerows(rows)
    with open(os.path.join(args.out, "speaker_names.csv"), "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["english", "german_reference", args.target_column])
        for k, v in sorted(speakers.items()):
            w.writerow([k, v, ""])
    print(f"{len(rows)} dialogue lines and {len(speakers)} speaker names written to {args.out}")


if __name__ == "__main__":
    main()
