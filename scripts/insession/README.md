# In-session LLM parse and classification artifacts

When Anthropic API credits ran out with 123 of 301 hard parse rows
remaining, the work was finished by Claude reading the rows directly in a
Claude Code session instead of through the paid API. These files make that
work reproducible and auditable:

- `desc_catalog.ndjson` — the 298 distinct violation descriptions, with
  IDs. Parses reference these IDs so inserted strings match the corpus
  byte for byte (no spurious new distincts).
- `reparse_out_*.json` — the model's segmentation of each remaining row:
  section-code strings (aliased for the giant recurring statutory lists)
  plus a catalog ID per segment.
- `load_reparse.py` — validating loader. Refuses to insert unless every
  row's segment count equals the inspector's recorded violation count and
  every code string and description appears verbatim in the row's raw
  text. Result: 123 rows, 684 segments, zero validation failures;
  parse coverage is now 301/301 of the disagreeing rows.
- `classify_llm.json` — independent classification of all 298
  descriptions (category + CRFC-style risk tier), used as a robustness
  check against the keyword ruleset. Agreement 65% at label level; the
  relapse-by-category finding is unchanged under either classification.
- `load_classify.py` — loads the classification to
  `derived.violation_categories_llm` and prints the comparison.

Both loaders run against local or MotherDuck depending on
`MOTHERDUCK_TOKEN`, same as every other script in the repo.
