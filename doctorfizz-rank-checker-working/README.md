# DoctorFizz Rank Checker — working build (2026-10-09)

Google rank checks with **no SerpApi**: Playwright + headed Chrome on the VPS.

```
User → php-app (Vercel) → https://187-127-186-47.sslip.io (Caddy) → vps-worker :3000 → Google
```

- **Live site:** https://keyword-rank-checker-azure.vercel.app
- **Repo:** https://github.com/ParasChaturvedi/Keyword-rank-checker (push to `main` auto-deploys on Vercel)
- **Vercel project:** `paraschaturvedis-projects/keyword-rank-checker`

## Folders

| Folder | What | Runs on |
|---|---|---|
| `php-app/` | Website + PHP API, SerpApi removed (same as repo `main`) | Vercel |
| `vps-worker/` | Rank worker v5.1 (`server.js`), systemd unit, Caddyfile | VPS `/opt/doctorfizz-worker/` |

## Why Google blocked it before

1. Headless Chrome: `HeadlessChrome` user agent, `navigator.webdriver=true`, UTC timezone.
2. DataImpulse residential IPs are already flagged by Google.

## What the worker does (v5.1)

- One long-lived **headed** Chrome on Xvfb `:99`, Asia/Kolkata timezone, automation flag off.
- Searches from the **VPS's own IP**. The proxy is used only when `PROXY_FALLBACK=1`.
- Google hides result URLs behind `/goto?url=<token>`, so the domain is read from `<cite>`; only the matched result's exact URL is resolved.
- If Google challenges the profile, it **wipes the profile and retries once** as a fresh visitor. It cools down for 10 min only if the fresh profile is challenged too.
- The profile is refreshed every 100 jobs. One search runs at a time (queue max 8). Results are cached for 6 h.
- Every job finishes within 18.5 s (PHP's cURL timeout is 20 s).
- `depth` (pages, sent by PHP) and `top` (result count) are parsed separately.

## VPS setup

```bash
# Ubuntu, Node 20+, xvfb99.service on :99
cd /opt/doctorfizz-worker            # server.js, package.json, package-lock.json
npm ci && npx playwright install --with-deps chrome
cp .env.example .env                 # set WORKER_SECRET (= Vercel RANK_WORKER_SECRET)
cp doctorfizz-rank-worker.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now doctorfizz-rank-worker
# Public HTTPS endpoint (permanent URL, free Let's Encrypt cert, no Cloudflare account)
apt install caddy && cp Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
curl -s https://187-127-186-47.sslip.io/health
```

Caddy exposes only `/rank` and `/health`; everything else returns 404. `/rank` needs the bearer secret.

## Vercel env (production)

| Var | Value |
|---|---|
| `RANK_WORKER_URL` | `https://187-127-186-47.sslip.io` |
| `RANK_WORKER_SECRET` | the worker's `WORKER_SECRET` |
| `APP_KEY`, `IP_PEPPER` | random values |

## Worker API

`POST /rank` (header `Authorization: Bearer <WORKER_SECRET>`)

```json
{ "keyword": "seo agency bengaluru", "domain": "itzfizz.com", "country": "in", "language": "en", "depth": 1 }
```

`GET /health` returns the version, `browser_ready`, cooldown, `profile_resets` and the queue size.

Error codes: `google_blocked`, `google_cooldown`, `worker_busy`, `deadline_exceeded`, `serp_unreadable`, `invalid_input`, `unauthorized`.

## Tested 2026-10-09

- **Worker:** depth 1/5/10 gave 9/49/99 results (depth 10 ≈ 14 s); UK/US/Hindi; sitelinks; exact match URL; parallel requests; bad auth and empty input rejected; service restart.
- **PHP (Docker PHP 8.3):** lint on every file; health; session; check; cache; invalid input; CSRF; admin page; worker down gives a clear error with no fallback.
- **Live Vercel:** health OK; checks via `vps_playwright`; UI shows clutch.co at #3 with competitors.

`.env` (secrets) is intentionally NOT in this zip; use `.env.example`.
