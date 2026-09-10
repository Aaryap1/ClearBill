"""
simulate_extraction.py — SANITY CHECK ONLY, not a measurement.

Produces fake "extractions" from ground truth with a crude error model
(drop / misread / invent / OCR digit-swap), so you can watch evaluate.py behave
on imperfect input before the real Gemini outputs exist. The real accuracy
number must come from the model, not from this file.

    python simulate_extraction.py --error 0.08        # ~8% line error rate
    python evaluate.py --corpus . --label "SIMULATED (not real)"
"""
import argparse, glob, json, os, random

HERE = os.path.dirname(os.path.abspath(__file__))

def swap_digit(x, rnd):
    s = f"{x:.2f}"
    digs = [i for i, c in enumerate(s) if c.isdigit()]
    i = rnd.choice(digs)
    s = s[:i] + rnd.choice("0123456789") + s[i + 1:]
    try:
        return float(s)
    except ValueError:
        return x

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--error", type=float, default=0.08)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    rnd = random.Random(a.seed)

    for tf in sorted(glob.glob(os.path.join(HERE, "truth", "SYN-*.json"))):
        t = json.load(open(tf, encoding="utf-8"))
        out_lines = []
        for l in t["line_items"]:
            r = rnd.random()
            if r < a.error * 0.45:                       # drop
                continue
            e = dict(l)
            if r < a.error * 0.8:                        # misread an amount
                e["total"] = swap_digit(e["total"], rnd)
            e["item"] = e["item"].title().replace("  ", " ")
            out_lines.append(e)
        if rnd.random() < a.error * 2:                   # invent a line
            out_lines.append({"item": "MISC SERVICE CHARGE", "unit": "nos",
                              "quantity": 1.0, "rate": 250.0, "total": 250.0, "section": "MISCELLANEOUS"})
        ex = {"header": t["header"], "printed_subtotals": t["printed_subtotals"], "line_items": out_lines}
        json.dump(ex, open(os.path.join(HERE, f'{t["id"]}_extraction.json'), "w", encoding="utf-8"),
                  indent=2, ensure_ascii=False)
    print(f"wrote simulated *_extraction.json at ~{a.error:.0%} error rate - NOT a real result")

if __name__ == "__main__":
    main()
