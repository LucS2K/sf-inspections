-- Do public complaints catch what inspections miss?
-- Complaint-triggered visits (Complaint (I)/(R)) and Foodborne Illness
-- investigations, compared with routine surveillance. No new data source:
-- these are inspection types already present in tvy3-wexg.
--
-- Findings (verified 2026-08-03 against prod):
--   808 complaint visits (677 initial + 131 re-visits) + 268 foodborne-
--   illness investigations since 2024, reaching 721 distinct facilities.
--   ~91% of complaint and illness visits log zero violations, vs 21% of
--   routine visits. Rated complaint visits fail at 2.7% vs routine 9.0%.
--   Of 452 closures on record: routine 254, reinspection 91, complaint 16,
--   foodborne illness 1, other typed 11, untyped 79 (type labels lag).
--
-- Caveats: a complaint visit is scoped to the allegation (zero violations
-- means unsubstantiated on arrival, not full-checklist clean); complaint
-- filing dates/content are not published, so complaint-to-visit response
-- time is unmeasurable from this data.

with rated as (
    select *
    from {{ ref('stg_inspections') }}
    where not is_umbrella and facility_rating_status is not null
)

select
    inspection_type,
    count(*)                                                        as rated_visits,
    round(100.0 * sum(case when coalesce(violation_count, 0) = 0
                           then 1 else 0 end) / count(*), 1)        as pct_zero_violations,
    sum(case when facility_rating_status in ('Conditional Pass', 'Closure')
             then 1 else 0 end)                                     as failures,
    round(100.0 * sum(case when facility_rating_status in ('Conditional Pass', 'Closure')
                           then 1 else 0 end) / count(*), 1)        as failure_rate_pct,
    sum(case when facility_rating_status = 'Closure'
             then 1 else 0 end)                                     as closures
from rated
where inspection_type in ('Routine', 'Reinspection', 'Complaint (I)',
                          'Complaint (R)', 'Foodborne Illness')
group by 1
order by rated_visits desc
