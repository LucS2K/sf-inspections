"""Rule-based classification of violation descriptions (no API required).

The descriptions are standardized DPH remediation sentences, so ordered
keyword rules classify them deterministically. First matching rule wins;
rules are ordered most-specific-first. Anything unmatched lands in
'other' and is printed for review. Risk tiers follow California Retail
Food Code practice: high = direct foodborne-illness risk factors,
moderate = indirect risk, low = facility/administrative.

This replaces the LLM classification step when API credits are not
available; rows are tagged method='keyword-rules-v1' so an LLM pass can
later re-classify and be compared.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ingest"))
from fetch import connect  # noqa: E402

# (category, risk_tier, pattern) — first match wins, order is load-bearing
# Known false positives (kept: v1 is frozen as the published basis, and an
# LLM re-classification confirmed the analysis result is insensitive to
# them): "ill " matches "will call you back" in suspension boilerplate,
# "rodent-proof" pulls waste-container rules into vermin.
RULES = [
    ("vermin", "high",
     r"cockroach|rodent|vermin|flies|infestation|pest"),
    ("temperature_control", "high",
     r"41.?F|135.?F|120.?F|70.?F|hot held|rapidly cool|thaw|thermometer"
     r"|time as a public health control|temperature"),
    ("hygiene_handwashing", "high",
     r"wash hands|handwash|hand wash|soap and single-use|ill |illness"
     r"|hygien|exclude.*employee|eat, drink, or smoke|hair restraint"),
    ("contamination_protection", "high",
     r"contaminat|adulterat|separated and protected|poisonous|discard"
     r"|elevate all food|protect.*food|food.*protect|produce|fruits and"
     r"|oyster|raw.*animal origin|washed before|whole produce"),
    ("plumbing_water", "moderate",
     r"potable water|backflow|plumbing|sewage|wastewater|grease trap"
     r"|hot running|sink|water supply|water pressure|water system"
     r"|pressurized"),
    ("cleaning_sanitizing", "moderate",
     r"sanitiz|wash, rinse|wiping cloth|degrease|clean and free of litter"
     r"|nonfood contact surfaces clean|linen|warewashing|test strips"),
    ("food_storage", "moderate",
     r"stor(?:e|ed|age)|label|bulk food|original container"),
    ("equipment_facilities", "low",
     r"walls|ceiling|floor|equipment|exhaust hood|repair|coved|premises"
     r"|lighting|ventilation|restroom|toilet|door|window|screen|surfaces"
     r"|splashguard"),
    ("certification_permits_admin", "low",
     r"certification|certificate|permit|post|inspection report|documents"
     r"|suspension|closure|licensed|plan|approval|manager|misbranding"
     r"|training|allergen|person in charge|enforcement officer|abatement"
     r"|interfering|verification form|operating location"),
]


def classify(description: str) -> tuple[str, str]:
    d = description.lower()
    for category, risk, pattern in RULES:
        if re.search(pattern, d):
            return category, risk
    return "other", "low"


def main() -> None:
    con = connect()
    con.execute("""
        CREATE OR REPLACE TABLE derived.violation_categories (
            description VARCHAR, category VARCHAR, risk_tier VARCHAR,
            method VARCHAR
        )
    """)
    descs = [r[0] for r in con.execute("""
        SELECT DISTINCT description FROM (
            SELECT description FROM derived.violation_segments
            UNION SELECT description FROM derived.violation_segments_llm)
        WHERE description IS NOT NULL AND len(trim(description)) > 0
    """).fetchall()]

    unmatched = []
    for d in descs:
        category, risk = classify(d)
        if category == "other":
            unmatched.append(d)
        con.execute(
            "INSERT INTO derived.violation_categories VALUES (?,?,?,?)",
            [d, category, risk, "keyword-rules-v1"])

    print(f"classified {len(descs)} descriptions")
    for r in con.execute("""
        SELECT category, risk_tier, count(*) AS descriptions
        FROM derived.violation_categories
        GROUP BY 1,2 ORDER BY 3 DESC""").fetchall():
        print(" ", r)
    if unmatched:
        print(f"\nUNMATCHED ({len(unmatched)}) — review these:")
        for d in unmatched:
            print("  -", d[:100])
    con.close()


if __name__ == "__main__":
    main()
