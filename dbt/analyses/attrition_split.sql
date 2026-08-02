-- Splits unresolved enforcement failures (no rated visit after failure)
-- by business-registry status. Matching rule: a registry candidate counts
-- only on exact normalized-name equality; address-prefix hits with other
-- names are successor evidence, not matches. Registry lag caveat: owners
-- often never file end dates, so "still registered" is weak evidence the
-- business is open; "ended" is strong evidence it is not.
WITH unresolved AS (
    SELECT DISTINCT e.permit_number, e.failure_rating, e.failure_date,
           s.dba
    FROM {{ ref('fct_enforcement_episodes') }} e
    JOIN {{ ref('stg_inspections') }} s
      ON s.permit_number = e.permit_number
     AND s.inspection_date = e.failure_date
    WHERE e.resolution_date IS NULL
),
norm AS (
    SELECT *, regexp_replace(upper(trim(dba)), '\s+', ' ', 'g') AS dba_n
    FROM unresolved
),
cand AS (
    SELECT queried_permit_number AS permit_number,
           regexp_replace(upper(trim(dba_name)), '\s+', ' ', 'g') AS cand_dba_n,
           CAST(location_end_date AS DATE)   AS end_date,
           CAST(location_start_date AS DATE) AS start_date
    FROM {{ source('raw', 'registry_candidates') }}
),
per_facility AS (
    SELECT n.permit_number, n.failure_rating, n.failure_date,
           count(*) FILTER (WHERE c.cand_dba_n = n.dba_n) AS name_matches,
           bool_or(c.cand_dba_n = n.dba_n AND c.end_date IS NULL) AS name_active,
           max(c.end_date) FILTER (WHERE c.cand_dba_n = n.dba_n) AS name_end_date,
           bool_or(c.cand_dba_n <> n.dba_n
                   AND c.start_date > n.failure_date) AS successor_after_failure
    FROM norm n
    LEFT JOIN cand c USING (permit_number)
    GROUP BY 1, 2, 3
)
SELECT failure_rating,
       CASE
           WHEN name_active THEN 'still registered'
           WHEN name_matches > 0
                AND name_end_date >= failure_date - 180 THEN 'ended near/after failure'
           WHEN name_matches > 0 THEN 'ended long before failure'
           WHEN successor_after_failure THEN 'successor at address'
           ELSE 'no registry match'
       END AS registry_status,
       count(*) AS facilities
FROM per_facility
GROUP BY 1, 2
ORDER BY 1, 3 DESC
