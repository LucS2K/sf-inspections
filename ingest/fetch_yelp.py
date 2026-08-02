"""Fetch Yelp ratings for the failure cohort plus an equal-size random
control of never-failed facilities, via the Yelp Fusion API.

Two calls per facility: /businesses/matches (name + address, built for
exactly this fuzzy-linkage problem) then /businesses/{id} for rating,
review_count, price, and Yelp's own is_closed flag. Lands append-only in
raw.yelp_businesses; facilities already fetched are skipped, so the script
resumes cleanly after a rate-limit stop (HTTP 429 ends the run gracefully,
it does not fail it).

Caveats that travel with this data: a rating fetched today is one
cross-sectional snapshot against inspections spanning 2024-2026, matching
is name+address inference, and facilities missing from Yelp are not a
random subset. Correlation only, no causal or temporal claims.
"""

import datetime as dt
import sys
import time
import uuid
from pathlib import Path

import duckdb
import requests

from fetch import DB_PATH, TIMEOUT, canonical_hash, log

MATCH_URL = "https://api.yelp.com/v3/businesses/matches"
DETAIL_URL = "https://api.yelp.com/v3/businesses/{}"
FIELDS = ["yelp_id", "yelp_name", "yelp_address", "rating", "review_count",
          "price", "categories", "is_closed", "yelp_url"]
CONTROL_SIZE = 850  # roughly the size of the failure cohort


def api_key() -> str:
    env = Path(__file__).resolve().parent.parent / ".env"
    for line in env.read_text().splitlines():
        if line.startswith("YELP_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("YELP_API_KEY not found in .env")


class RateLimited(Exception):
    pass


def get(url: str, headers: dict, params: dict | None = None) -> dict | None:
    # transient network errors get 3 retries with backoff; a mid-run blip
    # otherwise kills a 25-minute fetch at minute 24
    for attempt in range(3):
        try:
            resp = requests.get(url, headers=headers, params=params,
                                timeout=TIMEOUT)
            break
        except (requests.ConnectionError, requests.Timeout):
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
    if resp.status_code == 429:
        raise RateLimited
    if resp.status_code == 404:
        return None
    if resp.status_code in (400, 401, 403):
        # 400 with a key-format complaint and 401/403 mean every call will
        # fail: abort the run instead of landing 1,700 phantom no_matches
        raise RuntimeError(f"Yelp auth/validation error {resp.status_code}: "
                           f"{resp.text[:200]}")
    resp.raise_for_status()
    return resp.json()


def main() -> None:
    headers = {"Authorization": f"Bearer {api_key()}"}
    run_id = str(uuid.uuid4())[:8]
    started = dt.datetime.now()
    con = duckdb.connect(str(DB_PATH))
    cols = ", ".join(f'"{c}" VARCHAR' for c in FIELDS)
    con.execute(f"""
        CREATE TABLE IF NOT EXISTS raw.yelp_businesses (
            permit_number VARCHAR,
            cohort VARCHAR,
            match_status VARCHAR,
            {cols},
            _row_hash VARCHAR,
            _fetched_at TIMESTAMP
        )
    """)

    # failure cohort first so the analysis-critical group lands before any
    # rate limit; control is a deterministic pseudo-random sample (hash
    # order), reproducible across resumed runs
    facilities = con.execute(f"""
        WITH failure_cohort AS (
            SELECT DISTINCT permit_number FROM fct_enforcement_episodes
        ),
        latest AS (
            SELECT permit_number, dba, street_address_clean,
                   row_number() OVER (PARTITION BY permit_number
                                      ORDER BY inspection_date DESC) AS rn
            FROM stg_inspections
            WHERE NOT is_umbrella
        ),
        base AS (
            SELECT l.permit_number, l.dba, l.street_address_clean,
                   CASE WHEN f.permit_number IS NOT NULL
                        THEN 'failure' ELSE 'control' END AS cohort
            FROM latest l
            LEFT JOIN failure_cohort f USING (permit_number)
            WHERE l.rn = 1
        )
        SELECT * FROM base
        WHERE cohort = 'failure'
           OR permit_number IN (
                SELECT permit_number FROM base WHERE cohort = 'control'
                ORDER BY hash(permit_number) LIMIT {CONTROL_SIZE})
        -- failure cohort genuinely first ('control' sorts before 'failure'
        -- alphabetically, which silently inverted the priority)
        ORDER BY CASE cohort WHEN 'failure' THEN 0 ELSE 1 END, permit_number
    """).fetchall()

    done = {r[0] for r in con.execute(
        "SELECT DISTINCT permit_number FROM raw.yelp_businesses "
        "WHERE match_status = 'matched'").fetchall()}
    todo = [f for f in facilities if f[0] not in done]
    log(f"run {run_id} yelp lookup: {len(todo)} facilities "
        f"({len(done)} already fetched)")

    fetched = new = 0
    status = "success"
    err = None
    try:
        for permit, dba, address, cohort in todo:
            match = get(MATCH_URL, headers, {
                "name": (dba or "")[:64], "address1": (address or "")[:64],
                "city": "San Francisco", "state": "CA", "country": "US",
                "match_threshold": "default", "limit": 1})
            fetched += 1
            time.sleep(0.25)
            rec: dict = {}
            if match and match.get("businesses"):
                biz = match["businesses"][0]
                detail = get(DETAIL_URL.format(biz["id"]), headers) or {}
                fetched += 1
                time.sleep(0.25)
                rec = {
                    "yelp_id": biz["id"],
                    "yelp_name": detail.get("name"),
                    "yelp_address": " ".join(
                        detail.get("location", {}).get("display_address", [])),
                    "rating": detail.get("rating"),
                    "review_count": detail.get("review_count"),
                    "price": detail.get("price"),
                    "categories": ", ".join(
                        c["title"] for c in detail.get("categories", [])),
                    "is_closed": detail.get("is_closed"),
                    "yelp_url": detail.get("url"),
                }
            match_status = "matched" if rec else "no_match"
            row_hash = canonical_hash({"permit": permit, **rec})
            if not con.execute(
                    "SELECT 1 FROM raw.yelp_businesses WHERE _row_hash = ?",
                    [row_hash]).fetchone():
                con.execute(
                    f"INSERT INTO raw.yelp_businesses VALUES "
                    f"({', '.join(['?'] * (len(FIELDS) + 5))})",
                    [permit, cohort, match_status]
                    + [None if rec.get(f) is None else str(rec.get(f))
                       for f in FIELDS]
                    + [row_hash, dt.datetime.now()])
                new += 1
    except RateLimited:
        status = "rate_limited"
        log(f"run {run_id} hit Yelp rate limit, stopping cleanly; "
            f"re-run tomorrow to resume")
    except Exception as e:
        status, err = "failure", repr(e)
        raise
    finally:
        con.execute(
            "INSERT INTO meta.ingest_runs VALUES (?,?,?,?,?,?,?,?,?,?)",
            [run_id, started, dt.datetime.now(), "yelp-fusion", "lookup",
             fetched, new, None, status, err])
        log(f"run {run_id} {status} calls={fetched} facilities_new={new}")
        con.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
