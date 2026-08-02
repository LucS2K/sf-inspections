"""Fetch Registered Business Locations (g8m3-pdis) candidates for facilities
with unresolved enforcement failures, to split censoring from attrition.

For each facility the script queries the registry twice: by normalized
address prefix (street number + street name) and by exact upper dba name.
All candidates land append-only in raw.registry_candidates tagged with the
queried permit_number and match method; classification happens in SQL, not
here. Idempotent via the same _row_hash guard as the main ingest.
"""

import datetime as dt
import json
import re
import sys
import uuid

import duckdb
import requests

from fetch import DB_PATH, TIMEOUT, canonical_hash, log

DATASET = "g8m3-pdis"
URL = f"https://data.sfgov.org/resource/{DATASET}.json"
SELECT = ("ttxid, dba_name, full_business_address, dba_start_date, "
          "dba_end_date, location_start_date, location_end_date, "
          "administratively_closed, supervisor_district")
FIELDS = [f.strip() for f in SELECT.split(",")]


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").upper().strip())


def soql_quote(s: str) -> str:
    return s.replace("'", "''")


def street_prefix(address: str) -> str | None:
    # '504   BROADWAY ST' -> '504 BROADWAY': number plus street name, so
    # ST/STREET suffix variants in the registry still match
    m = re.match(r"^(\d+[A-Z]?) +([A-Z0-9]+)", norm(address))
    return f"{m.group(1)} {m.group(2)}" if m else None


def fetch_candidates(where: str) -> list[dict]:
    resp = requests.get(URL, params={
        "$select": SELECT, "$where": where, "$limit": 100}, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    run_id = str(uuid.uuid4())[:8]
    started = dt.datetime.now()
    con = duckdb.connect(str(DB_PATH))
    cols = ", ".join(f'"{c}" VARCHAR' for c in FIELDS)
    con.execute(f"""
        CREATE TABLE IF NOT EXISTS raw.registry_candidates (
            queried_permit_number VARCHAR,
            match_method VARCHAR,
            {cols},
            _row_hash VARCHAR,
            _fetched_at TIMESTAMP
        )
    """)

    facilities = con.execute("""
        SELECT DISTINCT e.permit_number, s.dba, s.street_address_clean
        FROM fct_enforcement_episodes e
        JOIN stg_inspections s
          ON s.permit_number = e.permit_number
         AND s.inspection_date = e.failure_date
        WHERE e.resolution_date IS NULL
        ORDER BY e.permit_number
    """).fetchall()
    log(f"run {run_id} registry lookup for {len(facilities)} facilities")

    rows_fetched = rows_new = 0
    try:
        for permit, dba, address in facilities:
            queries = []
            prefix = street_prefix(address or "")
            if prefix:
                queries.append(("address",
                    f"starts_with(upper(full_business_address), '{soql_quote(prefix)}')"))
            if dba:
                queries.append(("dba",
                    f"upper(dba_name) = '{soql_quote(norm(dba))}'"))
            for method, where in queries:
                for rec in fetch_candidates(where):
                    rows_fetched += 1
                    key = {"permit": permit, "method": method, **rec}
                    row_hash = canonical_hash(key)
                    exists = con.execute(
                        "SELECT 1 FROM raw.registry_candidates WHERE _row_hash = ?",
                        [row_hash]).fetchone()
                    if not exists:
                        con.execute(
                            f"INSERT INTO raw.registry_candidates VALUES "
                            f"({', '.join(['?'] * (len(FIELDS) + 4))})",
                            [permit, method] + [rec.get(f) for f in FIELDS]
                            + [row_hash, dt.datetime.now()])
                        rows_new += 1
        con.execute(
            "INSERT INTO meta.ingest_runs VALUES (?,?,?,?,?,?,?,?,?,?)",
            [run_id, started, dt.datetime.now(), DATASET, "lookup",
             rows_fetched, rows_new, None, "success", None])
        log(f"run {run_id} success fetched={rows_fetched} new={rows_new}")
    except Exception as e:
        con.execute(
            "INSERT INTO meta.ingest_runs VALUES (?,?,?,?,?,?,?,?,?,?)",
            [run_id, started, dt.datetime.now(), DATASET, "lookup",
             rows_fetched, rows_new, None, "failure", repr(e)])
        log(f"run {run_id} FAILURE {e!r}")
        raise
    finally:
        con.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
