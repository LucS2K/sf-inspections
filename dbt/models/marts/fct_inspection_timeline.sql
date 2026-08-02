-- One row per inspection event at a non-umbrella food facility, enriched
-- with its neighbors in that facility's timeline. NULL prev_* means first
-- observed visit; NULL next_* means none observed yet (censoring, not
-- absence: the facility may simply not have been revisited before the
-- data window ends).
SELECT
    permit_number,
    dba,
    inspection_date,
    inspection_type,
    facility_rating_status,
    violation_count,
    analysis_neighborhood,
    supervisor_district,
    event_seq,
    row_number() OVER w              AS visit_number,
    lag(inspection_date) OVER w      AS prev_inspection_date,
    -- DATE - DATE yields integer days in DuckDB
    inspection_date - lag(inspection_date) OVER w  AS days_since_prev,
    lag(inspection_type) OVER w      AS prev_inspection_type,
    lag(facility_rating_status) OVER w AS prev_rating,
    lead(inspection_date) OVER w     AS next_inspection_date,
    lead(inspection_date) OVER w - inspection_date AS days_to_next,
    lead(inspection_type) OVER w     AS next_inspection_type,
    lead(facility_rating_status) OVER w AS next_rating
FROM {{ ref('stg_inspections') }}
WHERE NOT is_umbrella
-- event_seq tiebreak makes same-day ordering deterministic; NULLS FIRST on
-- type so a same-day (unknown-type, typed) pair orders stably too
WINDOW w AS (
    PARTITION BY permit_number
    ORDER BY inspection_date, event_seq, inspection_type NULLS FIRST
)
