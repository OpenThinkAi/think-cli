# Contributing to open-think

Thanks for your interest in contributing! Here's how to get started.

## Before you start

- **Open an issue first** for anything beyond a small bug fix. This lets us discuss the approach before you invest time writing code.
- Check existing issues to avoid duplicate work.

## Development setup

```bash
git clone git@github.com:OpenThinkAi/think-cli.git
cd think-cli
bun install
bun run dev -- sync "test entry"
```

Requires **Node 22.5+** (uses `node:sqlite`) and **bun** for install/build/test (the runtime is still Node — bun handles the dev tooling). Install bun from <https://bun.sh> if you don't have it. Bun replaced npm in this repo because npm bakes platform-specific optional native bindings into `package-lock.json`, which breaks cross-platform `npm ci` (see `npm/cli#4828`).

You can still run the published binary or invoke individual scripts via `node`/`npx` — bun is only required for the in-repo install/build/test cycle.

## Making changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `bun run build` to verify everything compiles
4. Run `bun run test` to verify tests still pass
5. Commit with a clear message describing what and why
6. Open a PR against `main`

CI uses `bun install --frozen-lockfile`, so include the updated `bun.lock` in your commit if you've added or upgraded dependencies — a drifted lockfile fails the workflow.

## Pull requests

- Keep PRs focused — one feature or fix per PR
- Include a description of what changed and why
- Link to the related issue if one exists

## What we're looking for

- Bug fixes with clear reproduction steps
- Documentation improvements
- Performance improvements
- New sync adapters (Postgres, etc.)

## What we'll push back on

- Large refactors without prior discussion
- New dependencies without strong justification
- Features that compromise the local-first architecture
- Changes that break the existing CLI interface

## Code style

- TypeScript, ESM modules
- Keep it simple — this is a CLI tool, not a framework

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
