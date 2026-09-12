# CF construction replan (2026-09-12)

The two combined acceptance rounds ended with the HTTP layer checked, but CF normalization and editorial parsing incomplete. The latest worker spent 27 main requests inspecting existing context before its first write, so repeating the combined task would not be an effective repair strategy.

Keep the validated HTTP module. Replace the unfinished editorial heuristics with a smaller strict algorithm: only explicit full problem references identify a section; paragraph and heading boundaries preserve inline text; method subheadings stay inside the selected problem. Do not infer a contest for bare letters. Long legacy paragraphs with multiple unrelated problem sections require manual selection.

Remaining work is split into separate deliverables:
1. Editorial identity and extraction: at most three production files (problem-index, editorial, html), isolated tests; no HTTP/catalog orchestration.
2. CF catalog/submission adapter wiring: adapter and cursor modules, tests against original synthetic records and private captured public payloads.
3. Luogu/manual parsing and import orchestration in subsequent contracts.

Worker context reads are limited to named relevant files. Coordinator supplies observed failures; workers do not repeat live research or scan benchmark archives. Tests are run once after meaningful changes; reports are written once, after implementation. Preserve the 40-request and 30-minute bounds; scope is reduced instead of increasing limits.
