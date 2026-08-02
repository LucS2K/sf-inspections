"""One-time migration: copy the local raw + meta layers to MotherDuck.

Copies only the source-of-truth tables (raw.*, meta.*); staging and marts
are rebuilt in the cloud by dbt. Idempotent: existing cloud tables are
replaced wholesale, which is safe because local is the complete history at
migration time. Requires MOTHERDUCK_TOKEN in the environment or .env.

Usage: .venv/Scripts/python scripts/migrate_to_motherduck.py
"""

import os
import sys
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent

if not os.environ.get("MOTHERDUCK_TOKEN"):
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("MOTHERDUCK_TOKEN="):
                os.environ["MOTHERDUCK_TOKEN"] = line.split("=", 1)[1].strip()
if not os.environ.get("MOTHERDUCK_TOKEN"):
    sys.exit("MOTHERDUCK_TOKEN not set (env or .env)")

con = duckdb.connect("md:")
con.execute("CREATE DATABASE IF NOT EXISTS sf_inspections")
con.execute("USE sf_inspections")
con.execute(f"ATTACH '{ROOT / 'db' / 'inspections.duckdb'}' AS src (READ_ONLY)")

for schema in ("raw", "meta"):
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
    tables = [r[0] for r in con.execute(f"""
        SELECT table_name FROM src.information_schema.tables
        WHERE table_schema = '{schema}'
    """).fetchall()]
    for t in tables:
        n = con.execute(f"""
            CREATE OR REPLACE TABLE {schema}.{t} AS
            SELECT * FROM src.{schema}.{t}
        """).fetchone()
        rows = con.execute(f"SELECT count(*) FROM {schema}.{t}").fetchone()[0]
        print(f"{schema}.{t}: {rows} rows")

print("migration complete; run dbt build --target prod to build marts")
