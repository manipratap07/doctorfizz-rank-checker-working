# DoctorFizz Rank Checker — install

## Vercel

1. Import this repo in Vercel (framework preset: Other). `vercel.json` runs `api/*.php` on `vercel-php`.
2. Set the environment variables listed in `README.md`.
3. Deploy, then open `/api/index.php?a=health` — every check should be `true`
   (`page_writable` is informational and is `false` on Vercel).

## Shared hosting (optional)

Upload the folder, keep `app/.htaccess` in place, set the same values in `app/config.php`
(see `app/config.example.php`). Requires PHP 8.1+, cURL, PDO SQLite, OpenSSL and a writable `app/data/`.

## How a check works

`POST /api/index.php?a=check` → `RankCheck::run()` → `POST {RANK_WORKER_URL}/rank`
with `Authorization: Bearer {RANK_WORKER_SECRET}`. The worker answers within ~18.5 s
(the PHP call times out at 20 s). Failed checks never show as "not ranking" and do not
use the visitor's daily allowance.
