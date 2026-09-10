"""
Cross-check irdai_non_payables.csv against the official IRDAI standardized
"List of excluded items" (List I, 68 items) as reproduced by insurers
(e.g. New India Assurance "List_of_excluded_items.pdf").

The IRDAI Master Circular on Health Insurance Business (29 May 2024) consolidated
earlier circulars but did NOT replace this list — List I / II / III / IV from the
2016 standardization circular and the 2020 Guidelines on Standardization of
Exclusions remain the operative annexure.

Reports:
  A. official items with NO matching row  -> a gap (missing flag)
  B. csv rows graded "exact" that cannot be tied to an official item -> should
     be "review", not "exact" (a wrong flag costs more than a missing one)
"""
import csv, os, re

HERE = os.path.dirname(os.path.abspath(__file__))

OFFICIAL_68 = [
    "baby food", "baby utilities charges", "beauty services", "belts/ braces", "buds",
    "cold pack/hot pack", "carry bags", "email / internet charges",
    "food charges (other than patient's diet provided by hospital)", "leggings",
    "laundry charges", "mineral water", "sanitary pad", "telephone charges", "guest services",
    "crepe bandage", "diaper of any type", "eyelet collar", "slings",
    "blood grouping and cross matching of donors samples",
    "service charges where nursing charge also charged", "television charges", "surcharges",
    "attendant charges", "extra diet of patient", "birth certificate", "certificate charges",
    "courier charges", "conveyance charges", "medical certificate", "medical records",
    "photocopies charges", "mortuary charges", "walking aids charges",
    "oxygen cylinder (for usage outside the hospital)", "spacer", "spirometre", "nebulizer kit",
    "steam inhaler", "armsling", "thermometer", "cervical collar", "splint", "diabetic foot wear",
    "knee braces (long/ short/ hinged)", "knee immobilizer/shoulder immobilizer",
    "lumbo sacral belt", "nimbus bed or water or air bed charges", "ambulance collar",
    "ambulance equipment", "abdominal binder", "private nurses charges- special nursing charges",
    "sugar free tablets", "creams powders lotions", "ecg electrodes", "gloves",
    "nebulisation kit", "any kit with no details mentioned", "kidney tray", "mask", "ounce glass",
    "oxygen mask", "pelvic traction belt", "pan can", "trolly cover", "urometer, urine jug",
    "ambulance", "vasofix safety",
]

# tokens that tie a CSV row's item/keywords back to an official entry
OFFICIAL_TOKENS = set()
for o in OFFICIAL_68:
    for t in re.split(r"[^a-z]+", o):
        if len(t) >= 4:
            OFFICIAL_TOKENS.add(t)
# a few obvious synonyms the CSV may use
SYNONYMS = {
    "registration": "certificate charges", "documentation": "certificate charges",
    "tpa": "surcharges", "admission": "certificate charges", "sterillium": "creams powders lotions",
    "savlon": "creams powders lotions", "swab": "creams powders lotions",
    "gown": "gloves", "apron": "gloves", "cap": "mask", "shoe cover": "mask",
    "toiletr": "creams powders lotions", "comb": "beauty services", "powder": "creams powders lotions",
}

rows = list(csv.DictReader(open(os.path.join(HERE, "irdai_non_payables.csv"), encoding="utf-8")))

def row_text(r):
    return (r["item"] + " " + r["match_keywords"]).lower()

def squash(s):
    return re.sub(r"[^a-z]", "", s.lower())

OFFICIAL_SQUASHED = [squash(o) for o in OFFICIAL_68]

# official #54 makes ALL toiletries non-payable -> these inherit "exact" legitimately
TOILETRY_PARENT = ("slipper", "tooth", "towel", "brush", "tissue", "moistur", "cologne",
                   "freshner", "freshener", "comb", "powder", "soap", "shampoo", "razor",
                   "sponge", "hand wash", "handwash")
# standardized policy EXCLUSIONS (Excl01-16), non-payable but NOT List I -> recite source
POLICY_EXCLUSION = ("hormone replacement", "infertility", "assisted conception", "obesity",
                    "refractive error", "aesthetic", "cosmetic", "stem cell", "dental treatment")

def official_hit(txt):
    sq = squash(txt)
    if any(o and o in sq for o in OFFICIAL_SQUASHED):
        return True
    toks = set(t for t in re.split(r"[^a-z]+", txt.lower()) if len(t) >= 4)
    return bool(toks & OFFICIAL_TOKENS) or any(s in txt.lower() for s in SYNONYMS)

orphan_exact, toiletry_ok, exclusion_reclass = [], [], []
for r in rows:
    if r["confidence"] != "exact":
        continue
    txt = row_text(r)
    if official_hit(txt):
        continue
    if any(p in txt.lower() for p in TOILETRY_PARENT):
        toiletry_ok.append(r["item"]); continue
    if any(p in txt.lower() for p in POLICY_EXCLUSION):
        exclusion_reclass.append(r["item"]); continue
    orphan_exact.append(r["item"])

# A. official items not represented by any row
missing = [o for o in OFFICIAL_68 if not any(official_hit(row_text(r)) and
           squash(o) in squash(row_text(r)) for r in rows)]

print(f"irdai_non_payables.csv        {len(rows)} rows "
      f"({sum(1 for r in rows if r['confidence']=='exact')} exact, "
      f"{sum(1 for r in rows if r['confidence']=='review')} review)")
print(f"official IRDAI List I         68 items\n")

print(f"A. Official List I items with no obvious matching row  ({len(missing)})")
print(f"   (eyeball each — some are covered by a differently-worded row)")
for m in missing:
    print(f"   - {m}")

print(f"\nB. 'exact' rows that ARE defensible — toiletries inheriting official #54")
print(f"   'CREAMS POWDERS LOTIONS (Toiletries are not payable)'  ({len(toiletry_ok)})")
for o in toiletry_ok:
    print(f"   - {o}")

print(f"\nC. 'exact' rows that are POLICY EXCLUSIONS (Excl01-16), not List I  ({len(exclusion_reclass)})")
print(f"   non-payable, but cite the exclusion clause — not the non-medical list")
for o in exclusion_reclass:
    print(f"   - {o}")

print(f"\nD. 'exact' rows with NO tie to the official list or a parent category  ({len(orphan_exact)})")
print(f"   RE-GRADE THESE 'review' — commonly deducted but contested. A wrong flag")
print(f"   costs more credibility than a missing one.")
for o in orphan_exact:
    print(f"   - {o}")

print("\nE. Scope note: this CSV = List I only (items the patient absorbs).")
print("   Lists II/III/IV (subsumed into room / procedure / treatment charges) are")
print("   not included. A bill that itemises a II/III/IV line separately would be missed.")
