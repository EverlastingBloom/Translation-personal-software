"""Write a translation from dialogue.csv into one of Chained Echoes' language slots.

Usage:  python import_translation.py --game "D:/GOG/Chained Echoes" [--csv-dir DIR] [--slot fr]

The game has no slot for new languages, so the translation replaces an existing one
(default: French). English is never touched. Pick that language in the game's options.

On first run the original files are copied to <game>/_backup_original (or --backup). Every run starts from
those originals, so it can be repeated as often as you like. Restore the backup to undo.
Untranslated lines show English; pass --keep-original to leave the slot's own text instead.
Requires: pip install UnityPy
"""
import argparse
import base64
import csv
import json
import os
import shutil
import sys

import UnityPy

BUNDLES = [
    "packedassets_assets_all.bundle",
    "duplicateassetisolation6_assets_all_0912e6789a7419e465e2306a084992fe.bundle",
]
# The DLC bundle is CRC-checked by Addressables; an edited bundle must have that check off.
CRC_OLD = '"m_Crc":2003635051'
CRC_NEW = '"m_Crc":0' + " " * (len(CRC_OLD) - len('"m_Crc":0'))  # same length keeps catalog offsets valid
SLOTS = {"de": "German", "fr": "French", "jp": "Japanese", "ko": "Korean", "zh": "Chinese"}


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def set_field(fields, title, value):
    for f in fields:
        if f["title"] == title:
            f["value"] = value
            return
    fields.append({"title": title, "value": value, "type": 4, "typeString": "CustomFieldType_Localization"})


def ensure_backup(backup, bundle_dir, aa):
    os.makedirs(backup, exist_ok=True)
    for name, src in [(b, os.path.join(bundle_dir, b)) for b in BUNDLES] + [("catalog.json", os.path.join(aa, "catalog.json"))]:
        dst = os.path.join(backup, name)
        if not os.path.exists(dst):
            shutil.copy2(src, dst)
            print("backed up", name)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", required=True, help="Chained Echoes install folder")
    ap.add_argument("--csv-dir", help="folder with dialogue.csv and speaker_names.csv (default: <game>/translation)")
    ap.add_argument("--backup", help="folder holding the original game files (default: <game>/_backup_original)")
    ap.add_argument("--column", default="indonesian", help="CSV column holding the translation")
    ap.add_argument("--slot", default="fr", choices=sorted(SLOTS), help="language slot to replace")
    ap.add_argument("--keep-original", "--keep-french", action="store_true",
                    help="leave the slot's own text on untranslated lines instead of English")
    args = ap.parse_args()

    game = os.path.abspath(args.game)
    csv_dir = args.csv_dir or os.path.join(game, "translation")
    backup = os.path.abspath(args.backup) if args.backup else os.path.join(game, "_backup_original")
    aa = os.path.join(game, "Chained Echoes_Data", "StreamingAssets", "aa")
    bundle_dir = os.path.join(aa, "StandaloneWindows64")
    ensure_backup(backup, bundle_dir, aa)
    targets = {"Dialogue Text": args.slot, "Menu Text": "Menu Text " + args.slot}

    lines = {}
    for r in read_csv(os.path.join(csv_dir, "dialogue.csv")):
        key = (r["database"], int(r["conversation_id"]), int(r["entry_id"]), r["field"])
        lines[key] = (r["english"], r[args.column].strip())
    speakers = {}
    speaker_csv = os.path.join(csv_dir, "speaker_names.csv")
    if os.path.exists(speaker_csv):
        speakers = {r["english"]: r[args.column].strip() for r in read_csv(speaker_csv) if r[args.column].strip()}

    translated = fallback = 0
    for bundle in BUNDLES:
        env = UnityPy.load(os.path.join(backup, bundle))
        for obj in env.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            tt = obj.read_typetree()
            name = tt.get("m_Name", "")
            if not name.startswith("Dialogue Database "):
                continue
            db = name[len("Dialogue Database "):]
            for actor in tt["actors"]:
                f = {x["title"]: x["value"] for x in actor["fields"]}
                english_name = f.get("Display Name") or f.get("Name", "")
                if english_name in speakers:
                    set_field(actor["fields"], "Display Name " + args.slot, speakers[english_name])
            for conv in tt["conversations"]:
                for entry in conv["dialogueEntries"]:
                    for src, dst in targets.items():
                        hit = lines.get((db, conv["id"], entry["id"], src))
                        if not hit:
                            continue
                        english, translation = hit
                        if translation:
                            set_field(entry["fields"], dst, translation)
                            translated += 1
                        elif not args.keep_original:
                            set_field(entry["fields"], dst, english)
                            fallback += 1
            obj.save_typetree(tt)
            print("patched", name)
        with open(os.path.join(bundle_dir, bundle), "wb") as fh:
            fh.write(env.file.save(packer="lz4"))

    with open(os.path.join(backup, "catalog.json"), encoding="utf-8") as fh:
        catalog = fh.read()
    # The bundle options sit base64-encoded as UTF-16 inside m_ExtraDataString, so patch them there
    # and swap only that string, leaving the rest of the file byte-for-byte as shipped.
    extra_b64 = json.loads(catalog)["m_ExtraDataString"]
    extra = base64.b64decode(extra_b64)
    old, new = CRC_OLD.encode("utf-16-le"), CRC_NEW.encode("utf-16-le")
    if extra.count(old) != 1 or catalog.count(extra_b64) != 1:
        sys.exit("catalog.json: unexpected layout, CRC not patched")
    catalog = catalog.replace(extra_b64, base64.b64encode(extra.replace(old, new)).decode("ascii"))
    with open(os.path.join(aa, "catalog.json"), "w", encoding="utf-8", newline="") as fh:
        fh.write(catalog)

    print("%d lines translated, %d untranslated lines %s" % (
        translated, fallback, "keep the original %s" % SLOTS[args.slot] if args.keep_original else "show English"))
    print("Done. In the game, choose %s in the language options." % SLOTS[args.slot])


if __name__ == "__main__":
    main()
