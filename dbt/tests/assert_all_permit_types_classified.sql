-- Fails if raw ever contains a permit_type missing from the seed.
-- Guards the silent-exclusion failure mode of the LEFT JOIN + is_food
-- filter in stg_inspections: an unclassified type would otherwise vanish
-- from staging without anyone noticing.
SELECT DISTINCT r.permit_type
FROM {{ source('raw', 'inspections_2024') }} r
LEFT JOIN {{ ref('permit_type_classification') }} c
       ON c.permit_type = r.permit_type
WHERE r.permit_type IS NOT NULL
  AND c.permit_type IS NULL
