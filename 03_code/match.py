import csv, json, sys

def load_rules(path="irdai_non_payables.csv"):
    rules = []
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            r["keywords"] = [k.strip().lower() for k in r["match_keywords"].split("|") if k.strip()]
            rules.append(r)
    return rules

def match_line(item_text, rules):
    t = item_text.lower()
    for r in rules:
        for kw in r["keywords"]:
            if kw in t:
                return r, kw
    return None, None

rules = load_rules()
bill  = json.load(open("bill.json"))["line_items"]

# normalise credit lines: trust the total's sign
for l in bill:
    if l["total"] is not None and l["total"] < 0 and l["quantity"] > 0:
        l["quantity"] = -abs(l["quantity"])

hits, misses = [], []
for l in bill:
    r, kw = match_line(l["item"], rules)
    (hits if r else misses).append((l, r, kw))

flagged  = sum(l["total"] for l, r, k in hits if r["confidence"] == "exact")
review   = sum(l["total"] for l, r, k in hits if r["confidence"] == "review")
ACTUAL   = 5962.00

print("="*74)
print("MATCHED - flagged as IRDAI non-payable")
print("="*74)
for l, r, kw in sorted(hits, key=lambda x: -x[0]["total"]):
    if r["confidence"] == "exact":
        print(f"  {l['total']:>9,.2f}  {l['item'][:44]:<46} -> {r['item'][:30]}")
print(f"  {'':>9}  {'':<46}    {'-'*30}")
print(f"  {flagged:>9,.2f}  TOTAL FLAGGED (exact)")
if review:
    print(f"\n  needs human review (not auto-flagged):")
    for l, r, kw in hits:
        if r["confidence"] == "review":
            print(f"    {l['total']:>9,.2f}  {l['item'][:40]:<42} -> {r['item']}")
    print(f"    {review:>9,.2f}  subtotal")

print()
print("="*74)
print("COVERAGE AGAINST THE REAL DEDUCTION")
print("="*74)
print(f"  Actual 'Other Deductions' on TPA letter   {ACTUAL:>10,.2f}")
print(f"  Explained by IRDAI list (exact)           {flagged:>10,.2f}   {flagged/ACTUAL*100:>5.1f}%")
print(f"  Explained incl. review items              {flagged+review:>10,.2f}   {(flagged+review)/ACTUAL*100:>5.1f}%")
print(f"  Unexplained                               {ACTUAL-flagged-review:>10,.2f}")

# what if the insurer deducted consumables wholesale?
cons = sum(l["total"] for l in bill if l["category"] == "Consumables")
extra = sum(l["total"] for l in bill if l["category"]=="Consumables" and not match_line(l["item"], rules)[0])
print()
print(f"  Consumables category total                {cons:>10,.2f}")
print(f"  ...of which unmatched by the IRDAI list   {extra:>10,.2f}")
print(f"  If consumables were deducted wholesale:   {flagged+review+extra:>10,.2f}   {(flagged+review+extra)/ACTUAL*100:>5.1f}%")
