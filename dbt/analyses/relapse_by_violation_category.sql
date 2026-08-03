-- Stage 6 payoff: does WHAT a facility failed for predict whether the fix
-- lasts? Violations parsed from the concatenated violation_codes field
-- (deterministic parser at 97.4% agreement; LLM re-parse of the full
-- remainder, count-validated against the inspector's recorded totals),
-- classified into categories by reviewed keyword rules (method
-- keyword-rules-v1; see scripts/classify_violations_rules.py).
-- Finding: relapse rates are flat across categories (15-20% vs 20.5%
-- baseline) and flat across high-risk violation counts. Relapse behaves
-- like a facility property, not a violation-type property, consistent
-- with the repeat-offender concentration in the core findings.
--
-- Robustness check (2026-08-03): every description was independently
-- re-classified by an LLM (derived.violation_categories_llm). Label-level
-- agreement with the keyword rules is 65% (the disagreements are mostly
-- keyword false positives on boilerplate, e.g. "will call you back"
-- matching the illness pattern), but the finding is unchanged: swapping
-- in the LLM classification, relapse still runs 17-23% across every
-- category with a different ordering, confirming the gradient is noise.
WITH unified AS (
    SELECT permit_number, inspection_date, inspection_type, description
    FROM {{ source('derived', 'violation_segments') }} s
    WHERE count_agrees OR NOT EXISTS (
        SELECT 1 FROM {{ source('derived', 'violation_segments_llm') }} l
        WHERE l.permit_number = s.permit_number
          AND l.inspection_date = s.inspection_date
          AND coalesce(l.inspection_type,'') = coalesce(s.inspection_type,'')
          AND l.event_seq = s.event_seq)
    UNION ALL
    SELECT permit_number, inspection_date, inspection_type, description
    FROM {{ source('derived', 'violation_segments_llm') }}
),
eligible AS (
    SELECT e.permit_number, e.failure_date, e.failure_type,
           bool_or(s.facility_rating_status <> 'Pass') AS relapsed
    FROM {{ ref('fct_enforcement_episodes') }} e
    JOIN {{ ref('stg_inspections') }} s
      ON s.permit_number = e.permit_number
     AND s.facility_rating_status IS NOT NULL
     AND s.inspection_date > e.resolution_date
     AND s.inspection_date <= e.resolution_date + INTERVAL 365 DAY
    WHERE e.resolution_rating = 'Pass'
      AND e.resolution_date <= (SELECT max(inspection_date) - 365
                                FROM {{ ref('stg_inspections') }})
    GROUP BY 1, 2, 3
),
cats AS (
    SELECT DISTINCT el.permit_number, el.failure_date, el.relapsed, c.category
    FROM eligible el
    JOIN unified u
      ON u.permit_number = el.permit_number
     AND u.inspection_date = el.failure_date
     AND coalesce(u.inspection_type,'') = coalesce(el.failure_type,'')
    JOIN {{ source('derived', 'violation_categories') }} c
      ON c.description = u.description
)
SELECT category,
       count(*) AS episodes,
       count(*) FILTER (WHERE relapsed) AS relapsed,
       round(count(*) FILTER (WHERE relapsed) * 100.0 / count(*), 1) AS relapse_pct
FROM cats
GROUP BY 1
HAVING count(*) >= 30
ORDER BY relapse_pct DESC
