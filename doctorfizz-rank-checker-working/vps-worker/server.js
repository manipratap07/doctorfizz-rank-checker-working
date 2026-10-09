'use strict';

/*
 * Doctorfizz rank worker v5.
 *
 * Why v5 exists (diagnosed 2026-10-09):
 *  - v1-v4 launched headless Chrome: UA "HeadlessChrome", navigator.webdriver=true,
 *    UTC timezone on an Indian IP, fresh cookie-less browser per request
 *    -> Google answered /sorry/ on the first request.
 *  - The DataImpulse residential pool is challenged by Google even with a clean
 *    browser (4/4 exits -> /sorry/), while the VPS's own IP returned real SERPs.
 *
 * So v5 runs ONE long-lived, headed Chrome (Xvfb :99) with a persistent profile,
 * IST timezone and no automation flag, searching from the VPS IP by default.
 * The residential proxy is an optional fallback (PROXY_FALLBACK=1), reached
 * through a local auth-injecting relay so no page.route() hack is needed.
 * Jobs are serialised, cached, and a Google challenge puts the direct route
 * into cooldown instead of hammering it.
 */

const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs/promises');
const net = require('net');
const path = require('path');

const WORKER_VERSION = '5.1.0';
const PARSER_VERSION = 'google-organic-v2';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const WORKER_SECRET = process.env.WORKER_SECRET || '';
const PROXY_SERVER = process.env.PROXY_SERVER || 'http://gw.dataimpulse.com:10000';
const PROXY_USER = process.env.PROXY_USER || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';
const PROXY_FALLBACK = process.env.PROXY_FALLBACK === '1';

// PHP (RankCheck.php) aborts the worker call at CURLOPT_TIMEOUT. The whole job,
// including queue wait, must finish before that or the answer is wasted.
const JOB_TIMEOUT_MS = clampInt(process.env.JOB_TIMEOUT_MS, 8000, 110000, 18500);
const NAV_TIMEOUT_MS = clampInt(process.env.NAV_TIMEOUT_MS, 3000, 20000, 9000);
const PAGE_GAP_MS = clampInt(process.env.PAGE_GAP_MS, 0, 10000, 900);
const MAX_QUEUE = clampInt(process.env.MAX_QUEUE, 0, 50, 8);
const COOLDOWN_MS = clampInt(process.env.COOLDOWN_SECONDS, 60, 7200, 600) * 1000;
// A long-lived profile eventually gets flagged by Google (observed after ~60
// searches); a fresh profile on the same IP works again. Start clean regularly.
const RECYCLE_AFTER_JOBS = clampInt(process.env.RECYCLE_AFTER_JOBS, 10, 5000, 100);
const CACHE_TTL_MS = clampInt(process.env.CACHE_TTL_SECONDS, 60, 86400, 21600) * 1000;

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, 'cache');
const PROFILE_ROOT = process.env.PROFILE_ROOT || path.join(__dirname, 'profiles');

const app = express();
app.use(express.json({ limit: '20kb' }));

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const remainingMs = deadline => Math.max(0, deadline - Date.now());
const firstLine = err => String((err && err.message) || err).split('\n')[0].slice(0, 200);

/* ------------------------------------------------------------------ input */

function normalizeDomain(value) {
  try {
    let input = String(value || '').trim().toLowerCase();
    if (!input) return null;
    if (!input.includes('://')) input = 'https://' + input;
    const host = new URL(input).hostname.replace(/^www\./, '').replace(/\.$/, '');
    return host.includes('.') ? host : null;
  } catch {
    return null;
  }
}

function domainMatches(url, domain) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return host === domain || host.endsWith('.' + domain);
  } catch {
    return false;
  }
}

// PHP sends `depth` = pages (1,2,3,5,10); other callers may send `top` =
// result count (10..100). They overlap at 10, so never mix the two.
function normalizeTop(body) {
  if (body.depth !== undefined && body.depth !== null && body.depth !== '') {
    const pages = Number(body.depth);
    return [1, 2, 3, 5, 10].includes(pages) ? pages * 10 : null;
  }
  const n = Number(body.top ?? 10);
  return [10, 20, 30, 50, 100].includes(n) ? n : null;
}

function normalizeCountry(value) {
  const raw = String(value || 'in').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(raw)) return null;
  // Google uses uk; proxy country targeting uses gb.
  return { gl: raw === 'gb' ? 'uk' : raw, proxy: raw === 'uk' ? 'gb' : raw };
}

function normalizeLanguage(value) {
  const raw = String(value || 'en').trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/.test(raw)) return null;
  const [a, b] = raw.split('-');
  return b ? `${a.toLowerCase()}-${b.toUpperCase()}` : a.toLowerCase();
}

function acceptLanguage(language, gl) {
  const base = language.split('-')[0];
  const region = gl === 'uk' ? 'GB' : gl.toUpperCase();
  const tag = language.includes('-') ? language : `${base}-${region}`;
  return base === 'en' ? `${tag},en;q=0.9` : `${tag},${base};q=0.9,en;q=0.8`;
}

function googleUrl(keyword, gl, hl, start) {
  const params = new URLSearchParams({ q: keyword, hl, gl, pws: '0' });
  if (start > 0) params.set('start', String(start));
  return `https://www.google.com/search?${params.toString()}`;
}

/* ------------------------------------------------------- proxy relay (opt) */

// Chrome + an authenticated upstream proxy hangs navigation under Playwright
// unless every request is intercepted. A local relay that injects the
// Proxy-Authorization header lets Chrome use a plain, credential-less proxy.
let relayPort = null;
let relaySticky = 10000 + crypto.randomInt(0, 10000);

function proxyUsername(country) {
  return /__cr\.[a-z]{2}/i.test(PROXY_USER)
    ? PROXY_USER.replace(/__cr\.[a-z]{2}/i, `__cr.${country}`)
    : `${PROXY_USER}__cr.${country}`;
}

function startRelay() {
  if (relayPort || !PROXY_FALLBACK || !PROXY_USER || !PROXY_PASSWORD) return;
  const upstreamHost = new URL(PROXY_SERVER).hostname;
  const server = net.createServer(client => {
    client.once('data', buf => {
      const head = buf.toString('latin1');
      const eol = head.indexOf('\r\n');
      if (eol < 0) return client.destroy();
      const auth = 'Basic ' + Buffer.from(`${proxyUsername(relayCountry)}:${PROXY_PASSWORD}`).toString('base64');
      const upstream = net.connect(relaySticky, upstreamHost, () => {
        upstream.write(Buffer.from(
          head.slice(0, eol + 2) + `Proxy-Authorization: ${auth}\r\n` + head.slice(eol + 2),
          'latin1'
        ));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
  });
  server.listen(0, '127.0.0.1', () => {
    relayPort = server.address().port;
  });
}

let relayCountry = 'in';

/* ---------------------------------------------------------------- browser */

const routes = {
  direct: { name: 'direct', ctx: null, jobs: 0, cooldownUntil: 0, lastBlock: null, profileResets: 0 },
  proxy: { name: 'proxy', ctx: null, jobs: 0, cooldownUntil: 0, lastBlock: null }
};

async function getContext(route) {
  if (route.ctx && route.jobs < RECYCLE_AFTER_JOBS) {
    try {
      route.ctx.pages();
      return route.ctx;
    } catch {}
  }
  if (route.ctx && route.jobs >= RECYCLE_AFTER_JOBS) {
    await resetProfile(route);
  }
  await closeRoute(route);

  const options = {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1365, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage'
    ],
    timeout: 15000
  };

  if (route.name === 'proxy') {
    if (!relayPort) throw Object.assign(new Error('Proxy relay not ready.'), { code: 'proxy_not_configured' });
    options.proxy = { server: `http://127.0.0.1:${relayPort}` };
  }

  const dir = path.join(PROFILE_ROOT, route.name);
  await fs.mkdir(dir, { recursive: true });
  // Chrome refuses a profile whose previous owner crashed without cleanup.
  await fs.rm(path.join(dir, 'SingletonLock'), { force: true }).catch(() => {});

  route.ctx = await chromium.launchPersistentContext(dir, options);
  route.jobs = 0;
  route.ctx.on('close', () => { route.ctx = null; });
  return route.ctx;
}

async function closeRoute(route) {
  const ctx = route.ctx;
  route.ctx = null;
  if (ctx) await ctx.close().catch(() => {});
}

// Close the browser and delete its profile (cookies, storage) so the next
// launch is a brand-new Google visitor.
async function resetProfile(route) {
  await closeRoute(route);
  await fs.rm(path.join(PROFILE_ROOT, route.name), { recursive: true, force: true }).catch(() => {});
  route.jobs = 0;
  route.profileResets = (route.profileResets || 0) + 1;
}

async function rotateProxySession() {
  relaySticky = 10000 + crypto.randomInt(0, 10000);
  await closeRoute(routes.proxy);
}

/* ------------------------------------------------------------------ parse */

async function snapshotPage(page) {
  return page.evaluate(() => {
    const finalUrl = location.href;
    const bodyText = (document.body?.innerText || '').toLowerCase();

    const challenge =
      finalUrl.includes('/sorry/') ||
      bodyText.includes('unusual traffic') ||
      bodyText.includes('our systems have detected') ||
      Boolean(document.querySelector('iframe[src*="recaptcha"], form[action*="/sorry/"]'));

    const consent =
      finalUrl.includes('consent.google.') ||
      bodyText.includes('before you continue to google');

    const noResults =
      bodyText.includes('did not match any documents') ||
      bodyText.includes('no results found for');

    const rows = [];
    const seen = new Set();

    for (const h3 of document.querySelectorAll('#rso h3, #search h3')) {
      if (h3.closest('#tads, #tadsb, [data-text-ad], [aria-label="Ads"], [aria-label="Sponsored"]')) continue;
      const anchor = h3.closest('a');
      if (!anchor) continue;

      const title = (h3.innerText || h3.textContent || '').trim();
      let href = anchor.href || '';
      if (!title || !href) continue;

      let goto = null;
      try {
        const u = new URL(href, location.href);
        const isGoogle = /^(www\.)?google\./i.test(u.hostname);
        if (isGoogle && (u.pathname === '/url' || u.pathname === '/goto')) {
          const target = u.searchParams.get('q') || u.searchParams.get('url') || '';
          if (/^https?:\/\//i.test(target)) {
            href = target;
          } else {
            // Since 2026 Google hides the destination behind an opaque
            // /goto?url=<token> redirect. The result's <cite> shows the real
            // site ("https://example.com › blog › post"), which is enough to
            // match the domain; the exact URL is resolved later only if needed.
            goto = u.href;
            let box = anchor;
            for (let i = 0; i < 8 && box && !box.querySelector('cite'); i += 1) box = box.parentElement;
            const cite = (box?.querySelector('cite')?.innerText || '').trim();
            const parts = cite.split('›').map(s => s.trim()).filter(Boolean);
            if (!parts.length || parts[0].includes(' ')) {
              href = '';
            } else {
              const origin = /^https?:\/\//i.test(parts[0]) ? parts[0] : `https://${parts[0]}`;
              const tail = parts.slice(1).filter(p => !p.includes('...') && !p.includes('…'));
              href = origin.replace(/\/$/, '') + (tail.length ? '/' + tail.join('/') : '/');
            }
          }
        }
        if (href) {
          const t = new URL(href, location.href);
          const host = t.hostname.toLowerCase();
          if (host === 'google.com' || host.endsWith('.google.com') || host.startsWith('www.google.')) continue;
          href = t.href;
        }
      } catch {
        continue;
      }
      if (!href && !goto) continue;

      const key = `${title}\n${href || goto}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ title, url: href, goto });
    }

    return { finalUrl, challenge, consent, noResults, rows };
  });
}

/* ------------------------------------------------------------------- scan */

function failure(code, error, extra = {}) {
  return {
    ok: false,
    code,
    error,
    provider: 'vps_playwright',
    source: 'google.com',
    fallback_allowed: false,
    ...extra
  };
}

async function scanOnRoute(route, input, deadline) {
  if (route.name === 'proxy') relayCountry = input.country.proxy;

  let ctx;
  try {
    ctx = await getContext(route);
  } catch (err) {
    return failure(err.code || 'browser_launch_failed', 'Chrome could not start.', {
      retryable: route.name === 'direct',
      detail: firstLine(err)
    });
  }
  route.jobs += 1;

  const page = await ctx.newPage();
  page.setDefaultTimeout(3000);
  await page.setExtraHTTPHeaders({
    'Accept-Language': acceptLanguage(input.language, input.country.gl)
  });

  const collected = [];
  const fingerprints = new Set();
  const pageEvidence = [];

  try {
    for (let start = 0; start < input.top; start += 10) {
      if (start > 0 && PAGE_GAP_MS) await sleep(PAGE_GAP_MS + crypto.randomInt(0, 400));

      const navTimeout = Math.min(NAV_TIMEOUT_MS, remainingMs(deadline) - 300);
      if (navTimeout < 1500) {
        return failure('deadline_exceeded', 'The Google scan exceeded its safe time limit.', {
          retryable: false,
          scanned: collected.length
        });
      }

      let response;
      try {
        response = await page.goto(googleUrl(input.keyword, input.country.gl, input.language, start), {
          waitUntil: 'domcontentloaded',
          timeout: navTimeout
        });
      } catch (err) {
        return failure('navigation_failed', 'Google Search did not finish loading.', {
          retryable: true,
          detail: firstLine(err),
          scanned: collected.length
        });
      }

      let status = response ? response.status() : null;
      page.on('response', r => {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) status = r.status();
      });

      // Google may first serve a JS interstitial that redirects to the real
      // SERP, so poll across navigations until results, a challenge or an
      // explicit "no results" page is on screen.
      const settleBy = Math.min(deadline - 300, Date.now() + 8000);
      let snap = null;
      let lastErr = null;
      while (Date.now() < settleBy) {
        try {
          const s = await snapshotPage(page);
          if (s.rows.length || s.challenge || s.consent || s.noResults) {
            snap = s;
            break;
          }
          snap = s;
        } catch (err) {
          lastErr = err; // context destroyed by the interstitial's redirect
        }
        await sleep(250);
      }
      page.removeAllListeners('response');

      if (!snap) {
        return failure('serp_unreadable', 'Google loaded, but the result page could not be read.', {
          retryable: true,
          detail: lastErr ? firstLine(lastErr) : 'no snapshot',
          scanned: collected.length
        });
      }

      if (status === 403 || status === 429 || snap.challenge) {
        return failure('google_blocked', 'Google challenged this browser session.', {
          retryable: true,
          blocked: true,
          http_status: status,
          scanned: collected.length
        });
      }

      if (snap.consent) {
        return failure('google_consent', 'Google returned a consent page instead of results.', {
          retryable: true,
          http_status: status
        });
      }

      if (status !== null && (status < 200 || status >= 400)) {
        return failure('google_http_error', `Google Search returned HTTP ${status}.`, {
          retryable: true,
          http_status: status
        });
      }

      if (!snap.rows.length) {
        // A genuine empty/last page after at least one verified page means
        // the result set simply ended.
        if (collected.length && (snap.noResults || start > 0)) break;
        return failure('serp_unreadable', 'Google returned a page without organic result blocks.', {
          retryable: true,
          http_status: status,
          final_url: snap.finalUrl.slice(0, 120),
          scanned: collected.length
        });
      }

      const fingerprint = crypto
        .createHash('sha256')
        .update(snap.rows.map(x => `${x.title}|${x.url}`).join('\n'))
        .digest('hex');

      // Google repeating the previous page means the result set ended.
      if (fingerprints.has(fingerprint)) break;
      fingerprints.add(fingerprint);

      pageEvidence.push({
        start,
        http_status: status,
        organic_results: snap.rows.length,
        fingerprint: fingerprint.slice(0, 12)
      });

      let unresolvedBudget = 3;
      for (let i = 0; i < snap.rows.length; i += 1) {
        const item = snap.rows[i];
        const rank = collected.length + 1;
        if (rank > input.top) break;

        // No <cite> to read the site from: follow Google's redirect once.
        if (!item.url && item.goto && unresolvedBudget > 0) {
          unresolvedBudget -= 1;
          item.url = (await resolveGoto(ctx, page, item.goto, deadline)) || '';
        }
        // Keep the slot so later ranks do not shift; link falls back to Google's redirect.
        if (!item.url) item.url = item.goto;

        const match = domainMatches(item.url, input.domain);
        if (match && item.goto) {
          item.url = (await resolveGoto(ctx, page, item.goto, deadline)) || item.url;
        }
        collected.push({ rank, title: item.title, link: item.url, match });

        if (match) return success(input, collected, route, pageEvidence, rank, item.url);
      }

      if (collected.length >= input.top) break;
    }

    return success(input, collected, route, pageEvidence, null, null);
  } finally {
    await page.close().catch(() => {});
  }
}

// Read the Location of Google's /goto redirect without leaving the SERP.
// Runs inside the browser context so it carries the same cookies and UA.
async function resolveGoto(ctx, page, gotoUrl, deadline) {
  const timeout = Math.min(3000, remainingMs(deadline) - 500);
  if (timeout < 800) return null;
  try {
    const ua = await page.evaluate(() => navigator.userAgent);
    const res = await ctx.request.get(gotoUrl, {
      maxRedirects: 0,
      timeout,
      headers: { 'User-Agent': ua, Referer: page.url() }
    });
    const loc = res.headers()['location'] || '';
    return /^https?:\/\//i.test(loc) ? loc : null;
  } catch {
    return null;
  }
}

function success(input, collected, route, pageEvidence, position, url) {
  return {
    ok: true,
    found: position !== null,
    position,
    ranking_url: url,
    scanned: collected.length,
    results: collected,
    provider: 'vps_playwright',
    route: route.name,
    source: 'google.com',
    country: input.country.gl,
    language: input.language,
    requested_top: input.top,
    pages_verified: pageEvidence.length,
    page_evidence: pageEvidence,
    ranking_definition: 'observed_google_organic_results',
    parser_version: PARSER_VERSION,
    checked_at: Math.floor(Date.now() / 1000),
    captured_at: nowIso(),
    cached: false
  };
}

async function runScan(input, deadline) {
  const order = [routes.direct];
  if (PROXY_FALLBACK && relayPort) order.push(routes.proxy);

  let last = null;

  for (const route of order) {
    if (route.cooldownUntil > Date.now()) {
      last = failure('google_cooldown', 'Google recently challenged this route; it is cooling down.', {
        retry_after_seconds: Math.ceil((route.cooldownUntil - Date.now()) / 1000)
      });
      continue;
    }
    if (remainingMs(deadline) < 4000) break;

    let result = await scanOnRoute(route, input, deadline);

    // One clean retry on the same route for transient (non-block) failures.
    if (!result.ok && result.retryable && !result.blocked && remainingMs(deadline) > 6000) {
      await closeRoute(route);
      result = await scanOnRoute(route, input, deadline);
    }

    // Google flagged this browser profile: retry once as a fresh visitor.
    // Only if the fresh profile is challenged too is the IP itself cooling down.
    if (!result.ok && result.blocked && route.name === 'direct' && remainingMs(deadline) > 5000) {
      route.lastBlock = nowIso();
      console.error(nowIso(), 'direct profile challenged; resetting profile and retrying');
      await resetProfile(route);
      result = await scanOnRoute(route, input, deadline);
    }

    if (result.ok) {
      route.lastBlock = null;
      return result;
    }

    if (result.blocked) {
      route.lastBlock = nowIso();
      if (route.name === 'direct') {
        await resetProfile(route);
        route.cooldownUntil = Date.now() + COOLDOWN_MS;
        console.error(nowIso(), 'direct route challenged; cooling down', COOLDOWN_MS / 1000, 's');
      } else {
        await rotateProxySession();
      }
    }

    last = { ...result, route: route.name };
  }

  return last || failure('deadline_exceeded', 'The rank check could not be completed in time.');
}

/* ------------------------------------------------------------ queue/cache */

let busy = false;
const queue = [];

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    const job = () => {
      busy = true;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          busy = false;
          const next = queue.shift();
          if (next) next();
        });
    };
    if (!busy) return job();
    if (queue.length >= MAX_QUEUE) {
      const err = new Error('queue full');
      err.code = 'worker_busy';
      return reject(err);
    }
    queue.push(job);
  });
}

function scanKey(input) {
  return crypto
    .createHash('sha256')
    .update([PARSER_VERSION, input.keyword.toLowerCase(), input.domain, input.country.gl, input.language, input.top].join('|'))
    .digest('hex');
}

async function readCache(key) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(CACHE_DIR, `${key}.json`), 'utf8'));
    if (!parsed || parsed.ok !== true || Date.now() - Number(parsed.cached_at_ms) > CACHE_TTL_MS) return null;
    return { ...parsed, cached: true };
  } catch {
    return null;
  }
}

async function writeCache(key, payload) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const file = path.join(CACHE_DIR, `${key}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ ...payload, cached: false, cached_at_ms: Date.now() }), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    console.error(nowIso(), 'cache_write_failed', err.message);
  }
}

/* ------------------------------------------------------------------- http */

function auth(req, res, next) {
  if (!WORKER_SECRET) {
    return res.status(503).json({ ok: false, code: 'worker_not_configured', error: 'Worker secret is not configured.' });
  }
  if (req.headers.authorization !== `Bearer ${WORKER_SECRET}`) {
    return res.status(401).json({ ok: false, code: 'unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  const d = routes.direct;
  res.json({
    ok: Boolean(WORKER_SECRET),
    service: 'doctorfizz-rank-checker-worker',
    version: WORKER_VERSION,
    parser_version: PARSER_VERSION,
    provider: 'vps_playwright',
    serp_api: false,
    secret_configured: Boolean(WORKER_SECRET),
    browser_ready: Boolean(d.ctx),
    direct_cooldown_seconds: Math.max(0, Math.ceil((d.cooldownUntil - Date.now()) / 1000)),
    direct_last_block: d.lastBlock,
    profile_resets: d.profileResets,
    proxy_fallback: Boolean(PROXY_FALLBACK && relayPort),
    busy,
    queued: queue.length,
    job_timeout_ms: JOB_TIMEOUT_MS,
    cache_ttl_seconds: Math.floor(CACHE_TTL_MS / 1000)
  });
});

const inflight = new Map();

app.post('/rank', auth, async (req, res) => {
  const deadline = Date.now() + JOB_TIMEOUT_MS;

  const keyword = String(req.body.keyword || '').trim();
  const domain = normalizeDomain(req.body.domain);
  const country = normalizeCountry(req.body.country || req.body.gl || 'in');
  const language = normalizeLanguage(req.body.language || req.body.hl || 'en');
  const top = normalizeTop(req.body);

  if (!keyword || keyword.length > 120 || !domain || !country || !language || !top) {
    return res.status(400).json({
      ok: false,
      code: 'invalid_input',
      error: 'Valid keyword, domain, country, language and search depth are required.',
      fallback_allowed: false
    });
  }

  const input = { keyword, domain, country, language, top };
  const key = scanKey(input);

  const cached = await readCache(key);
  if (cached) return res.json(cached);

  let promise = inflight.get(key);
  if (!promise) {
    promise = enqueue(() => {
      if (remainingMs(deadline) < 4000) {
        return failure('worker_busy', 'The rank worker is busy. Please retry shortly.');
      }
      return runScan(input, deadline);
    });
    inflight.set(key, promise);
    promise.finally(() => inflight.delete(key)).catch(() => {});
  }

  try {
    const result = await promise;
    if (!result.ok) return res.status(503).json(result);
    await writeCache(key, result);
    return res.json(result);
  } catch (err) {
    if (err.code === 'worker_busy') {
      return res.status(503).json(failure('worker_busy', 'The rank worker is busy. Please retry shortly.'));
    }
    console.error(nowIso(), 'worker_error', firstLine(err));
    return res.status(503).json(failure('worker_error', 'Rank worker temporarily unavailable.'));
  }
});

async function shutdown() {
  await Promise.all(Object.values(routes).map(closeRoute));
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startRelay();

app.listen(PORT, HOST, () => {
  console.log(`${nowIso()} Doctorfizz worker ${WORKER_VERSION} listening on ${HOST}:${PORT}`);
  // Warm the browser so the first user request does not pay the launch cost.
  getContext(routes.direct).catch(err => console.error(nowIso(), 'warmup_failed', firstLine(err)));
});
