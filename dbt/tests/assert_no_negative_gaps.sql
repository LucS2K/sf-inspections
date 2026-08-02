-- Fails if any gap is negative: would mean the window ordering and the
-- date arithmetic disagree, i.e. the timeline is corrupt.
SELECT * FROM {{ ref('fct_inspection_timeline') }}
WHERE days_since_prev < 0 OR days_to_next < 0
