# Contributing

## Setup

1. Install Node.js 18+.
2. Clone the repo.
3. Run:

```bash
npm ci
npx tsc --noEmit
npm test
```

Optional live smoke test (requires Proton Bridge credentials):

```bash
node scripts/test-mcp.mjs
```

## Development Rules

- Keep this project read-only for mail operations.
- Prefer additive changes to MCP tool APIs.
- Keep tool output JSON stable and predictable for LLMs.
- Add or update tests for every behavior change.
- Avoid committing secrets.

## Pull Request Checklist

1. `npx tsc --noEmit` passes.
2. `npm test` passes.
3. README/tool docs are updated.
4. Any new env vars are documented in `.env.example` and README.
5. No credentials or local config secrets are included.
