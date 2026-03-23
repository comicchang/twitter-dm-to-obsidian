# Repository Guidelines

## Project Structure & Module Organization
This repository is intentionally minimal and has no build pipeline.

- `twitter-dm-to-obsidian.user.js`: the only runtime source file (Tampermonkey userscript).
- `README.md`: installation, configuration, usage, and troubleshooting notes.
- `CLAUDE.md`: architecture and selector-level implementation notes for maintainers.

Keep new logic inside the userscript unless a split is clearly justified. Prefer extracting reusable functions over copy-paste.

## Build, Test, and Development Commands
There is no compile step. Use these commands for fast validation:

- `node --check twitter-dm-to-obsidian.user.js`: syntax check only.
- `rg "data-testid|grid-area|status/" twitter-dm-to-obsidian.user.js`: inspect selector usage quickly.
- `git diff -- twitter-dm-to-obsidian.user.js`: review behavioral changes before commit.

Runtime verification is done in browser:
1. Load script in Tampermonkey.
2. Open `https://x.com/messages/` (or `https://x.com/i/chat/`).
3. Validate both export and delete-loaded-messages flows.

## Coding Style & Naming Conventions
- Use 2-space indentation and semicolons, matching existing file style.
- Use `camelCase` for functions/variables (`resolveExtraLinks`), `UPPER_SNAKE_CASE` for constants (`URI_MAX`), and object namespaces for grouped config (`CONFIG`, `SEL`).
- Keep DOM selectors centralized in `SEL`; update there first when Twitter UI changes.
- Keep comments short and practical; document why, not obvious what.

## Testing Guidelines
Automated tests are not configured; regression is manual.

- Always run `node --check` before opening a PR.
- Test at least: tweet-card export, plain-text fallback, t.co expansion, and delete confirmation path.
- If touching URI assembly, verify large payload truncation behavior and vault/folder options.

## Commit & Pull Request Guidelines
Observed commit style is concise and action-oriented (e.g., `add ...`, `v3.8.0: ...`). Follow one of these patterns:

- `feat: ...` / `fix: ...` for normal work.
- `vX.Y.Z: ...` only for release commits.

PRs should include:
- What changed and why.
- Manual test steps and outcomes.
- Screenshots/GIFs for UI-flow changes (button injection, delete flow).
- Any selector or permission (`@grant`, `@connect`) updates called out explicitly.
