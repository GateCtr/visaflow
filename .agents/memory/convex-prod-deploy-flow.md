---
name: Convex deploys straight to production, no local dev sync
description: This project's Convex backend has no local `convex dev` sync running — schema/function changes only take effect after an explicit deploy.
---

Joventy's `CONVEX_DEPLOYMENT` env var points directly at the `prod:` deployment (no separate dev deployment). Editing `convex/schema.ts` or `convex/*.ts` does NOT get pushed automatically — there is no persistent `npx convex dev` workflow watching the files.

**Why:** After adding a new optional field + two new queries, the client's `useMutation` calls to the field-extended mutation threw "Server Error" until the functions were explicitly deployed, because the live deployment still had the old validator without the new field.

**How to apply:** Deploying Joventy to production always requires TWO steps — never just one:

1. `git push` → déclenche le build Vercel (frontend statique)
2. `cd artifacts/joventy && CONVEX_DEPLOY_KEY=$(printenv CONVEX_DEPLOY_KEY) npx convex deploy --yes` → met à jour les fonctions backend

Oublier l'étape 2 laisse le backend (chat.ts, emails.ts, applications.ts, etc.) sur l'ancienne version même si le frontend est à jour.

If `CONVEX_DEPLOY_KEY` secret is missing, request it from the user (Convex dashboard → Settings → Deploy Keys).
