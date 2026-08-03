"""Load the in-session LLM parses into derived.violation_segments_llm.

Validates before inserting a single row:
- every row's segment count equals the inspector's recorded violation_count
- every referenced description (catalog id or raw_between slice) appears
  verbatim in the row's raw text after whitespace normalization
- no row already present in the table is touched (same resume contract as
  the API script)
Aborts wholesale on any validation failure.
"""

import json
import re
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

todo = {}
for line in (SCRATCH / "reparse_todo.ndjson").read_text(encoding="utf-8").splitlines():
    r = json.loads(line)
    todo[r["i"]] = r

aliases = {}
rows = []
for chunk in sorted(SCRATCH.glob("reparse_out_*.json")):
    data = json.loads(chunk.read_text(encoding="utf-8"))
    aliases.update(data.get("aliases", {}))
    rows.extend(data["rows"])

norm = lambda t: re.sub(r"\s+", " ", t).strip()

errors = []
resolved = []  # (row, [(codes, description), ...])
seen = set()
for out in rows:
    i = out["i"]
    if i in seen:
        errors.append(f"row {i}: duplicated in output chunks")
        continue
    seen.add(i)
    src = todo[i]
    raw_norm = norm(src["text"])
    segs = []
    for codes_spec, desc_spec in out["segs"]:
        codes = aliases.get(codes_spec, codes_spec)
        if isinstance(desc_spec, int):
            desc = catalog[desc_spec]
        else:
            start, end = desc_spec["raw_between"]
            a = src["text"].index(start)
            b = src["text"].index(end, a) + len(end)
            desc = src["text"][a:b]
        core = norm(desc.lstrip("- ").split(", 1")[0])[:80]
        if core and core not in raw_norm:
            errors.append(f"row {i}: description not found in raw text: {core[:60]!r}")
        if codes and norm(codes)[:40] not in raw_norm:
            errors.append(f"row {i}: codes not found in raw text: {codes[:40]!r}")
        segs.append((codes, desc))
    if len(segs) != src["vcount"]:
        errors.append(f"row {i}: {len(segs)} segments vs recorded vcount {src['vcount']}")
    resolved.append((src, segs))

if len(seen) != len(todo):
    errors.append(f"coverage: {len(seen)} rows parsed vs {len(todo)} todo")
if errors:
    print("VALIDATION FAILED:")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print(f"validation passed: {len(resolved)} rows, "
      f"{sum(len(s) for _, s in resolved)} segments")

con = connect()
done = {(str(r[0]), str(r[1]), r[2], r[3]) for r in con.execute("""
    SELECT DISTINCT permit_number, inspection_date, inspection_type, event_seq
    FROM derived.violation_segments_llm""").fetchall()}
inserted = skipped = 0
for src, segs in resolved:
    key = (src["permit"], src["date"], src["itype"], src["seq"])
    if key in done:
        skipped += 1
        continue
    for n, (codes, desc) in enumerate(segs, 1):
        con.execute(
            "INSERT INTO derived.violation_segments_llm VALUES (?,?,?,?,?,?,?)",
            [src["permit"], src["date"], src["itype"], src["seq"], n,
             ",".join(c.strip() for c in codes.split(",")) if codes else "",
             desc])
    inserted += 1
log(f"in-session reparse: loaded {inserted} rows ({skipped} already present)")
remaining = con.execute("""
    SELECT count(*) FROM (
        SELECT DISTINCT permit_number, inspection_date, inspection_type, event_seq
        FROM derived.violation_segments WHERE NOT count_agrees) s
    WHERE (permit_number, inspection_date,
           coalesce(inspection_type,''), event_seq) NOT IN (
        SELECT permit_number, inspection_date,
               coalesce(inspection_type,''), event_seq
        FROM derived.violation_segments_llm)
""").fetchone()[0]
print(f"disagreeing rows still unparsed: {remaining}")
con.close()
