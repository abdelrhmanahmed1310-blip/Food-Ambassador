<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Food Ambassador project rules

Read ARCHITECTURE.md, DATA_MODEL.md and DECISIONS.md before changing behaviour.

- Business logic lives in `src/modules/<domain>`; routes and UI stay thin.
- Every tenant-owned query takes a TenantContext and filters by `organizationId`;
  never trust a client-supplied organization ID.
- Quantities, costs and money use `src/lib/decimal.ts` and `NUMERIC` columns — never JS floats.
- Inventory changes only through ledger postings in the inventory module; no direct balance edits.
- Run `pnpm check`, `pnpm test:integration` and `pnpm test:e2e` before declaring work done,
  and update IMPLEMENTATION_STATUS.md.
