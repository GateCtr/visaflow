---
name: Convex deploys straight to production, no local dev sync
description: This project's Convex backend has no local `convex dev` sync running — schema/function changes only take effect after an explicit deploy.
---

Joventy's `CONVEX_DEPLOYMENT` env var points directly at the `prod:` deployment (no separate dev deployment). Editing `convex/schema.ts` or `convex/*.ts` does NOT get pushed automatically — there is no persistent `npx convex dev` workflow watching the files.

**Why:** After adding a new optional field + two new queries, the client's `useMutation` calls to the field-extended mutation threw "Server Error" until the functions were explicitly deployed, because the live deployment still had the old validator without the new field.

**How to apply:** After changing any `convex/schema.ts` or `convex/*.ts` file, run:
```
CONVEX_DEPLOY_KEY=$CONVEX_DEPLOY_KEY npx convex deploy --yes
```
If `CONVEX_DEPLOY_KEY` secret is missing, request it from the user (Convex dashboard → Settings → Deploy Keys). Verify via `refresh_all_logs` / browser console that the previous "Server Error" for the affected mutation/query is gone after redeploying.
