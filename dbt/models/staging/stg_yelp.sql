-- One row per facility queried against Yelp, matched or not. A rating is a
-- present-day snapshot: valid for cross-sectional correlation with hygiene
-- outcomes, never for temporal claims. no_match rows are kept because
-- absence from Yelp is itself informative (and not random).
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
