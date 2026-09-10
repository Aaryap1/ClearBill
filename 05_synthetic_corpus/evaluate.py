"""
evaluate.py — score a bill extraction against known ground truth.

    python evaluate.py --truth truth/SYN-07.json --extraction my_extraction.json
    python evaluate.py --corpus .            # score every SYN-*.json that has a
                                             #   matching *_extraction.json beside it
    python evaluate.py --selftest            # prove the scorer itself

An "extraction" is whatever the model returned:
    { "header": {...}, "line_items": [ {item, unit, quantity, rate, total, section} ],
      "printed_subtotals": { "<SECTION>": <number> } }      # header / subtotals optional

Scoring, per bill
    line_accuracy   = correct_lines / truth_line_count
                      a line is "correct" only if it is matched AND its total and
                      quantity match. A misread amount is NOT correct.
    hallucinations  = extracted lines that match no truth line (counted, never
                      folded into the percentage)
    item_recall     = (correct + wrong_value) / truth_line_count
    value_accuracy  = correct / (correct + wrong_value)
    header_accuracy = correct header fields / non-null truth header fields

Report synthetic accuracy and real-bill accuracy SEPARATELY. A synthetic bill
renders from clean data, so it is easier than a phone photo of a real bill.
Blending the two into one figure hides that.
"""
import argparse, json, os, re, sys

# ----------------------------------------------------------------- normalisation
_CODE = re.compile(r"\b\d{3,}\b")           # trailing item codes like " 10003"
_WS = re.compile(r"\s+")
_PUNCT = re.compile(r"[^a-z0-9 ]")

def norm_item(s):
    s = (s or "").lower()
    s = _PUNCT.sub(" ", s)
    s = _CODE.sub(" ", s)
    return _WS.sub(" ", s).strip()

def toks(s):
    return set(norm_item(s).split())

def money_eq(a, b, tol=0.5):
    if a is None or b is None:
        return a == b
    return abs(float(a) - float(b)) <= tol

def num_eq(a, b, tol=0.01):
    if a is None or b is None:
        return a == b
    try:
        return abs(float(a) - float(b)) <= tol
    except (TypeError, ValueError):
        return False

# ----------------------------------------------------------------- line matching
def match_lines(truth_lines, ex_lines):
    """Greedy best-match. Returns (pairs, missed_truth_idx, hallucination_ex_idx)."""
    used_ex = set()
    pairs = []
    missed = []
    for ti, t in enumerate(truth_lines):
        tt = toks(t["item"])
        best, best_score = None, 0.0
        for ei, e in enumerate(ex_lines):
            if ei in used_ex:
                continue
            et = toks(e.get("item", ""))
            if not tt or not et:
                continue
            jac = len(tt & et) / len(tt | et)
            same_total = money_eq(t.get("total"), e.get("total"))
            score = jac + (0.35 if same_total else 0.0)
            if score > best_score:
                best, best_score = ei, score
        # accept if decent token overlap, or exact-total with any overlap
        if best is not None and best_score >= 0.45:
            used_ex.add(best)
            pairs.append((ti, best))
        else:
            missed.append(ti)
    halluc = [ei for ei in range(len(ex_lines)) if ei not in used_ex]
    return pairs, missed, halluc

# ----------------------------------------------------------------- scoring
HEADER_KEYS = [
    "hospital_name", "hospital_gstin", "bill_number", "bill_datetime",
    "patient_name", "patient_age", "patient_gender", "patient_hospital_id",
    "patient_uhid", "admission_datetime", "discharge_datetime", "admission_type",
    "gross_amount", "discount_amount", "net_payable",
]

def _hnorm(v):
    if v is None:
        return None
    return _WS.sub(" ", str(v).lower().replace(",", "").strip())

def score_bill(truth, extraction):
    tlines = truth["line_items"]
    elines = extraction.get("line_items", [])
    pairs, missed, halluc = match_lines(tlines, elines)

    correct = wrong_value = 0
    line_detail = []
    for ti, ei in pairs:
        t, e = tlines[ti], elines[ei]
        ok_total = money_eq(t.get("total"), e.get("total"))
        ok_qty = num_eq(t.get("quantity"), e.get("quantity"))
        if ok_total and ok_qty:
            correct += 1
            line_detail.append(("correct", t["item"]))
        else:
            wrong_value += 1
            line_detail.append(("wrong_value", t["item"],
                                {"truth_total": t.get("total"), "got_total": e.get("total"),
                                 "truth_qty": t.get("quantity"), "got_qty": e.get("quantity")}))
    for ti in missed:
        line_detail.append(("missed", tlines[ti]["item"]))
    for ei in halluc:
        line_detail.append(("hallucination", elines[ei].get("item", "?")))

    n = len(tlines)
    line_accuracy = correct / n if n else 1.0
    item_recall = (correct + wrong_value) / n if n else 1.0
    value_accuracy = correct / (correct + wrong_value) if (correct + wrong_value) else 1.0

    # header
    th = truth.get("header", {}) or {}
    eh = extraction.get("header", {}) or {}
    hchecked = hcorrect = 0
    hdetail = []
    for k in HEADER_KEYS:
        if th.get(k) in (None, ""):
            continue
        hchecked += 1
        if k in ("gross_amount", "discount_amount", "net_payable"):
            good = money_eq(_num(th.get(k)), _num(eh.get(k)), tol=1.0)
        else:
            good = _hnorm(th.get(k)) == _hnorm(eh.get(k))
        hcorrect += good
        if not good:
            hdetail.append({"field": k, "truth": th.get(k), "got": eh.get(k)})
    header_accuracy = hcorrect / hchecked if hchecked else None

    # printed subtotals (only if the extraction reported them)
    sub_detail = []
    et_sub = extraction.get("printed_subtotals") or {}
    tt_sub = truth.get("printed_subtotals") or {}
    sub_checked = sub_correct = 0
    if et_sub:
        for sec, val in tt_sub.items():
            sub_checked += 1
            if money_eq(val, et_sub.get(sec), tol=1.0):
                sub_correct += 1
            else:
                sub_detail.append({"section": sec, "truth": val, "got": et_sub.get(sec)})
    subtotal_accuracy = sub_correct / sub_checked if sub_checked else None

    return {
        "id": truth["id"],
        "truth_lines": n,
        "extracted_lines": len(elines),
        "correct": correct,
        "wrong_value": wrong_value,
        "missed": len(missed),
        "hallucinations": len(halluc),
        "line_accuracy": round(line_accuracy, 4),
        "item_recall": round(item_recall, 4),
        "value_accuracy": round(value_accuracy, 4),
        "header_accuracy": None if header_accuracy is None else round(header_accuracy, 4),
        "header_checked": hchecked,
        "subtotal_accuracy": None if subtotal_accuracy is None else round(subtotal_accuracy, 4),
        "is_clean_bill": truth.get("is_clean"),
        "detail": {"lines": line_detail, "header_misses": hdetail, "subtotal_misses": sub_detail},
    }

def _num(v):
    if v in (None, ""):
        return None
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return None

# ----------------------------------------------------------------- aggregate
def aggregate(results, label):
    if not results:
        return
    tl = sum(r["truth_lines"] for r in results)
    cor = sum(r["correct"] for r in results)
    wv = sum(r["wrong_value"] for r in results)
    mis = sum(r["missed"] for r in results)
    hal = sum(r["hallucinations"] for r in results)
    hchecked = sum(r["header_checked"] for r in results)
    hcorr = sum(round((r["header_accuracy"] or 0) * r["header_checked"]) for r in results)
    print(f"\n================  {label}  ({len(results)} bills)  ================")
    print(f"  line accuracy   {cor}/{tl}   {cor / tl * 100:5.1f}%   (correct line + amount + qty)")
    print(f"  item recall     {(cor + wv)}/{tl}   {(cor + wv) / tl * 100:5.1f}%   (line found, amount may be off)")
    print(f"  value accuracy  {cor}/{cor + wv}   {cor / (cor + wv) * 100 if (cor+wv) else 100:5.1f}%   (of found lines, amount+qty exact)")
    print(f"  missed lines    {mis}")
    print(f"  hallucinations  {hal}   (invented lines, across all {len(results)} bills)")
    if hchecked:
        print(f"  header fields   {hcorr}/{hchecked}   {hcorr / hchecked * 100:5.1f}%")
    print(f"  per bill:")
    for r in sorted(results, key=lambda r: r["line_accuracy"]):
        h = "" if r["header_accuracy"] is None else f"  hdr {r['header_accuracy']*100:4.0f}%"
        print(f"    {r['id']}  line {r['line_accuracy']*100:5.1f}%  "
              f"({r['correct']}/{r['truth_lines']})  miss {r['missed']}  halluc {r['hallucinations']}{h}")

# ----------------------------------------------------------------- selftest
def selftest():
    truth = {"id": "TEST", "is_clean": True,
             "header": {"hospital_name": "X Hospital", "bill_number": "B/1", "gross_amount": 2000.0,
                        "patient_name": "A B"},
             "printed_subtotals": {"S": 2000.0},
             "line_items": [
                 {"item": f"ITEM {i} 100{i}", "unit": "nos", "quantity": float(i % 3 + 1),
                  "rate": 100.0, "total": round((i % 3 + 1) * 100.0, 2), "section": "S"}
                 for i in range(20)
             ]}

    # 1) perfect extraction -> 100%, 0 hallucinations
    perfect = {"header": dict(truth["header"]), "printed_subtotals": dict(truth["printed_subtotals"]),
               "line_items": [dict(l) for l in truth["line_items"]]}
    r = score_bill(truth, perfect)
    assert r["line_accuracy"] == 1.0, r
    assert r["hallucinations"] == 0, r
    assert r["header_accuracy"] == 1.0, r
    print("selftest 1  perfect extraction        -> 100.0%  0 hallucinations   ok")

    # 2) drop 3 lines, misread 1 amount, invent 1 line -> 16/20 = 80%, 1 hallucination
    dmg = [dict(l) for l in truth["line_items"]]
    dmg = dmg[:-3]                                   # drop 3
    dmg[0] = dict(dmg[0]); dmg[0]["total"] = dmg[0]["total"] + 37   # misread 1 amount
    dmg.append({"item": "GHOST CHARGE 9999", "unit": "nos", "quantity": 1.0, "rate": 500.0,
                "total": 500.0, "section": "S"})     # invent 1
    dmgx = {"line_items": dmg}
    r = score_bill(truth, dmgx)
    assert r["correct"] == 16, r
    assert r["line_accuracy"] == 0.8, r
    assert r["hallucinations"] == 1, r
    assert r["missed"] == 3 and r["wrong_value"] == 1, r
    print("selftest 2  -3 lines, 1 misread, +1 ghost -> 80.0%  1 hallucination   ok")

    # 3) fuzzy item text still matches (spacing / code drift)
    fuzzy = {"line_items": [
        {**l, "item": l["item"].replace(" 100", "  #").title()} for l in truth["line_items"]
    ]}
    r = score_bill(truth, fuzzy)
    assert r["line_accuracy"] == 1.0, r
    print("selftest 3  reworded item text            -> 100.0%  (fuzzy match holds)   ok")
    print("\nself-test passed")

# ----------------------------------------------------------------- cli
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth")
    ap.add_argument("--extraction")
    ap.add_argument("--corpus", help="dir with truth/SYN-*.json (+ <id>_extraction.json unless --extractions given)")
    ap.add_argument("--extractions", help="dir holding the <id>_extraction.json files (default: --corpus dir)")
    ap.add_argument("--label", default="SYNTHETIC")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--json", action="store_true", help="dump per-bill result as JSON")
    a = ap.parse_args()

    if a.selftest:
        selftest(); return

    results = []
    if a.corpus:
        tdir = os.path.join(a.corpus, "truth")
        exdir = a.extractions or a.corpus
        for fn in sorted(os.listdir(tdir)):
            if not fn.endswith(".json"):
                continue
            bid = fn[:-5]
            exf = os.path.join(exdir, f"{bid}_extraction.json")
            if not os.path.exists(exf):
                print(f"  (skip {bid}: no {bid}_extraction.json)")
                continue
            truth = json.load(open(os.path.join(tdir, fn), encoding="utf-8"))
            ex = json.load(open(exf, encoding="utf-8"))
            results.append(score_bill(truth, ex))
    elif a.truth and a.extraction:
        truth = json.load(open(a.truth, encoding="utf-8"))
        ex = json.load(open(a.extraction, encoding="utf-8"))
        results.append(score_bill(truth, ex))
    else:
        ap.error("give --truth and --extraction, or --corpus DIR, or --selftest")

    if a.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    aggregate(results, a.label)
    print("\nReminder: report SYNTHETIC and REAL-BILL accuracy on separate lines.")

if __name__ == "__main__":
    main()
