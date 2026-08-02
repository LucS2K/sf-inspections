-- Fails if the declared staging grain is ever violated.
SELECT permit_number, inspection_date, inspection_type, event_seq, count(*)
FROM {{ ref('stg_inspections') }}
GROUP BY 1, 2, 3, 4
HAVING count(*) > 1
