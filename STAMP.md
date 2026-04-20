# stamp in this repo

This repo's `main` branch is gated by [stamp-cli](https://github.com/OpenThinkAi/stamp-cli). Merges land through a three-persona agent review cycle, are signed with Ed25519, and are verified by a server-side hook before they're accepted. GitHub's copy of this repo is a read-only mirror pushed to automatically after each verified merge.

## The flow

```sh
# On a feature branch with your changes
stamp review --diff main..HEAD     # three reviewers run in parallel
stamp status --diff main..HEAD     # gate state; exit 0 open, 1 closed

# When the gate is open
git checkout main
stamp merge feature-branch --into main   # runs required_checks, signs the merge
stamp push main                           # server verifies + mirrors to GitHub
```

Each reviewer is an agent running a prompt committed at `.stamp/reviewers/<name>.md`. Gate configuration lives at `.stamp/config.yml`.

## Do NOT merge via GitHub PRs

GitHub is the read-only mirror, not the source of truth. Pushing directly to GitHub's `main` (or merging a GitHub PR) lands an unstamped commit that the stamp server will then overwrite on its next verified push. Worse, while the overwrite is pending, downstream consumers of the GitHub mirror can see the bad state.

Use PR branches on GitHub for external visibility (Claudini-style advisory review, collaborators opening PRs, etc.) — but **merge via `stamp merge` locally**, not via GitHub's "Merge" button.

## What's configured

- **Required reviewers on `main`:** `security`, `standards`, `product` (see `.stamp/reviewers/`)
- **Required checks on `main`:** `build` via `npm run build` (see `.stamp/config.yml`)
- **Mirror destination:** `OpenThinkAi/think-cli` on GitHub (see `.stamp/mirror.yml`)
- **Trusted signer:** the Ed25519 key at `.stamp/trusted-keys/sha256_a8a6320842....pub` — maintainer's operator key

## Reviewer prompts

The prompts in `.stamp/reviewers/*.md` are currently the stock starters scaffolded by `stamp init`. Calibration for think-cli's specific stack (cortex auth surface, SQLite handling, append-only JSONL semantics, agent-CLI ergonomics) is pending — see the discussion in PR #28 for context. Iterate on the prompts via the normal stamp merge flow: edit them on a branch, commit, review, merge.

Prompt-tuning without polluting verdict history: `stamp reviewers test <name> --diff <revspec>` runs a reviewer against any diff without recording to the DB.

## Adding a new pusher (future-team case)

Solo-operator setup today. To add someone else who'd push stamped merges:

1. They run `stamp keys generate` on their machine to create a local keypair
2. They run `stamp keys export` and give you the public key
3. You commit their `.pub` file to `.stamp/trusted-keys/` via a stamped merge
4. They also need SSH access to the Railway stamp server — you add their SSH public key to the `AUTHORIZED_KEYS` env var on Railway (the CONTAINER-side SSH credentials, separate from the stamp signing key)

## Troubleshooting

- **Server rejects a push as "untrusted signer"**: your stamp signing key isn't in `.stamp/trusted-keys/`. Run `stamp keys export --pub`, commit the output to the repo, merge.
- **SSH host key warnings**: the Railway container regenerates SSH host keys on rebuild. `ssh-keygen -R stamp && ssh stamp 'ls /srv/git/'` accepts the new key. All stamp repos share this host; one acceptance fixes them all.
- **`stamp review` says the gate is closed**: run `stamp status --diff main..HEAD` to see which reviewers haven't approved, then re-invoke them (edit the diff, `stamp review` again) or iterate on the prompts if they're wrong.

## Further reading

- [`SECURITY.md`](./SECURITY.md) — the security model for think-cli itself (unrelated to the stamp gate; documents CLI-level threats and the vuln disclosure process)
- [stamp-cli DESIGN.md](https://github.com/OpenThinkAi/stamp-cli/blob/main/DESIGN.md) — the stamp attestation schema and verification rules
- [stamp-cli server/README.md](https://github.com/OpenThinkAi/stamp-cli/blob/main/server/README.md) — Railway deployment details for the stamp server itself
