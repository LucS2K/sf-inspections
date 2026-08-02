WITH typed AS (

    SELECT
        r.permit_number,
        r.dba,
        CAST(r.inspection_date AS DATE)     AS inspection_date,
        r.inspection_type,
        r.permit_type,
        c.permit_code,
        c.is_umbrella,
        r.facility_rating_status,
        CAST(r.violation_count AS INTEGER)  AS violation_count,
        r.violation_codes,
        r.inspector,
        r.street_address_clean,
        r.analysis_neighborhood,
        r.supervisor_district,
        CAST(r.latitude  AS DOUBLE)         AS latitude,
        CAST(r.longitude AS DOUBLE)         AS longitude,
        CAST(r.data_as_of AS TIMESTAMP)     AS data_as_of,
        r._row_hash
    FROM {{ source('raw', 'inspections_2024') }} r
    LEFT JOIN {{ ref('permit_type_classification') }} c
           ON c.permit_type = r.permit_type
    -- is_food, not "has a rating": rating coverage is messy (tobacco permits
    -- carry 75 rated rows) so food-ness is a reviewed classification, with a
    -- test failing the build if an unclassified permit_type ever appears
    WHERE c.is_food
      -- 18 raw rows have no facility key and cannot join any timeline
      AND r.permit_number IS NOT NULL
      -- one row is dated 2031, after its own publish date: physically impossible
      AND CAST(r.inspection_date AS DATE) <= CAST(r.data_as_of AS DATE)

),

latest_version AS (

    -- Republish dedup: when the same event arrives again with a later
    -- data_as_of (the feed's known behavior as increments accumulate),
    -- keep only rows from the newest publish stamp. Same-stamp multiplicity
    -- (farmers-market stalls, repeat same-day visits) is real and survives.
    SELECT *
    FROM typed
    QUALIFY data_as_of = max(data_as_of) OVER (
        PARTITION BY permit_number, inspection_date, inspection_type
    )

)

SELECT
    * EXCLUDE (_row_hash),
    -- makes the grain exactly unique without deleting real same-day visits;
    -- ordered by _row_hash only for determinism, the order is meaningless
    row_number() OVER (
        PARTITION BY permit_number, inspection_date, inspection_type
        ORDER BY _row_hash
    ) AS event_seq
FROM latest_version
