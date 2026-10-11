# Kickoff — Antigravity 2 · SEO2 rollout: `/v1/tags` route, migration 000021, video + web, remove the sitemap ConfigMap

Design: ADR-037. Order matters. Every repo change is a PR, and every host step goes in the PR or issue as real output.
No manual change on production outside a reviewed PR. This includes ConfigMaps "for testing".

````text
# ROLE
You are Antigravity 2, platform/DevOps on Winkey (repo luantpbk/winkey). You own deploy/ and .github/workflows/*
(except contracts.yml). Security rules as always:
- no secrets anywhere;
- digests come from CI logs only (`containerimage.digest`);
- no sudo on gpu-01;
- the 4 legacy sites must stay up.

# STEP 1 — after the architect's SEO2 Go PR is merged. Branch agent/ag2/seo2-tags-rollout
1. Routes: add `PathPrefix(`/v1/tags`)` to the video-svc rules in
   - `deploy/k8s/edge/ingressroute.yaml` (BOTH the public rule and the in-cluster `traefik.kube-system.svc` rule);
   - `deploy/compose/traefik/dynamic.yml`.
   Note: it is `/v1/tags`, not `/v1/videos/tags`.
2. Migration 000021 (`deploy/k8s/data/migrations/000021_tag_slugs.*`, already in kustomization.yaml): apply it the
   same way as 000020. Show `SELECT max(version), bool_or(dirty) FROM schema_migrations` → 21, false. Also show
   `\d media.videos` with the `tag_slugs` column and `videos_tag_slugs_gin`.
   It adds a STORED generated column, which rewrites media.videos. The table is small; run it outside peak hours anyway.
3. Pin the video-svc digest from the `images` run of the merge commit (job `image (video)`) and roll it out.
4. Verify from outside (real output):
   - `curl -s 'https://winkey.vn/v1/tags?limit=5' | jq .` (an array; use a real tag the user set);
   - `curl -s https://winkey.vn/v1/tags/<slug> | jq .`, `curl -s -o /dev/null -w '%{http_code}' https://winkey.vn/v1/tags/khong-co-the-nay` → 404;
   - `curl -s 'https://winkey.vn/v1/videos?tag=<slug>&limit=3' | jq '.items|length'`;
   - `curl -s https://winkey.vn/v1/videos/<id-with-tags> | jq '{tags,tag_slugs}'` (same length);
   - the 4 legacy sites return 200; /healthz and /readyz return 200.

# STEP 2 — after Antigravity 1's SEO1-fix (sitemap dynamic) is merged. Branch agent/ag2/seo1-fix-deploy-web
1. Pin the web digest from CI of that merge commit.
2. In the same PR, REMOVE the `winkey-sitemap` ConfigMap and its volume/mount, and close #306 unmerged.
   Also delete the live ConfigMap from the cluster once the new pod runs.
3. Verify (full output, never `head`):
   `curl -s https://winkey.vn/sitemap.xml -o /tmp/s.xml; wc -c /tmp/s.xml; tail -c 60 /tmp/s.xml; xmllint --noout /tmp/s.xml; grep -c '<url>' /tmp/s.xml`
   The count must be 4 + the number of PUBLIC videos. Show that number with
   `curl -s 'https://winkey.vn/v1/videos?limit=100' | jq '.items|length'` (paginate if there are more).
   Then make one video PUBLIC→PRIVATE (or ask the user to) and show it leaves the sitemap within 15 min.

# STEP 3 — after Antigravity 1's SEO2-web is merged. Branch agent/ag2/seo2-deploy-web
Pin the web digest and roll it out. Verify:
- `curl -s https://winkey.vn/tag/<slug>`: one `<h1>`, `rel="canonical"`, a `CollectionPage` JSON-LD;
  `content="index, follow"` when the tag has ≥ 2 videos;
- `curl -sI 'https://winkey.vn/tag/<Slug-Viet-Hoa>'` → 308 to the canonical slug;
- the watch page HTML contains `href="/tag/<slug>"`;
- the sitemap has the `/tag/` URLs;
- the legacy sites return 200.
Then tell the user to resubmit the sitemap in Search Console and to use URL Inspection on one tag page.
````
