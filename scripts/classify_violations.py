"""Stage 6 LLM pass: (1) re-parse the rows the deterministic parser could
not segment confidently, (2) classify every distinct violation description
into an operational category and a risk tier.

Design notes:
- The deterministic parser (parse_violations.py) handles 97.4% of rows;
  only rows where segment count disagrees with the recorded violation_count
  (count_agrees = false) are re-parsed here, in small chunks, with a strict
  JSON schema so outputs are machine-checkable.
- Classification runs once per DISTINCT description (a few hundred strings),
  not per row (47k), then joins back. Model: claude-opus-5, streaming, with
  structured outputs so every row lands typed.
- Requires ANTHROPIC_API_KEY in the environment or .env.

Outputs:
  derived.violation_segments_llm  (row-key + violation_seq + codes + description)
  derived.violation_categories    (description -> category, risk_tier)
"""

import json
import os
import sys
from pathlib import Path

import anthropic

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
from fetch import connect, log  # noqa: E402

MODEL = "claude-opus-5"

CATEGORIES = [
    "temperature_control", "contamination_protection", "hygiene_handwashing",
    "vermin", "cleaning_sanitizing", "equipment_facilities", "plumbing_water",
    "food_storage", "certification_permits_admin", "other",
]
RISK_TIERS = ["high", "moderate", "low"]


def api_key() -> str:
    if os.environ.get("ANTHROPIC_API_KEY"):
        return os.environ["ANTHROPIC_API_KEY"]
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.split("=", 1)[1].strip()
    sys.exit("ANTHROPIC_API_KEY not set (env or .env)")


def reparse_disagreeing_rows(client: anthropic.Anthropic, con) -> None:
    rows = con.execute("""
        SELECT s.permit_number, s.inspection_date, s.inspection_type,
               s.event_seq, i.violation_count, i.violation_codes
        FROM (SELECT DISTINCT permit_number, inspection_date, inspection_type,
                     event_seq
              FROM derived.violation_segments WHERE NOT count_agrees) s
        JOIN stg_inspections i
          ON i.permit_number = s.permit_number
         AND i.inspection_date = s.inspection_date
         AND coalesce(i.inspection_type, '') = coalesce(s.inspection_type, '')
         AND i.event_seq = s.event_seq
    """).fetchall()
    con.execute("""
        CREATE TABLE IF NOT EXISTS derived.violation_segments_llm (
            permit_number VARCHAR, inspection_date DATE,
            inspection_type VARCHAR, event_seq INTEGER,
            violation_seq INTEGER, section_codes VARCHAR,
            description VARCHAR
        )
    """)
    done = {tuple(r) for r in con.execute("""
        SELECT DISTINCT permit_number, inspection_date, inspection_type, event_seq
        FROM derived.violation_segments_llm""").fetchall()}
    todo = [r for r in rows
            if (r[0], r[1], r[2], r[3]) not in done]
    log(f"llm reparse: {len(todo)} rows to go ({len(done)} done)")

    schema = {
        "type": "object",
        "properties": {
            "segments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "codes": {"type": "array", "items": {"type": "string"}},
                        "description": {"type": "string"},
                    },
                    "required": ["codes", "description"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["segments"],
        "additionalProperties": False,
    }

    for n, (permit, date, itype, seq, vcount, text) in enumerate(todo, 1):
        with client.messages.stream(
            model=MODEL,
            max_tokens=16000,
            output_config={"format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": (
                "This is one inspection's violation field from a health "
                "inspection database. It concatenates individual violations; "
                "each violation is a list of statutory section codes plus a "
                "remediation description (some segments have no codes; legal "
                "suspension boilerplate belongs to the violation it follows, "
                "not its own segment). The inspector recorded "
                f"{vcount} violation(s). Split the field into exactly the "
                "violations present.\n\n" + text)}],
        ) as stream:
            resp = stream.get_final_message()
        if resp.stop_reason == "refusal":
            log(f"  refusal on row {permit}/{date}; skipping")
            continue
        parsed = json.loads(next(
            b.text for b in resp.content if b.type == "text"))
        for i, seg in enumerate(parsed["segments"], 1):
            con.execute(
                "INSERT INTO derived.violation_segments_llm VALUES "
                "(?,?,?,?,?,?,?)",
                [permit, date, itype, seq, i,
                 ",".join(seg["codes"]), seg["description"]])
        if n % 25 == 0:
            log(f"  reparsed {n}/{len(todo)}")
    log("llm reparse complete")


def classify_descriptions(client: anthropic.Anthropic, con) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS derived.violation_categories (
            description VARCHAR, category VARCHAR, risk_tier VARCHAR,
            model VARCHAR
        )
    """)
    descs = [r[0] for r in con.execute("""
        SELECT DISTINCT description FROM (
            SELECT description FROM derived.violation_segments
            UNION
            SELECT description FROM derived.violation_segments_llm
        ) WHERE description IS NOT NULL AND len(trim(description)) > 0
          AND description NOT IN (SELECT description
                                  FROM derived.violation_categories)
    """).fetchall()]
    log(f"classification: {len(descs)} distinct descriptions to classify")
    if not descs:
        return

    schema = {
        "type": "object",
        "properties": {
            "classifications": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer"},
                        "category": {"type": "string", "enum": CATEGORIES},
                        "risk_tier": {"type": "string", "enum": RISK_TIERS},
                    },
                    "required": ["id", "category", "risk_tier"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["classifications"],
        "additionalProperties": False,
    }

    # chunks keep each response comfortably inside max_tokens
    for start in range(0, len(descs), 100):
        chunk = descs[start:start + 100]
        numbered = "\n".join(f"{i}. {d[:400]}" for i, d in enumerate(chunk))
        with client.messages.stream(
            model=MODEL,
            max_tokens=32000,
            output_config={"format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": (
                "Classify each numbered food-safety violation remediation "
                "description into exactly one category and one risk tier.\n"
                "Categories: " + ", ".join(CATEGORIES) + ".\n"
                "Risk tiers follow California Retail Food Code practice: "
                "high = direct foodborne-illness risk factors (temperature "
                "abuse, contamination, ill or unhygienic workers, vermin); "
                "moderate = indirect risk (sanitization, storage practices, "
                "water supply); low = facility/equipment/administrative.\n"
                "Return one classification per input id.\n\n" + numbered)}],
        ) as stream:
            resp = stream.get_final_message()
        if resp.stop_reason == "refusal":
            sys.exit("classification refused; stopping")
        parsed = json.loads(next(
            b.text for b in resp.content if b.type == "text"))
        for c in parsed["classifications"]:
            if 0 <= c["id"] < len(chunk):
                con.execute(
                    "INSERT INTO derived.violation_categories VALUES (?,?,?,?)",
                    [chunk[c["id"]], c["category"], c["risk_tier"], MODEL])
        log(f"  classified {min(start + 100, len(descs))}/{len(descs)}")
    log("classification complete")


def main() -> None:
    client = anthropic.Anthropic(api_key=api_key())
    con = connect()
    reparse_disagreeing_rows(client, con)
    classify_descriptions(client, con)
    print(con.execute("""
        SELECT category, risk_tier, count(*) AS descriptions
        FROM derived.violation_categories
        GROUP BY 1, 2 ORDER BY 1, 2
    """).fetchall())
    con.close()


if __name__ == "__main__":
    main()
