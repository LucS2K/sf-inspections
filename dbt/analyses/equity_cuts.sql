-- Stage 5: does the enforcement SYSTEM behave differently by geography?
-- Raw failure-rate maps cannot be read as hygiene differences (facility mix
-- varies by district: restaurant share ranges 41-77% and tracks failure
-- rate), so this measures the system's own behavior: response speed by
-- failure type, and the share of failures left unresolved past 90 days.
-- Per-district n is small (29-296 failures); medians only, no rates from
-- cells under 30, and no demographic joins (they would imply causal
-- framing this data cannot support).
SELECT supervisor_district AS district,
       count(*) AS failures,
       count(*) FILTER (WHERE failure_rating = 'Conditional Pass') AS cp_n,
       round(median(days_to_resolution)
             FILTER (WHERE failure_rating = 'Conditional Pass')) AS cp_median_days,
       count(*) FILTER (WHERE failure_rating = 'Closure') AS closure_n,
       round(median(days_to_resolution)
             FILTER (WHERE failure_rating = 'Closure')) AS closure_median_days,
       round(count(*) FILTER (WHERE resolution_date IS NULL
             AND failure_date <= (SELECT max(inspection_date) - 90
                                  FROM {{ ref('stg_inspections') }}))
             * 100.0 / count(*), 1) AS stale_unresolved_pct
FROM {{ ref('fct_enforcement_episodes') }}
WHERE supervisor_district IS NOT NULL
GROUP BY 1
ORDER BY stale_unresolved_pct DESC
