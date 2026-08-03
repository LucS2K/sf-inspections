"""Load in-session LLM classifications to derived.violation_categories_llm
and compare against the keyword ruleset (derived.violation_categories)."""

import json
import sys
from pathlib import Path

ROOT = Path(r"C:\Users\Luc\projects\sf-inspections")
SCRATCH = Path(r"C:\Users\Luc\AppData\Local\Temp\claude"
               r"\C--Users-Luc-projects-sf-inspections"
               r"\294ed990-703c-4689-b989-426de118f4b1\scratchpad")
sys.path.insert(0, str(ROOT / "ingest"))
from fetch import connect, log  # noqa: E402

catalog = {}
for line in (SCRATCH / "desc_catalog.ndjson").read_text(encoding="utf-8").splitlines():
    d = json.loads(line)
    catalog[d["id"]] = d["text"]

cls = json.loads((SCRATCH / "classify_llm.json").read_text(encoding="utf-8"))
by_id = {int(k): v for k, v in cls["by_id"].items()}
assert set(by_id) == set(catalog), "classification does not cover catalog exactly"

con = connect()
con.execute("""
    CREATE OR REPLACE TABLE derived.violation_categories_llm (
        description VARCHAR, category VARCHAR, risk_tier VARCHAR,
        model VARCHAR
    )
""")
for i, (cat, risk) in sorted(by_id.items()):
    con.execute("INSERT INTO derived.violation_categories_llm VALUES (?,?,?,?)",
                [catalog[i], cat, risk, cls["model"]])
log(f"in-session classification: {len(by_id)} descriptions loaded")

print("=== agreement with keyword-rules-v1 ===")
row = con.execute("""
    SELECT count(*) AS both,
           sum(CASE WHEN r.category = l.category THEN 1 ELSE 0 END) AS cat_agree,
           sum(CASE WHEN r.risk_tier = l.risk_tier THEN 1 ELSE 0 END) AS risk_agree
    FROM derived.violation_categories r
    JOIN derived.violation_categories_llm l USING (description)
""").fetchone()
both, cat_a, risk_a = row
print(f"descriptions compared: {both}")
print(f"category agreement:  {cat_a} ({100*cat_a/both:.1f}%)")
print(f"risk-tier agreement: {risk_a} ({100*risk_a/both:.1f}%)")

print("\n=== category disagreements (rules -> llm) ===")
for r in con.execute("""
    SELECT r.category, l.category, count(*) AS n,
           min(substr(l.description, 1, 70)) AS example
    FROM derived.violation_categories r
    JOIN derived.violation_categories_llm l USING (description)
    WHERE r.category <> l.category
    GROUP BY 1, 2 ORDER BY 3 DESC
""").fetchall():
    print(f"  {r[0]:28} -> {r[1]:28} n={r[2]}  e.g. {r[3]!r}")
con.close()
