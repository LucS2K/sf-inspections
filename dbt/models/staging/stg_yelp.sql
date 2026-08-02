-- One row per facility queried against Yelp. Lookups are retried across
-- runs (no_match rows especially), so a facility can accumulate several
-- result rows; the best one wins: a match beats a no_match, then latest
-- fetch wins. A rating is a present-day snapshot: valid for cross-sectional
-- correlation with hygiene outcomes, never for temporal claims. no_match
-- rows are kept because absence from Yelp is itself informative.
SELECT
    permit_number,
    cohort,
    match_status,
    yelp_id,
    yelp_name,
    CAST(rating AS DOUBLE)        AS rating,
    CAST(review_count AS INTEGER) AS review_count,
    price,
    categories,
    -- lands as Python 'True'/'False' strings from the fetcher
    CAST(is_closed AS BOOLEAN)    AS is_closed
FROM {{ source('raw', 'yelp_businesses') }}
QUALIFY row_number() OVER (
    PARTITION BY permit_number
    ORDER BY (match_status = 'matched') DESC, _fetched_at DESC
) = 1
