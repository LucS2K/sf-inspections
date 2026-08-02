-- One row per failure (Conditional Pass or Closure) at a non-umbrella food
-- facility. resolution_* is the next rated visit after the failure;
-- durability_* is the rated visit after that, i.e. the first observation of
-- whether the fix held once the routine cycle resumed. NULLs in either are
-- censoring: not yet observed inside the data window (or the facility never
-- reopened; distinguishing those requires the business-registry cross-check).
WITH rated AS (

    -- windows are computed over rated visits ONLY, so lead(.., 1) is by
    -- construction the next re-rating and lead(.., 2) the observation after
    SELECT
        permit_number,
        dba,
        analysis_neighborhood,
        supervisor_district,
        inspection_date,
        inspection_type,
        facility_rating_status,
        violation_count,
        lead(inspection_date)           OVER w AS resolution_date,
        lead(facility_rating_status)    OVER w AS resolution_rating,
        lead(inspection_type)           OVER w AS resolution_type,
        lead(violation_count)           OVER w AS resolution_violation_count,
        lead(inspection_date, 2)        OVER w AS durability_date,
        lead(facility_rating_status, 2) OVER w AS durability_rating
    FROM {{ ref('stg_inspections') }}
    WHERE NOT is_umbrella
      AND facility_rating_status IS NOT NULL
    WINDOW w AS (
        PARTITION BY permit_number
        -- type tiebreak: same-day different-type visits share event_seq,
        -- and an ambiguous sort makes LEAD nondeterministic per run
        ORDER BY inspection_date, event_seq, inspection_type NULLS FIRST
    )

)

SELECT
    permit_number,
    dba,
    analysis_neighborhood,
    supervisor_district,
    inspection_date                     AS failure_date,
    inspection_type                     AS failure_type,
    facility_rating_status              AS failure_rating,
    violation_count                     AS failure_violation_count,
    resolution_date,
    resolution_date - inspection_date   AS days_to_resolution,
    resolution_rating,
    resolution_type,
    resolution_violation_count,
    durability_date,
    durability_date - resolution_date   AS days_resolution_to_durability,
    durability_rating,
    -- a failure is a repeat if this facility already failed before it
    row_number() OVER (
        PARTITION BY permit_number
        ORDER BY inspection_date
    ) AS failure_number
FROM rated
WHERE facility_rating_status IN ('Conditional Pass', 'Closure')
