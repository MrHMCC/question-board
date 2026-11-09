# Class Board – Step 1 (backend)

1. Put this folder in a GitHub repo (or use `vercel` CLI from inside the folder).
2. In Vercel: Add New > Project > import the repo.
3. In the project: Storage (or Marketplace) > add **Upstash Redis** (free tier) and connect it to the project.
4. Project Settings > Environment Variables: add `TEACHER_KEY` = a password only you know.
5. Redeploy.

## Quick test (replace YOUR-SITE and YOUR-KEY)
curl -X POST https://YOUR-SITE.vercel.app/api/board \
  -H "Content-Type: application/json" -H "x-teacher-key: YOUR-KEY" \
  -d '{"action":"create","title":"Heat","prompt":"What are you wondering about heat?"}'
# -> {"code":"K7P2M"}

curl -X POST https://YOUR-SITE.vercel.app/api/board \
  -H "Content-Type: application/json" \
  -d '{"action":"post","code":"K7P2M","text":"Why does metal feel colder than wood?"}'

curl "https://YOUR-SITE.vercel.app/api/board?code=K7P2M"
