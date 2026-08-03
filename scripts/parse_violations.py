"""Parse violation_codes into one row per violation segment.

Format (verified by profiling): each violation is a run of statutory
section codes followed by ' - ' and a remediation sentence, segments
concatenated with ', '. Segment-separator count agrees with the recorded
violation_count on 92.1% of rows exactly, 95.3% within one.

Output: derived.violation_segments, rebuilt wholesale (deterministic
function of stg_inspections, so append-only rules do not apply). Rows
that disagree with violation_count are flagged, not dropped.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ingest"))
from fetch import connect  # noqa: E402

# a violation starts with a run of section codes, then ' - '
# a code token may be a bare section, a lettered subsection, or a
# space-free range (113947.1-113947.6); the segment delimiter ' - ' always
# has surrounding spaces, so range hyphens cannot be confused with it
CODE_TOKEN = (r"(?:Section |CRFC )?"
              r"\d{6}(?:\.\d+)?"
              r"(?:\s*(?:\([a-z0-9, ]+\)|\[[a-z0-9,\- ]+\]))*"
              r"(?:-\d{6}(?:\.\d+)?)?")
# a run: codes separated by commas OR spaces, optionally wrapped in parens,
# ending in the ' - ' delimiter; municipal citations ("Health Code Section
# 581.1") are prefix-gated so short numbers cannot false-match
CODE_RUN = re.compile(
    r"(?:\(\s*)?"
    r"(?:(?:" + CODE_TOKEN + r"|(?:Health Code )?Section \d{1,3}(?:\.\d+)?)"
    r"(?:,\s*|\s+)?)+"
    r"(?:\)\s*)?-\s+")
# a segment may carry no codes at all: "...previous sentence., - Next fix"
NOCODE_RUN = re.compile(r",\s+-\s+")
CODE = re.compile(r"\d{6}(?:\.\d+)?")


def parse(text: str) -> list[dict]:
    """Split one violation_codes value into (codes, description) segments."""
    starts = list(CODE_RUN.finditer(text))
    taken = [(m.start(), m.end()) for m in starts]
    for m in NOCODE_RUN.finditer(text):
        if not any(s <= m.start() < e for s, e in taken):
            starts.append(m)
    starts.sort(key=lambda m: m.start())
    if not starts:
        return [{"codes": [], "description": text.strip().rstrip(",")}]
    out = []
    for i, m in enumerate(starts):
        desc_end = starts[i + 1].start() if i + 1 < len(starts) else len(text)
        description = text[m.end():desc_end].strip().rstrip(",").strip()
        out.append({
            "codes": CODE.findall(text[m.start():m.end()]),
            "description": description,
        })
    return out


def main() -> None:
    con = connect()
    rows = con.execute("""
        SELECT permit_number, inspection_date, inspection_type, event_seq,
               violation_count, violation_codes
        FROM stg_inspections
        WHERE violation_codes IS NOT NULL
    """).fetchall()

    records = []
    agree = 0
    for permit, date, itype, seq, vcount, text in rows:
        segs = parse(text)
        if vcount is not None and len(segs) == vcount:
            agree += 1
        for i, s in enumerate(segs, 1):
            records.append((permit, date, itype, seq, i,
                            ",".join(s["codes"]), s["description"],
                            vcount is not None and len(segs) == vcount))

    con.execute("CREATE SCHEMA IF NOT EXISTS derived")
    # bulk-load via NDJSON: row-at-a-time executemany is pathologically
    # slow in DuckDB (same lesson as ingest/fetch.py land())
    import json
    import tempfile, os
    fd, tmp = tempfile.mkstemp(suffix=".ndjson")
    cols = ["permit_number", "inspection_date", "inspection_type",
            "event_seq", "violation_seq", "section_codes", "description",
            "count_agrees"]
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(dict(zip(cols, [str(r[1]) if i == 1 else r[i]
                                              for i in range(8)]))) + "\n")
    try:
        con.execute(f"""
            CREATE OR REPLACE TABLE derived.violation_segments AS
            SELECT * FROM read_json(?, format='newline_delimited', columns={{
                'permit_number': 'VARCHAR', 'inspection_date': 'DATE',
                'inspection_type': 'VARCHAR', 'event_seq': 'INTEGER',
                'violation_seq': 'INTEGER', 'section_codes': 'VARCHAR',
                'description': 'VARCHAR', 'count_agrees': 'BOOLEAN'}})
        """, [tmp])
    finally:
        os.unlink(tmp)
    n_rows = len(rows)
    print(f"parsed {n_rows} inspections into {len(records)} violation "
          f"segments; count agreement {agree}/{n_rows} "
          f"({agree * 100.0 / n_rows:.1f}%)")
    print("distinct descriptions:", con.execute(
        "SELECT count(DISTINCT description) FROM derived.violation_segments"
    ).fetchone()[0])
    con.close()


if __name__ == "__main__":
    main()
