# Stage 10 acceptance — source-aware tag alignment
Plugin 0.1.5; tested host dsh 0.1.5-rc.2 at fb2c4b9e698e30edb738bca4cf0618587db7d203; date 2026-09-13.

The knowledge view now uses crosswalk 2026.09.13.1, retaining exact raw labels and source instances. Exact synonyms and conservative category mappings feed provisional counts; ambiguous, composite, narrower and unknown labels remain review gaps. Candidate nodes never count. OI Wiki entries and Luogu numeric IDs remain references. The mapping table provides source/relation filters, an unresolved-only checkbox, 20-row pagination, explanations and attributed links.

## Checks actually completed
- `npm run check`: 685 behavior tests and 9 construction-script tests passed, no failures/skips; type, architecture, build, shared React/client factory and disposal checks passed.
- Focused worker crosswalk/knowledge/UI suites: 55 tests passed. Coordinator review removed further unsafe equivalences and corrected table styling; final type/build/client checks were rerun after the presentation fixes.
- Browser on the isolated local profile: expanded mappings; traversed both pages of imported labels; used unresolved-only, exact relation and source filters; verified honest empty intersections; reset filters and switched to an existing synthetic account; checked reference URLs and noopener/noreferrer.
- Runtime API confirmed plugin/host versions. Every installed dist file was compared by SHA-256 with the tested build.
- All 19 persistent application tables, formal weakness reports, coverage and raw provenance matched the pre-upgrade baseline. SQLite integrity passed; a backup was taken first. Frozen v1/v2 taxonomy, snapshots, tag decisions and native statistics files remained unchanged.
- No new platform import or runtime model batch was needed. CF records were exercised locally; Luogu/Nowcoder/OI semantics used deterministic public-term fixtures, not a live Nowcoder import.

## Remaining boundaries
This is a reviewed subset, not an exhaustive four-source dictionary. Luogu already imports names and numeric IDs; a versioned numeric-ID-to-concept crosswalk is future work. Nowcoder has reference vocabulary rules but no import adapter. OI Wiki is a learning resource, not an OJ with account/submission imports.

Old combined taxonomy nodes still require a future explicit migration. Narrower labels remain pending until precise nodes exist. Existing AI/manual decisions and retrospectives keep their IDs; raw mapping never proves the solver's actual method or independent mastery.

Sources, relation semantics and examples are documented in [tag-alignment.md](../tag-alignment.md); these are project-maintained decisions, not an official joint taxonomy. Source changes are version-controlled publicly. The package was installed locally; no GitHub Release or public binary distribution was performed.
