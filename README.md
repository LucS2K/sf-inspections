# SF Health Inspections: does enforcement work?

When a San Francisco food facility fails a health inspection or is closed,
does it improve, and does the improvement hold? This repo is the pipeline and
the analysis that answer that question, built as a portfolio piece and a
learning exercise.

## Data

| Source | Socrata ID | Role |
|---|---|---|
| Health Inspection Scores (2024-present) | `tvy3-wexg` | Analytical core. The only source that feeds outcome metrics. |
| Health Inspections (2020-2023) | `5tti-66ds` | Context only: facility tenure and history depth. |

The era split is deliberate. The older dataset uses a different rating
standard (LIVES, discontinued 2021), covers the COVID window, and has no
`permit_number`, so linking it to modern facilities is name-and-address
inference. It therefore never feeds failure, improvement, or durability
outcomes. Decided 2026-08-02.

Two cross-reference sources, both name+address matched (inferred linkage,
flagged wherever used):

| Source | Role |
|---|---|
| Registered Business Locations (`g8m3-pdis`) | Splits unresolved failures into attrition (business died) vs censoring. |
| Yelp Fusion API | Present-day rating snapshot for failure cohort + control. Cross-sectional correlation only. Key in gitignored `.env`. |

## Published dashboard

`site/` is a static interactive dashboard (KPIs, monthly trends, the
enforcement funnel, neighborhood failure rates, facility lookup) deployed to
Vercel. `site/build_data.py` exports event-level JSON from the marts; all
filtering happens client-side so the page needs no server. The weekly
Task Scheduler chain refreshes and redeploys it. Palette and chart specs
follow a validated accessible dataviz method (CVD-checked, dark mode,
table-view twins for every chart).

## Layout

```
ingest/fetch.py    Socrata -> DuckDB raw layer (incremental + full refresh)
ingest/fetch_registry.py   business-registry candidates for unresolved failures
ingest/fetch_yelp.py       Yelp ratings, failure cohort + control (resumable)
db/                inspections.duckdb (gitignored, rebuildable)
dbt/               staging and analysis models (run dbt from this directory)
site/              static dashboard + data export (deployed to Vercel)
schedule/          weekly Task Scheduler job (Mon 09:00): ingest -> dbt -> export -> deploy
logs/              ingest.log (gitignored)
data/tmp/          transient bulk-load files (gitignored)
```

## Pipeline contract

- **Append-only raw.** Republished record versions are kept; staging dedups
  with `ROW_NUMBER` over `data_as_of`.
- **Idempotent loads.** Every row carries `_row_hash` (MD5 of the canonical
  record JSON); loads anti-join on it, so re-running any window cannot
  duplicate rows.
- **Incremental** on `data_as_of >=` the landed watermark (`>=` so boundary
  ties are refetched and hash-deduped rather than silently skipped).
- **All raw columns are VARCHAR.** Casting is staging's job; a bad API value
  cannot fail a load.
- **Every run is logged** to `meta.ingest_runs` and `logs/ingest.log`,
  including failures.

## Cloud architecture

Production runs entirely in the cloud:

- **State: MotherDuck** (`md:sf_inspections`). The append-only raw layer
  must outlive any runner; a fresh full refetch would only capture the
  current snapshot and lose accumulated republish history.
- **Compute + schedule: GitHub Actions** (`.github/workflows/weekly-refresh.yml`,
  Mondays 16:00 UTC + manual dispatch): ingest -> dbt build -> export -> deploy.
- **Hosting: Vercel**, static deploy from the workflow.

Every script switches between local file and MotherDuck through one
function (`ingest/fetch.py::connect`): set `MOTHERDUCK_TOKEN` and you are
in the cloud, unset and you are local. dbt: `DBT_TARGET=prod` or `dev`.

Repo secrets required: `MOTHERDUCK_TOKEN`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
`VERCEL_PROJECT_ID`. One-time: `scripts/migrate_to_motherduck.py` copies
local raw+meta up; then disable the local Task Scheduler job
(`schtasks /Delete /TN "sf-inspections weekly ingest"`).

## Setup

```
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
python ingest/fetch.py              # incremental, tvy3-wexg
python ingest/fetch.py --full-refresh
python ingest/fetch.py --era old    # one-time 2020-2023 snapshot
schedule/register_task.ps1          # register the weekly job
```

## Known data quirks

See `CLAUDE.md`. Headlines: records are republished with later `data_as_of`
(dedup before anything), `total_time` has negative values (untrusted),
non-food permit types are mixed in (filter by `permit_type`), and
`violation_codes` concatenates code lists with statutory boilerplate.
