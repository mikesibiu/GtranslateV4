# Project Instructions for Claude Code

## Git Workflow

**IMPORTANT:** Always use the `git-ops-manager` agent for ALL git operations:
- Creating commits
- Pushing to GitHub (origin/main) — Koyeb auto-deploys from `main`
- Branch management
- Merge conflict resolution

**Do NOT use:**
- Direct `Bash` tool with git commands
- Manual commit/push operations

**Correct workflow:**
1. Make code changes (Edit/Write tools)
2. Use `Task` tool with `subagent_type: "git-ops-manager"` to commit and deploy
3. Let agent handle all git operations

## Deployment Targets

This project deploys to:
- **GitHub:** https://github.com/mikesibiu/GtranslateV4 (push to `main`)
- **Koyeb:** service `gtranslate` (app `gtranslate`) — **auto-deploys from GitHub `main`**.
  Live URL: https://gtranslate-mysysadmin-aa6fe3a2.koyeb.app

Heroku is fully decommissioned — do not push to or reference it.
Push to `origin` `main` only; Koyeb builds automatically.

## Code Review Workflow

Before deploying:
1. Run appropriate QA agent (app-code-reviewer, python-code-reviewer, etc.)
2. Fix any critical issues found
3. Then deploy via git-ops-manager

## Project Structure

- `index.html` - Client-side app (single-page application)
- `server.js` - Node.js server with WebSocket and Google Cloud APIs
- `audio-processor.js` - AudioWorklet processor for microphone input
- `.gitignore` - Excludes credentials and node_modules
- `google-credentials.json` - **NEVER commit** (in .gitignore)
