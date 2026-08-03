-- Yelp rating vs enforcement history, cross-sectional. Read with the
-- selection artifact stated first: 86.1% of the failure cohort matches on
-- Yelp vs 66.8% of control (enforcement lands on restaurants; the control
-- includes markets/cafeterias Yelp doesn't list). Ratings are a present-day
-- snapshot against 2024-2026 inspections: correlation only, no causality,
-- no temporal claims.
WITH sev AS (
    SELECT y.permit_number, y.rating, y.review_count,
           CASE WHEN e.permit_number IS NULL THEN 'control (never failed)'
                WHEN max(CASE WHEN e.failure_rating = 'Closure' THEN 1 ELSE 0 END) = 1
                     THEN 'ever closed'
                ELSE 'conditional pass only' END AS grp
    FROM {{ ref('stg_yelp') }} y
    LEFT JOIN {{ ref('fct_enforcement_episodes') }} e USING (permit_number)
    WHERE y.match_status = 'matched' AND y.rating IS NOT NULL
    GROUP BY 1, 2, 3, e.permit_number IS NULL
)
SELECT grp, count(*) AS n,
       round(avg(rating), 2) AS mean_rating,
       round(median(rating), 1) AS median_rating,
       round(median(review_count)) AS median_reviews
FROM sev
GROUP BY 1
ORDER BY 1
