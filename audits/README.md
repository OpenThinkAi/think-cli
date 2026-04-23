# audits

Archive of external / structured security audits against open-think. Each file is the as-delivered audit report, preserved for compliance and future-auditor context.

## Index

| File | Date | Scope | Status |
|---|---|---|---|
| [`2026-04-19-pre-distribution.md`](./2026-04-19-pre-distribution.md) | 2026-04-19 | Pre-npm-distribution audit against commit `a5750d0` (v0.4.1) | All findings resolved — see referenced PR in repo history |

## Conventions

- Filenames: `YYYY-MM-DD-<scope>.md`. Date is when the audit was delivered, not when findings were fixed.
- Content is preserved as-delivered. If an audit finding turns out to be incorrect or is explicitly accepted as a trade-off, note that in the fixing PR's commit message, not by editing the audit text.
- This directory is not a threat model (see [`../SECURITY.md`](../SECURITY.md) for that) and not a roadmap. It's an append-only record of what was audited, by whom, when, and how findings were addressed.

## Reporting a new vulnerability

Do not open issues here. Follow the disclosure process in [`../SECURITY.md`](../SECURITY.md).
