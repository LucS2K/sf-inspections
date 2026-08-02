-- Context-only era (see README): feeds facility tenure and history depth,
-- never outcome metrics. Collapses the raw violation grain (2.93 rows per
-- inspection) to one row per inspection_id.
SELECT
    inspection_id,
    -- verified constant per inspection_id (profiling 2026-08-02);
    -- any_value is only honest because of that check
    any_value(name)                    AS name,
    any_value(address)                 AS address,
    CAST(any_value(date) AS DATE)      AS inspection_date,
    -- worst status wins: any closure-severity row makes the visit a Closure.
    -- LIKE 'CONDI%' absorbs the observed typo variants of Conditional Pass.
    CASE max(CASE
            WHEN upper(facility_status) = 'CLOSURE'     THEN 3
            WHEN upper(facility_status) LIKE 'CONDI%'   THEN 2
            WHEN upper(facility_status) = 'PASS'        THEN 1
        END)
        WHEN 3 THEN 'Closure'
        WHEN 2 THEN 'Conditional Pass'
        WHEN 1 THEN 'Pass'
    END                                AS facility_status,
    -- type varies within 220 ids; keep all distinct values rather than
    -- pretending one is true
    string_agg(DISTINCT inspection_type, ' + ' ORDER BY inspection_type)
                                       AS inspection_types,
    -- 'None' is a literal value meaning no violation observed
    count(CASE WHEN violation_observed IS NOT NULL
                AND violation_observed <> 'None' THEN 1 END)
                                       AS violations_observed
FROM {{ source('raw', 'inspections_2020_2023') }}
GROUP BY inspection_id
