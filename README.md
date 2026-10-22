# Dear Zeneb Lite

A private one-person chat with an AI friend, built to run on Vercel.

- The **browser** keeps the conversation and a hidden knowledge graph (`graph.json`) that grows
  after every message and feeds the next reply.
- **Vercel functions** (`api/`) hold everything secret: the OpenAI key, the persona prompt, the
  starting facts about her, the password check, and your admin access to a backup copy.
- No emails, no always-on agent, no overnight job (it catches up when she opens the app).

## Run it locally

```bash
npm install
cp .env.example .env.local     # fill in OPENAI_API_KEY, SECRET_KEY, ACCESS_PASSWORD, ADMIN_KEY
npm run dev:api                # functions on http://localhost:3001
npm run dev                    # site on http://localhost:3000 (in a second terminal)
```

Backup storage is optional locally. Without it the app works, it just has no backup copy.

Tests: `npm test`. Type check: `npm run typecheck`.

## Deploy on Vercel

1. Push this folder to a **private** GitHub repository (your `.env*` files are git-ignored).
2. In Vercel: Add New, Project, import the repository. Framework preset: Vite (it reads `vercel.json`).
3. Project Settings, Environment Variables, add:

| Name | Value |
|------|-------|
| `OPENAI_API_KEY` | your OpenAI key |
| `SECRET_KEY` | a long random string (16+ characters) |
| `ACCESS_PASSWORD` | the one password that lets her in (12+ characters) |
| `ADMIN_KEY` | your own secret (16+ characters). Only you hold it. |

4. Starting facts about her (optional, you provide them): set `SEED_OPS_JSON` to a JSON array of graph
   operations (see `api/_lib/seed.ts` for the shape). Locally you can use the private file
   `api/_data/seed.json` instead. On Vercel only the variable works, because that file is git-ignored and
   never uploaded. With no seed, the graph starts empty and fills up as she talks.
5. Storage: in the Vercel project, Storage (or Marketplace), add **Upstash Redis**. It adds the
   `KV_REST_API_URL` and `KV_REST_API_TOKEN` variables for you. Redeploy afterwards.
6. Open the site and log in with the password.

Function limit: `vercel.json` asks for 30 seconds per function. Check what your Vercel plan allows.

## Getting graph.json

Everything the app has learned is backed up (after every change, a couple of seconds later).
Read it with your admin key. Her login cannot open this address.

```bash
curl -H "X-Admin-Key: YOUR_ADMIN_KEY" "https://YOUR-SITE.vercel.app/api/admin?what=graph&download=1" -o graph.json
curl -H "X-Admin-Key: YOUR_ADMIN_KEY" "https://YOUR-SITE.vercel.app/api/admin?what=state" -o state.json
```

`what=graph` is the knowledge graph, `what=state` is the whole backup (graph, recent messages,
day notes, the friend's name).

## What to know

- Her data lives in her browser. If she clears it or opens the site on a new device, the app
  restores everything from the backup copy.
- Her messages and graph pass through the Vercel functions on every AI call, and a copy is kept in
  the Upstash database. That database is your responsibility.
- The website's code is public. Nothing personal is in it; the persona and starting facts exist
  only inside `api/`.
