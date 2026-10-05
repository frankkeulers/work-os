# CLAUDE.md: Work OS

Read `PLAN.md` before any task. It holds the requirements (FR-*, CL-*, NF-*) and the milestone order. Reference requirement IDs in commits and PR descriptions.

## What this is

A local, single-user app on Frank's laptop. It polls work sources (Slack first), triages each conversation with Claude, and offers one-click actions (vault note, Confluence entry) that Frank approves before code writes them.

## Stack

- Monorepo: `apps/server` (Node 22, TypeScript, Fastify), `apps/web` (React, TypeScript, Vite, Tailwind), `packages/shared` (zod schemas and types).
- No database. Runtime data lives in `~/WorkOS-data/` (`WORKOS_DATA_DIR`): event log (JSONL), JSON state, settings, logs. See PLAN.md section 4.3.

## Build order

Follow the milestones: M1 → M2 → M3 → M4. Do not start a milestone until the previous one's acceptance criteria pass. Work epic by epic, and write the tests with each epic.

## Non-negotiables

1. **Never set or use `ANTHROPIC_API_KEY`.** Claude runs on Frank's Claude subscription through the Agent SDK and the local Claude Code login. The server must refuse to start if the variable is set (CL-2).
2. **Only `apps/server/src/claude/` imports the Agent SDK** (CL-1). Every call sets its model, system prompt, tools, MCP servers, settings loading and max turns explicitly (CL-3), and logs usage (CL-5). Check the current Agent SDK docs for option names. Don't rely on memory.
3. **Triage calls use no tools, no MCP and no Claude Code preset prompt** (CL-4).
4. **Models never write to Confluence, the vault or Slack.** Models draft. Code writes after Frank approves, with allow-list and version or hash checks (FR-9.4, FR-10.5, FR-10.6).
5. **Dry-run is on by default in development** (FR-1.6). Never write to the real vault or real Confluence pages during development or tests. Use `~/WorkOS-data/sandbox/`.
6. **Secrets only in the macOS Keychain.** Never in files, logs, prompts or test fixtures.
7. **Observations about people never go to Confluence** (FR-10.1, FR-10.4). They are allowed only in the private vault.
8. **Slack access is read-only.** The app never sends messages.
9. **Server binds to 127.0.0.1 only**, with a bearer token (FR-3.3).
10. **No live model calls in tests.** Use recorded fixtures validated against the zod schemas.

## File storage rules

- The event log is the source of truth. `snapshot.json` is a rebuildable cache.
- Atomic writes: write to tmp, fsync, rename. One writer per file. Single-instance lock.
- Every persisted object carries `schemaVersion`.
- Raw message content lives only in `items/`, subject to retention. Events never contain message bodies.

## Skills and context

- `psg-context-builder` (routing mode) guides Confluence drafts. If it's not under `~/.claude/skills/`, ask Frank to export it into `.claude/skills/` in this repo, then load it for Confluence draft calls only.
- Vault conventions are in `~/WorkOS-data/config/vault-conventions.md`. Load them for vault draft calls.

## Commands (to be created in M1)

- `npm run dev`: server and web in watch mode, dry-run on.
- `npm test`: unit and contract tests.
- `npm run eval`: triage eval over `labels/triage.jsonl` (FR-6.1).
- `npm run rebuild-state`: rebuild the snapshot from the event log.

## When unsure

Ask Frank one question if the answer changes what you build. Otherwise pick the option that matches PLAN.md's design principles, state the assumption in the PR, and carry on.
