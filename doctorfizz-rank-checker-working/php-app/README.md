# DoctorFizz Keyword Rank Checker

Free Google keyword rank checker. No third-party SERP API.

```
Browser UI → PHP API (Vercel) → Doctorfizz VPS rank worker → Playwright (headed Chrome) → Google
```

- The PHP API validates input, applies per-visitor limits and caches results.
- The VPS worker (separate repo/folder, `vps-worker/` in the build zip) runs one long-lived
  headed Chrome on the VPS's own IP, reads Google's organic results and returns the position.
- If the worker fails, the API returns an error. There is no paid fallback.

## Environment (Vercel)

| Variable | Value |
|---|---|
| `RANK_WORKER_URL` | `https://187-127-186-47.sslip.io` |
| `RANK_WORKER_SECRET` | same as `WORKER_SECRET` on the VPS |
| `APP_KEY` | base64 of 32 random bytes |
| `IP_PEPPER` | long random string |

Health check: `/api/index.php?a=health`
