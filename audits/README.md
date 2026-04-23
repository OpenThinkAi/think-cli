# audits

Archive of external / structured security audits against open-think. Each file is the as-delivered audit report, preserved for compliance and future-auditor context.

## Index

| File | Date | Scope | Status | Resolution |
|---|---|---|---|---|
| [`2026-04-19-pre-distribution.md`](./2026-04-19-pre-distribution.md) | 2026-04-19 | Pre-npm-distribution audit against commit `a5750d0` (v0.4.1) | Resolved | All five priorities shipped via PR [#27](https://github.com/OpenThinkAi/think-cli/pull/27); stamp-gate setup via [#28](https://github.com/OpenThinkAi/think-cli/pull/28) |

## Conventions

- Filenames: `YYYY-MM-DD-<scope>.md`. Date is when the audit was delivered, not when findings were fixed.
- Content is preserved as-delivered. The only permitted edit to an audit file is a **status banner** at the top pointing at the resolving PR(s) — see `2026-04-19-pre-distribution.md` for the pattern. Do not edit the body: if a finding is incorrect or explicitly accepted as a trade-off, capture that in either the resolving PR's commit message or a `Deviations` column in the Index below.
- The `Status` column in the Index is one of `Open`, `In progress`, `Resolved`, `Accepted (trade-off)`, or `Superseded`. The `Resolution` column carries concrete PR links / commit SHAs so a compliance reader doesn't have to grep the history.
- This directory is not a threat model (see [`../SECURITY.md`](../SECURITY.md) for that) and not a roadmap. It's an append-only record of what was audited, by whom, when, and how findings were addressed.

## Reporting a new vulnerability

Do not open issues here. Follow the disclosure process in [`../SECURITY.md`](../SECURITY.md).
