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
- **Trusted signer:** the Ed25519 key at `.stamp/trusted-keys/sha256_<fingerprint>.pub` — currently the maintainer's operator key. Actual filenames on disk carry the full 64-hex-char SHA-256 fingerprint; `ls .stamp/trusted-keys/` to see them.

## Reviewer prompts

The prompts in `.stamp/reviewers/*.md` are currently the stock starters scaffolded by `stamp init`. Calibration for think-cli's specific stack (cortex auth surface, SQLite handling, append-only JSONL semantics, agent-CLI ergonomics) is pending — see the discussion in PR #28 for context. Iterate on the prompts via the normal stamp merge flow: edit them on a branch, commit, review, merge.

Prompt-tuning without polluting verdict history: `stamp reviewers test <name> --diff <revspec>` runs a reviewer against any diff without recording to the DB.

## Publishing a release

`@openthink/think` is published to npm by `.github/workflows/publish.yml`, which runs on every push to `main` (including the post-receive mirror push from the stamp server) and publishes only when `packages/cli/package.json` declares a version that isn't already on the registry. Every non-bump merge no-ops safely. A version bump does not publish by itself either: the publish job waits in the `npm-publish` GitHub Environment until a maintainer approves the deployment.

Cutting a release:

```sh
# From main, off the latest stamped merge
git checkout -b release/vX.Y.Z main
# Bump packages/cli/package.json "version" → X.Y.Z
bun install                            # refresh bun.lock with the new version
git add packages/cli/package.json bun.lock
git commit -m "chore: bump version to X.Y.Z"

# Stamp + merge as usual
stamp review --diff main..HEAD
git checkout main
stamp merge release/vX.Y.Z --into main
stamp push main                         # server mirrors to GitHub; workflow fires
# Then approve the waiting `npm-publish` deployment in the run's page on GitHub Actions.
```

The workflow has three jobs, each holding only the permission it needs (AGT-2325):

- **build** (`contents: read`, no OIDC): reads and validates the version, skips everything if `npm view @openthink/think@<version>` already returns it, then runs `bun install --frozen-lockfile`, typecheck, the test suite, the build and `npm pack`, and uploads the tarball as an artifact. This is the only job that runs dependency code. A red test or a drifted `bun.lock` blocks the publish (AGT-060).
- **publish** (`id-token: write` only, `npm-publish` environment): downloads the tarball and runs `npm publish <tarball> --provenance --ignore-scripts`. No checkout, no install, no lifecycle scripts. Auth is OIDC trusted publishing — no `NPM_TOKEN` secret. The publish step stays on the npm CLI because `bun publish` doesn't yet support npm Trusted Publisher OIDC.
- **tag** (`contents: write`): pushes `vX.Y.Z` after a successful publish. Runs only git.

The dist-tag comes from the version: bare `X.Y.Z` → `latest`; `X.Y.Z-alpha.N` → `alpha` (likewise `beta`, `rc`, etc.) so prereleases never clobber `latest`. Bun is pinned to an exact version in both `publish.yml` and `test.yml` (AGT-2326); bump it in both files together.

**One-time setup (repository + npm side; not workflow content):**

1. **Environment.** GitHub → Settings → Environments → New environment `npm-publish`. Add yourself under *Required reviewers*, leave *Prevent self-review* unticked (solo maintainer), and set *Deployment branches and tags* → *Selected branches* → `main`. GitHub auto-creates an unprotected environment the first time the workflow references it, so until this is configured a version bump still publishes without approval.
2. **npm Trusted Publisher.** <https://www.npmjs.com/package/@openthink/think/access> → Trusted Publisher → GitHub Actions: organization `OpenThinkAi`, repository `think-cli`, workflow `publish.yml`, environment `npm-publish`. Tokens minted outside that environment are then refused.
3. **Mirror-only `main`.** GitHub → Settings → Rules → Rulesets → New branch ruleset `stamp-mirror-only`: enforcement Active, target the default branch, rules *Restrict updates*, *Restrict deletions* and *Block force pushes*, bypass list = **Deploy keys** only (the `stamp-mirror` key the stamp server pushes with). This stops a direct push or a GitHub PR merge from landing an unstamped commit on `main`, matching stamp-cli's ruleset of the same name.

Do step 2 only after this version of `publish.yml` is on `main` (a Trusted Publisher bound to an environment refuses runs that don't use it). Break-glass for an emergency push to `main`: temporarily set the `stamp-mirror-only` ruleset to Disabled, push, then re-enable it.

## Adding a new pusher (future-team case)

Solo-operator setup today. To add someone else who'd push stamped merges:

1. They run `stamp keys generate` on their machine to create a local keypair
2. They run `stamp keys export` (prints their public key to stdout) and give you the output
3. You commit their `.pub` file to `.stamp/trusted-keys/` via a stamped merge
4. They also need SSH access to the Railway stamp server — you add their SSH public key to the `AUTHORIZED_KEYS` env var on Railway (the CONTAINER-side SSH credentials, separate from the stamp signing key)

## Troubleshooting

- **Server rejects a push as "untrusted signer"**: your stamp signing key isn't in `.stamp/trusted-keys/`. Run `stamp keys export` (prints the public key to stdout), save it to `.stamp/trusted-keys/sha256_<your-fingerprint>.pub`, commit, and merge via a stamped PR.
- **SSH host key warnings**: the Railway container regenerates SSH host keys on rebuild. `ssh-keygen -R stamp && ssh stamp 'ls /srv/git/'` accepts the new key. All stamp repos share this host; one acceptance fixes them all.
- **`stamp review` says the gate is closed**: run `stamp status --diff main..HEAD` to see which reviewers haven't approved, then re-invoke them (edit the diff, `stamp review` again) or iterate on the prompts if they're wrong.

## Further reading

- [`SECURITY.md`](./SECURITY.md) — the security model for think-cli itself (unrelated to the stamp gate; documents CLI-level threats and the vuln disclosure process)
- [stamp-cli DESIGN.md](https://github.com/OpenThinkAi/stamp-cli/blob/main/DESIGN.md) — the stamp attestation schema and verification rules
- [stamp-cli server/README.md](https://github.com/OpenThinkAi/stamp-cli/blob/main/server/README.md) — Railway deployment details for the stamp server itself
