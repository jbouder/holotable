# Sample files

Small, made-up datasets shaped like the files people actually have, for
trying a DuckDB source by upload (#595, #596, #597). Each is served by the app at
`/samples/<name>` and linked from the upload form and the docs.

| File | Shape | Rows | Shows | Starter |
| --- | --- | --- | --- | --- |
| `household-expenses.csv` | a bank or budgeting export: `date, merchant, category, amount, payment_method` | 306 | CSV upload (#595) | Spending |
| `workouts.jsonl` | a fitness log, one object per line, with a nested `location` | 90 | JSON files (#596), a STRUCT column | Activity log |
| `home-energy.xlsx` | two sheets, `Electricity` and `Gas`, with real date cells | 183 each | Excel upload (#597), one view per sheet | Daily measurements, one per sheet |

Each sample is recognized as one of the starter dashboards for files (#606,
`src/lib/builtin-templates-files.ts`), which need no model: the Data sources
page offers it after **Create source**, and New dashboard leads with it.
`test/builtin-templates-files.test.ts` runs every panel of each against
these files, so a change to a sample's columns that loses its starter fails
there.

Six months, April to September 2026, generated with a fixed seed. Every
name is invented; nothing here is real data.
