"""Export dashboard JSON from the DuckDB marts into site/data/.

Runs after dbt; the weekly refresh chain is: ingest -> dbt run -> this ->
vercel deploy. The dashboard filters (date range, neighborhood) re-slice
every chart client-side, so exports are event-level, not pre-aggregated:
summary carries the generation stamp, facilities + history carry the
timeline, episodes carries the enforcement funnel inputs.
"""

import datetime as dt
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
import sys
sys.path.insert(0, str(ROOT / "ingest"))
from fetch import connect  # noqa: E402  (single switch for local vs MotherDuck)
OUT = Path(__file__).resolve().parent / "data"
OUT.mkdir(exist_ok=True)


def rows(con, sql):
    cur = con.execute(sql)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def dump(name, obj):
    def default(o):
        if isinstance(o, (dt.date, dt.datetime)):
            return o.isoformat()
        raise TypeError(type(o))
    path = OUT / f"{name}.json"
    path.write_text(json.dumps(obj, default=default, separators=(",", ":")),
                    encoding="utf-8")
    print(f"{name}.json {path.stat().st_size / 1024:.0f} KB")


def main():
    con = connect(read_only=True)

    window = con.execute(
        "SELECT min(inspection_date), max(inspection_date) "
        "FROM stg_inspections").fetchone()
    dump("summary", {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "window_start": str(window[0]),
        "window_end": str(window[1]),
    })

    dump("facilities", rows(con, """
        SELECT t.permit_number AS permit,
               any_value(t.dba) AS dba,
               any_value(s.street_address_clean) AS address,
               any_value(t.analysis_neighborhood) AS hood,
               count(*) AS inspections,
               max(t.inspection_date) AS last_seen,
               (array_agg(t.facility_rating_status ORDER BY t.inspection_date DESC)
                FILTER (WHERE t.facility_rating_status IS NOT NULL))[1] AS last_rating,
               count(*) FILTER (WHERE t.facility_rating_status
                                IN ('Conditional Pass', 'Closure')) AS failures
        FROM fct_inspection_timeline t
        JOIN stg_inspections s
          ON s.permit_number = t.permit_number
         AND s.inspection_date = t.inspection_date
         AND s.event_seq = t.event_seq
         AND coalesce(s.inspection_type, '') = coalesce(t.inspection_type, '')
        GROUP BY 1
    """))

    # compact per-facility history: [date, type, rating, violations]
    hist = {}
    for r in rows(con, """
        SELECT permit_number, inspection_date, inspection_type,
               facility_rating_status, violation_count
        FROM fct_inspection_timeline
        ORDER BY permit_number, inspection_date
    """):
        hist.setdefault(r["permit_number"], []).append([
            str(r["inspection_date"]), r["inspection_type"],
            r["facility_rating_status"], r["violation_count"]])
    dump("history", hist)

    # one row per enforcement episode, compact keys:
    # d failure date, r C|P, h neighborhood, dr days to resolution,
    # rr resolution rating, du durability rating
    dump("episodes", rows(con, """
        SELECT failure_date AS d,
               CASE failure_rating WHEN 'Closure' THEN 'C' ELSE 'P' END AS r,
               coalesce(analysis_neighborhood, 'Unknown') AS h,
               days_to_resolution AS dr,
               resolution_rating AS rr,
               durability_rating AS du
        FROM fct_enforcement_episodes
        ORDER BY failure_date
    """))

    con.close()


if __name__ == "__main__":
    main()
