<?php

defined('DF_ENTRY') || exit(
    header('HTTP/1.1 404 Not Found')
);

$host = getenv('VERCEL_PROJECT_PRODUCTION_URL');

if (!$host) {
    $host = getenv('VERCEL_URL');
}

if (!$host) {
    $host = 'localhost:8000';
}

$siteUrl = str_starts_with($host, 'localhost')
    ? 'http://' . $host
    : 'https://' . $host;

return [

    'site_url' => $siteUrl,

    'app_key' => (string) (getenv('APP_KEY') ?: ''),

    'ip_pepper' => (string) (getenv('IP_PEPPER') ?: ''),

    /*
     * Rank provider (the only one):
     * Doctorfizz VPS worker → Playwright (headed Chrome) → Google
     */
    'rank_worker_url' => rtrim(
        (string) (getenv('RANK_WORKER_URL') ?: ''),
        '/'
    ),

    'rank_worker_secret' => (string) (
        getenv('RANK_WORKER_SECRET') ?: ''
    ),

    'admin_bootstrap' => [
        'username'  => 'admin',
        'pass_hash' => '',
    ],

    'db_path' => getenv('VERCEL')
        ? '/tmp/doctorfizz-rank-checker.sqlite'
        : null,

    'debug' => false,
];
