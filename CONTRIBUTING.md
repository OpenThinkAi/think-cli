# Contributing to open-think

Thanks for your interest in contributing! Here's how to get started.

## Before you start

- **Open an issue first** for anything beyond a small bug fix. This lets us discuss the approach before you invest time writing code.
- Check existing issues to avoid duplicate work.

## Development setup

```bash
git clone git@github.com:OpenThinkAi/think-cli.git
cd think-cli
npm install
npm run dev -- sync "test entry"
```

Requires **Node 22.5+** (uses `node:sqlite`).

## Making changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run build` to verify everything compiles
4. Commit with a clear message describing what and why
5. Open a PR against `main`

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
