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
        WITH yelp AS (SELECT * FROM stg_yelp),
             sev AS (
                SELECT permit_number,
                       max(CASE WHEN failure_rating = 'Closure' THEN 1 ELSE 0 END) AS ever_closed
                FROM fct_enforcement_episodes GROUP BY 1)
        SELECT t.permit_number AS permit,
               any_value(t.dba) AS dba,
               any_value(s.street_address_clean) AS address,
               any_value(t.analysis_neighborhood) AS hood,
               count(*) AS inspections,
               max(t.inspection_date) AS last_seen,
               (array_agg(t.facility_rating_status
                          ORDER BY t.inspection_date DESC, t.event_seq DESC)
                FILTER (WHERE t.facility_rating_status IS NOT NULL))[1] AS last_rating,
               count(*) FILTER (WHERE t.facility_rating_status
                                IN ('Conditional Pass', 'Closure')) AS failures,
               any_value(sev.ever_closed) AS ever_closed,
               any_value(y.rating)        AS yelp_rating,
               any_value(y.review_count)  AS yelp_reviews,
               any_value(y.is_closed)     AS yelp_closed
        FROM fct_inspection_timeline t
        JOIN stg_inspections s
          ON s.permit_number = t.permit_number
         AND s.inspection_date = t.inspection_date
         AND s.event_seq = t.event_seq
         AND coalesce(s.inspection_type, '') = coalesce(t.inspection_type, '')
        LEFT JOIN sev  ON sev.permit_number = t.permit_number
        LEFT JOIN yelp y ON y.permit_number = t.permit_number
                        AND y.match_status = 'matched'
        GROUP BY 1
    """))

    # violation descriptions: 298 distinct strings across ~47k segments, so
    # ship a dictionary once and reference it by id from history rows
    seg_rows = rows(con, """
        WITH unified AS (
            SELECT permit_number, inspection_date, inspection_type,
                   violation_seq, description
            FROM derived.violation_segments s
            WHERE count_agrees OR NOT EXISTS (
                SELECT 1 FROM derived.violation_segments_llm l
                WHERE l.permit_number = s.permit_number
                  AND l.inspection_date = s.inspection_date
                  AND coalesce(l.inspection_type,'') = coalesce(s.inspection_type,'')
                  AND l.event_seq = s.event_seq)
            UNION ALL
            SELECT permit_number, inspection_date, inspection_type,
                   violation_seq, description
            FROM derived.violation_segments_llm
        )
        SELECT permit_number, inspection_date, inspection_type,
               violation_seq, description
        FROM unified
        WHERE description IS NOT NULL AND len(trim(description)) > 0
        ORDER BY permit_number, inspection_date, violation_seq
    """)
    def_ids: dict[str, int] = {}
    defs: list[str] = []
    viol_by_visit: dict[tuple, list[int]] = {}
    for r in seg_rows:
        d = " ".join(r["description"].split())
        if d not in def_ids:
            def_ids[d] = len(defs)
            # display copy: first 220 chars carries the remediation sentence
            defs.append(d[:220] + ("…" if len(d) > 220 else ""))
        key = (r["permit_number"], str(r["inspection_date"]),
               r["inspection_type"] or "")
        viol_by_visit.setdefault(key, []).append(def_ids[d])
    dump("viol_defs", defs)

    # compact per-facility history: [date, type, rating, violations, def_ids]
    # (same-day same-type repeat visits share a key; the first row gets the
    # list so violations are never shown twice)
    hist = {}
    # ordered by event_seq within a day so same-day visits (closure, then
    # the re-check) keep their real sequence and "latest" is unambiguous
    for r in rows(con, """
        SELECT permit_number, inspection_date, inspection_type,
               facility_rating_status, violation_count
        FROM fct_inspection_timeline
        ORDER BY permit_number, inspection_date, event_seq
    """):
        key = (r["permit_number"], str(r["inspection_date"]),
               r["inspection_type"] or "")
        ids = viol_by_visit.pop(key, [])
        hist.setdefault(r["permit_number"], []).append([
            str(r["inspection_date"]), r["inspection_type"],
            r["facility_rating_status"], r["violation_count"], ids])
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
