"""Ingest SF DPH health inspection data from the Socrata API into DuckDB.

Two sources, treated differently on purpose:

  tvy3-wexg  Health Inspection Scores (2024-present). The analytical core.
             Gets incremental refresh on data_as_of, plus a full-refresh
             path for backfill and recovery.

  5tti-66ds  Health Inspections (2020-2023). Closed historical dataset,
             context only (facility tenure and history depth, never
             outcomes). It has no permit_number and no data_as_of, so it
             only supports full snapshot loads. It never changes, so one
             load is enough; re-running is a harmless no-op.

Raw layer contract (see CLAUDE.md):
  - Append-only. Republished versions of the same inspection are kept as
    separate rows; staging dedups with ROW_NUMBER. Nothing is overwritten.
  - Idempotent. Every landed row carries _row_hash, an MD5 of the record's
    canonical JSON. Loads anti-join on that hash, so re-running any window
    (or overlapping windows) cannot duplicate rows.
  - All columns land as VARCHAR. Type casting is staging's job, so a bad
    value from the API cannot fail a load.
  - Every run, including failures, is recorded in meta.ingest_runs and
    echoed to logs/ingest.log.

Usage:
  python ingest/fetch.py                     incremental load of tvy3-wexg
  python ingest/fetch.py --full-refresh      refetch all of tvy3-wexg
  python ingest/fetch.py --era old           full snapshot of 5tti-66ds
"""

import argparse
import datetime as dt
import hashlib
import json
import sys
import uuid
from pathlib import Path

import duckdb
import requests

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "db" / "inspections.duckdb"
LOG_PATH = PROJECT_ROOT / "logs" / "ingest.log"
PAGE_SIZE = 5000
TIMEOUT = 60

SOURCES = {
    "new": {
        "dataset": "tvy3-wexg",
        "table": "raw.inspections_2024",
        "incremental_col": "data_as_of",
        "columns": [
            "inspection_date", "inspector", "district", "subdistrict",
            "subsector", "permit_number", "dba", "permit_type",
            "street_address", "street_address_clean", "inspection_type",
            "inspection_frequency_type", "total_time",
            "facility_rating_status", "census", "suspension_notes",
            "inspection_notes", "violation_count", "violation_codes",
            "latitude", "longitude", "point", "analysis_neighborhood",
            "supervisor_district", "data_as_of", "data_loaded_at",
        ],
    },
    "old": {
        "dataset": "5tti-66ds",
        "table": "raw.inspections_2020_2023",
        "incremental_col": None,  # closed dataset, no version column
        "columns": [
            "name", "address", "city", "state", "postal_code", "latitude",
            "longitude", "inspection_id", "date", "facility_status",
            "inspection_type", "violation_observed", "description",
            "the_geom",
        ],
    },
}


def log(msg: str) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    line = f"{dt.datetime.now().isoformat(timespec='seconds')} {msg}"
    print(line)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def canonical_hash(record: dict) -> str:
    # Sorted keys and fixed separators make the hash stable regardless of
    # the key order Socrata happens to return.
    blob = json.dumps(record, sort_keys=True, separators=(",", ":"))
    return hashlib.md5(blob.encode("utf-8")).hexdigest()


def ensure_schema(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("CREATE SCHEMA IF NOT EXISTS raw")
    con.execute("CREATE SCHEMA IF NOT EXISTS meta")
    con.execute("""
        CREATE TABLE IF NOT EXISTS meta.ingest_runs (
            run_id        VARCHAR,
            started_at    TIMESTAMP,
            finished_at   TIMESTAMP,
            source        VARCHAR,
            mode          VARCHAR,
            rows_fetched  BIGINT,
            rows_new      BIGINT,
            max_data_as_of VARCHAR,
            status        VARCHAR,
            error_msg     VARCHAR
        )
    """)
    for src in SOURCES.values():
        cols = ", ".join(f'"{c}" VARCHAR' for c in src["columns"])
        con.execute(f"""
            CREATE TABLE IF NOT EXISTS {src['table']} (
                {cols},
                _row_hash   VARCHAR,
                _fetched_at TIMESTAMP
            )
        """)


def fetch_pages(dataset: str, where: str | None) -> list[dict]:
    """Page through the Socrata resource endpoint and return all records.

    Ordered by :id (Socrata's internal row id) so paging is stable even
    while we filter on data_as_of.
    """
    url = f"https://data.sfgov.org/resource/{dataset}.json"
    records: list[dict] = []
    offset = 0
    while True:
        params = {"$limit": PAGE_SIZE, "$offset": offset, "$order": ":id"}
        if where:
            params["$where"] = where
        resp = requests.get(url, params=params, timeout=TIMEOUT)
        resp.raise_for_status()
        page = resp.json()
        records.extend(page)
        log(f"  page offset={offset} rows={len(page)}")
        if len(page) < PAGE_SIZE:
            return records
        offset += PAGE_SIZE


def land(con: duckdb.DuckDBPyConnection, src: dict, records: list[dict]) -> int:
    """Append records to the raw table, skipping hashes already landed.

    Returns the number of genuinely new rows. Bulk path: records are written
    to a temp NDJSON file and loaded with read_json in a single INSERT,
    because row-at-a-time inserts are pathologically slow in DuckDB. One
    transaction, so a partial failure lands nothing.
    """
    if not records:
        return 0
    cols = src["columns"]
    tmp_dir = PROJECT_ROOT / "data" / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_file = tmp_dir / f"incoming_{uuid.uuid4().hex[:8]}.ndjson"
    try:
        with open(tmp_file, "w", encoding="utf-8") as f:
            for rec in records:
                # 'point'/'the_geom' arrive as nested dicts; flatten to JSON
                # text so everything lands as VARCHAR.
                flat = {
                    c: (json.dumps(rec[c])
                        if isinstance(rec.get(c), (dict, list))
                        else rec.get(c))
                    for c in cols
                }
                flat["_row_hash"] = canonical_hash(rec)
                f.write(json.dumps(flat) + "\n")

        # Explicit all-VARCHAR column spec so read_json never guesses types
        # and missing keys become NULL instead of schema errors.
        col_spec = ", ".join(f"'{c}': 'VARCHAR'" for c in cols)
        select_cols = ", ".join(f'i."{c}"' for c in cols)
        con.execute("BEGIN")
        try:
            before = con.execute(
                f"SELECT count(*) FROM {src['table']}").fetchone()[0]
            # The idempotency guard: only hashes never seen before land.
            con.execute(f"""
                INSERT INTO {src['table']}
                SELECT {select_cols}, i._row_hash, now()
                FROM read_json(?, format='newline_delimited',
                               columns={{{col_spec}, '_row_hash': 'VARCHAR'}}) i
                WHERE NOT EXISTS (
                    SELECT 1 FROM {src['table']} t
                    WHERE t._row_hash = i._row_hash
                )
            """, [str(tmp_file)])
            after = con.execute(
                f"SELECT count(*) FROM {src['table']}").fetchone()[0]
            con.execute("COMMIT")
            return after - before
        except Exception:
            con.execute("ROLLBACK")
            raise
    finally:
        tmp_file.unlink(missing_ok=True)


def run(era: str, full_refresh: bool) -> None:
    src = SOURCES[era]
    mode = "full" if (full_refresh or src["incremental_col"] is None) \
        else "incremental"
    run_id = str(uuid.uuid4())[:8]
    started = dt.datetime.now()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH))
    ensure_schema(con)
    log(f"run {run_id} start source={src['dataset']} mode={mode}")

    rows_fetched = rows_new = 0
    max_as_of = None
    try:
        where = None
        if mode == "incremental":
            landed_max = con.execute(f"""
                SELECT max({src['incremental_col']})
                FROM {src['table']}
            """).fetchone()[0]
            if landed_max:
                # >= not >, so rows sharing the boundary timestamp are
                # refetched and the hash guard drops the ones already landed.
                # Strict > would silently skip late arrivals at the boundary.
                where = f"{src['incremental_col']} >= '{landed_max}'"
                log(f"  incremental from {landed_max}")
            else:
                log("  table empty, incremental falls back to full fetch")

        records = fetch_pages(src["dataset"], where)
        rows_fetched = len(records)
        rows_new = land(con, src, records)
        if src["incremental_col"]:
            max_as_of = con.execute(
                f"SELECT max({src['incremental_col']}) FROM {src['table']}"
            ).fetchone()[0]

        con.execute(
            "INSERT INTO meta.ingest_runs VALUES (?,?,?,?,?,?,?,?,?,?)",
            [run_id, started, dt.datetime.now(), src["dataset"], mode,
             rows_fetched, rows_new, max_as_of, "success", None],
        )
        log(f"run {run_id} success fetched={rows_fetched} new={rows_new} "
            f"max_data_as_of={max_as_of}")
    except Exception as e:
        con.execute(
            "INSERT INTO meta.ingest_runs VALUES (?,?,?,?,?,?,?,?,?,?)",
            [run_id, started, dt.datetime.now(), src["dataset"], mode,
             rows_fetched, rows_new, max_as_of, "failure", repr(e)],
        )
        log(f"run {run_id} FAILURE {e!r}")
        raise
    finally:
        con.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--era", choices=["new", "old"], default="new")
    p.add_argument("--full-refresh", action="store_true",
                   help="ignore the incremental watermark and refetch all")
    args = p.parse_args()
    try:
        run(args.era, args.full_refresh)
    except Exception:
        sys.exit(1)
