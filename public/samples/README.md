# Sample files

Small, made-up datasets shaped like the files people actually have, for
trying a DuckDB source by upload (#595). Each is served by the app at
`/samples/<name>` and linked from the upload form and the docs.

| File | Shape | Rows | Shows |
| --- | --- | --- | --- |
| `household-expenses.csv` | a bank or budgeting export: `date, merchant, category, amount, payment_method` | 306 | CSV upload (#595) |
| `workouts.jsonl` | a fitness log, one object per line, with a nested `location` | 90 | JSON files (#596), a STRUCT column |
| `home-energy.xlsx` | two sheets, `Electricity` and `Gas`, with real date cells | 183 each | Excel upload (#597), one view per sheet |

Six months, April to September 2026, generated with a fixed seed. Every
name is invented; nothing here is real data.
