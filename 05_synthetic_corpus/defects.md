# Planted defects

6 of 10 bills carry at least one defect. The other 4 are clean — a
checker that flags them is producing false positives.

| Bill | Procedure | Lines | Clean? | Defects |
|---|---|---|---|---|
| SYN-01 | Laparoscopic appendectomy | 23 | yes | — |
| SYN-02 | Cataract surgery (day care) | 19 | yes | — |
| SYN-03 | Coronary angioplasty (1 stent) | 34 | **no** | subtotal_mismatch |
| SYN-04 | Normal vaginal delivery | 25 | **no** | duplicate |
| SYN-05 | Haemodialysis (single session) | 19 | yes | — |
| SYN-06 | Chemotherapy cycle | 26 | **no** | missing_field, missing_unit_column |
| SYN-07 | Knee arthroscopy | 26 | **no** | subtotal_mismatch, missing_field |
| SYN-08 | Inguinal hernia repair (mesh) | 24 | **no** | duplicate, missing_field |
| SYN-09 | Pneumonia — medical admission | 30 | yes | — |
| SYN-10 | Ureteroscopy for renal calculus | 25 | **no** | missing_field, missing_unit_column, missing_field |

Exact figures (section, delta, duplicated item) are in each `truth/<id>.json` under `defects`.
