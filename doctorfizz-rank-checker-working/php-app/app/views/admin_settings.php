<?php
defined('DF_ENTRY') || exit(header('HTTP/1.1 404 Not Found'));
/** @var string $csrf */
/** @var array|null $flash */

$pageTitle = 'Settings';
$current   = 'settings';
ob_start();
?>
<h1 class="a-title">Settings</h1>
<p class="a-sub">Limits and maintenance. Searches run on the Doctorfizz VPS rank worker.</p>

<?php if ($flash !== null): ?><p class="flash <?= e($flash[0]) ?>"><?= e($flash[1]) ?></p><?php endif; ?>

<form method="post" action="<?= e(admin_url('settings')) ?>">
  <input type="hidden" name="csrf" value="<?= e($csrf) ?>">

  <div class="box">
    <h2>Limits</h2>
    <p class="hint">The daily visitor limit and burst guard protect the rank worker from abuse.</p>
    <div class="f-row">
      <label class="f">
        <span>Checks per visitor per day</span>
        <input type="number" name="daily_limit" min="1" max="50" value="<?= (int) App::settingInt('daily_limit') ?>">
        <small>Cached repeats do not count.</small>
      </label>
      <label class="f">
        <span>Requests per minute per visitor</span>
        <input type="number" name="burst_per_minute" min="1" max="60" value="<?= (int) App::settingInt('burst_per_minute') ?>">
        <small>Burst guard against scripted loops.</small>
      </label>
      <label class="f">
        <span>Cache lifetime, hours</span>
        <input type="number" name="cache_ttl_hours" min="1" max="168" value="<?= (int) App::settingInt('cache_ttl_hours') ?>">
        <small>Identical checks inside this window use the local cache.</small>
      </label>
      <label class="f">
        <span>Maximum scan depth, pages</span>
        <input type="number" name="max_depth" min="1" max="5" value="<?= (int) App::settingInt('max_depth') ?>">
        <small>Each page is one Google results page fetched by the worker.</small>
      </label>
      <label class="f">
        <span>Keep check history, days</span>
        <input type="number" name="retention_days" min="7" max="730" value="<?= (int) App::settingInt('retention_days') ?>">
        <small>Older rows are pruned automatically.</small>
      </label>
    </div>
  </div>

  <div class="box">
    <h2>Availability</h2>
    <div class="f-check">
      <input type="checkbox" id="maintenance" name="maintenance" value="1"<?= App::setting('maintenance') === '1' ? ' checked' : '' ?>>
      <label for="maintenance">Maintenance mode. The page stays indexable but ranking checks are refused.</label>
    </div>
    <label class="f">
      <span>Maintenance message</span>
      <input type="text" name="maintenance_note" maxlength="300" value="<?= e(App::setting('maintenance_note')) ?>">
    </label>
    <div class="f-check">
      <input type="checkbox" id="trust_proxy" name="trust_proxy" value="1"<?= App::setting('trust_proxy', '0') === '1' ? ' checked' : '' ?>>
      <label for="trust_proxy">Trust X-Forwarded-For only when the site is behind a trusted proxy such as Cloudflare.</label>
    </div>
  </div>

  <div class="sticky-save">
    <button type="submit" class="btn">Save settings</button>
  </div>
</form>
<?php
$bodyHtml = ob_get_clean();
require __DIR__ . '/admin_layout.php';
