/**
 * ============================================================================
 *  QuoteSmith — Remote-Controlled Google Ads Script
 * ============================================================================
 *
 *  WHAT THIS DOES
 *  --------------
 *  Every time it runs, this script downloads a small JSON "config" file from a
 *  fixed GitHub URL and then makes ONE Google Ads campaign match that config:
 *    - Turns the campaign ON or OFF        (status)
 *    - Sets the daily budget               (dailyBudget, in GBP)
 *    - Ensures a list of keywords exist    (keywords)
 *    - Ensures negative keywords exist     (negativeKeywords)
 *    - Sets the ad group max CPC bid        (maxCpc, only on Manual CPC)
 *  Then it emails a short summary report.
 *
 *  HOW THE OWNER USES IT (paste once, then forget)
 *  -----------------------------------------------
 *    1. Google Ads  ->  Tools  ->  Bulk actions  ->  Scripts  ->  "+"
 *    2. Paste this whole file in, click Authorize, then Save.
 *    3. Schedule it to run HOURLY.
 *  After that, you NEVER touch Google Ads again. To change anything (go live,
 *  pause, change budget, add keywords) you only edit the JSON config file at:
 *
 *      CONFIG_URL (below)
 *
 *  GO-LIVE / SAFETY
 *  ----------------
 *  The campaign only spends money when the config says  "status": "ENABLED".
 *  The shipped default config says  "status": "PAUSED"  — so until you
 *  deliberately flip it to ENABLED, this script will keep the campaign paused
 *  and will NOT spend a penny.
 *
 *  This script is FAIL-SAFE and IDEMPOTENT:
 *    - If the config can't be fetched or is invalid, it changes NOTHING and
 *      emails an alert.
 *    - If the campaign can't be found, it changes NOTHING and emails an alert.
 *    - Running it ten times in a row produces the same result as running once
 *      (no duplicate keywords, no needless budget writes).
 *    - Any unexpected error is caught, logged, and emailed — it never throws.
 *
 *  Uses only Google Ads Scripts built-ins: AdsApp, UrlFetchApp, MailApp, Logger.
 * ============================================================================
 */

// The single source of truth. Edit the file at this URL to control the campaign.
var CONFIG_URL = 'https://raw.githubusercontent.com/johnhitchenswork-cmyk/qs-ads-control/main/config.json';

// Where run reports and alerts are sent.
var ALERT_EMAIL = 'johnhitchenswork@gmail.com';

// Sensible fallbacks if the config omits an optional field.
var DEFAULT_AD_GROUP_NAME = 'QuoteSmith Trades';
var DEFAULT_MAX_CPC = 0.40;

function main() {
  try {
    run();
  } catch (e) {
    // Absolute last line of defence — nothing should ever throw past here.
    var msg = 'QuoteSmith Ads control FATAL error: ' + (e && e.message ? e.message : e) +
        (e && e.stack ? ('\n\n' + e.stack) : '');
    Logger.log(msg);
    safeEmail('QuoteSmith Ads control — FATAL error', msg);
  }
}

/**
 * Core logic. May throw; main() catches everything.
 */
function run() {
  var today = formatDate(new Date());
  Logger.log('=== QuoteSmith Ads control run @ ' + today + ' ===');

  // ----- 1) Fetch + parse config (fail safe) -------------------------------
  var config = fetchConfig();
  if (!config) {
    // fetchConfig already logged + emailed the reason. Exit without changes.
    Logger.log('No valid config — exiting without any changes.');
    return;
  }

  if (!config.campaignName) {
    var noName = 'Config is missing required "campaignName". No changes made.';
    Logger.log(noName);
    safeEmail('QuoteSmith Ads control — config error', noName);
    return;
  }

  // ----- 2) Find the campaign (fail safe) ----------------------------------
  var campaign = findCampaign(config.campaignName);
  if (!campaign) {
    var notFound = 'Campaign not found: "' + config.campaignName + '". No changes made.\n\n' +
        'Check that the campaign exists and the name in the config matches it exactly.';
    Logger.log(notFound);
    safeEmail('QuoteSmith Ads control — campaign not found', notFound);
    return;
  }

  var actions = []; // human-readable log of what we actually changed

  // ----- 3) Status (this is the go-live switch) ----------------------------
  applyStatus(campaign, config.status, actions);

  // ----- 4) Budget ----------------------------------------------------------
  applyBudget(campaign, config.dailyBudget, actions);

  // ----- 5) Ensure an ad group (create if none) ----------------------------
  var adGroupName = config.adGroupName || DEFAULT_AD_GROUP_NAME;
  var maxCpc = isFiniteNumber(config.maxCpc) ? Number(config.maxCpc) : DEFAULT_MAX_CPC;
  var adGroup = ensureAdGroup(campaign, adGroupName, maxCpc, actions);

  // ----- 6) Keywords (idempotent) ------------------------------------------
  var kwResult = { ensured: 0, added: 0 };
  if (adGroup) {
    kwResult = ensureKeywords(adGroup, config.keywords, actions);
  } else {
    Logger.log('No ad group available — skipping keyword sync.');
  }

  // ----- 7) Negative keywords (idempotent) ---------------------------------
  var negAdded = ensureNegativeKeywords(campaign, config.negativeKeywords, actions);

  // ----- 8) Bids (only on Manual CPC) --------------------------------------
  if (adGroup) {
    applyMaxCpc(campaign, adGroup, config.maxCpc, actions);
  }

  // ----- 9) Report ----------------------------------------------------------
  var report = buildReport(campaign, config, kwResult, negAdded, actions, today);
  Logger.log(report);
  safeEmail('QuoteSmith Ads control run — ' + today, report);
}

/* ===========================================================================
 *  Config
 * ======================================================================== */

/**
 * Fetches and parses the JSON config. Returns the parsed object, or null if
 * anything goes wrong (in which case it has already logged + emailed an alert).
 */
function fetchConfig() {
  var response;
  try {
    response = UrlFetchApp.fetch(CONFIG_URL, { muteHttpExceptions: true });
  } catch (e) {
    var fetchErr = 'Could not fetch config from ' + CONFIG_URL + ' : ' +
        (e && e.message ? e.message : e) + '. No changes made.';
    Logger.log(fetchErr);
    safeEmail('QuoteSmith Ads control — config fetch failed', fetchErr);
    return null;
  }

  var code = response.getResponseCode();
  if (code !== 200) {
    var httpErr = 'Config fetch returned HTTP ' + code + ' from ' + CONFIG_URL +
        '. No changes made.\n\nResponse body:\n' + truncate(response.getContentText(), 500);
    Logger.log(httpErr);
    safeEmail('QuoteSmith Ads control — config HTTP ' + code, httpErr);
    return null;
  }

  var text = response.getContentText();
  var config;
  try {
    config = JSON.parse(text);
  } catch (e) {
    var parseErr = 'Config is not valid JSON. No changes made.\n\nError: ' +
        (e && e.message ? e.message : e) + '\n\nRaw content:\n' + truncate(text, 500);
    Logger.log(parseErr);
    safeEmail('QuoteSmith Ads control — invalid JSON config', parseErr);
    return null;
  }

  if (!config || typeof config !== 'object') {
    var shapeErr = 'Config did not parse to an object. No changes made.';
    Logger.log(shapeErr);
    safeEmail('QuoteSmith Ads control — bad config shape', shapeErr);
    return null;
  }

  Logger.log('Config loaded OK: ' + truncate(text, 800));
  return config;
}

/* ===========================================================================
 *  Campaign lookup
 * ======================================================================== */

function findCampaign(name) {
  var iterator = AdsApp.campaigns()
      .withCondition('campaign.name = "' + escapeForCondition(name) + '"')
      .get();
  if (iterator.hasNext()) {
    return iterator.next();
  }
  return null;
}

/* ===========================================================================
 *  Status
 * ======================================================================== */

function applyStatus(campaign, status, actions) {
  if (!status) {
    Logger.log('No "status" in config — leaving campaign status unchanged.');
    return;
  }
  var wanted = String(status).toUpperCase();
  var isEnabled = campaign.isEnabled();

  if (wanted === 'ENABLED') {
    if (!isEnabled) {
      campaign.enable();
      actions.push('Status: ENABLED the campaign (was paused/removed).');
      Logger.log('Enabled campaign.');
    } else {
      Logger.log('Status already ENABLED — no change.');
    }
  } else if (wanted === 'PAUSED') {
    if (isEnabled) {
      campaign.pause();
      actions.push('Status: PAUSED the campaign (was enabled).');
      Logger.log('Paused campaign.');
    } else {
      Logger.log('Status already PAUSED — no change.');
    }
  } else {
    Logger.log('Unrecognised status "' + status + '" — expected ENABLED or PAUSED. No status change.');
  }
}

/* ===========================================================================
 *  Budget
 * ======================================================================== */

function applyBudget(campaign, dailyBudget, actions) {
  if (!isFiniteNumber(dailyBudget)) {
    Logger.log('No valid "dailyBudget" in config — leaving budget unchanged.');
    return;
  }
  var target = Number(dailyBudget);
  if (target <= 0) {
    Logger.log('dailyBudget must be > 0 (got ' + target + ') — leaving budget unchanged.');
    return;
  }

  var budget = campaign.getBudget();
  var current = budget.getAmount();

  // Avoid needless writes (floating point safe compare to the penny).
  if (Math.abs(current - target) < 0.005) {
    Logger.log('Budget already £' + current.toFixed(2) + ' — no change.');
    return;
  }

  budget.setAmount(target);
  actions.push('Budget: changed from £' + current.toFixed(2) + ' to £' + target.toFixed(2) + '/day.');
  Logger.log('Set daily budget to £' + target.toFixed(2));
}

/* ===========================================================================
 *  Ad group
 * ======================================================================== */

/**
 * Returns the campaign's first ad group. If the campaign has none, creates one
 * named adGroupName with the given max CPC. Returns the AdGroup or null.
 */
function ensureAdGroup(campaign, adGroupName, maxCpc, actions) {
  var iterator = campaign.adGroups().get();
  if (iterator.hasNext()) {
    var existing = iterator.next();
    Logger.log('Using existing ad group: "' + existing.getName() + '".');
    return existing;
  }

  Logger.log('Campaign has no ad group — creating "' + adGroupName + '".');
  var builder = campaign.newAdGroupBuilder()
      .withName(adGroupName);

  if (isFiniteNumber(maxCpc) && Number(maxCpc) > 0) {
    builder = builder.withCpc(Number(maxCpc));
  }

  var operation = builder.build();
  if (operation.isSuccessful()) {
    var created = operation.getResult();
    actions.push('Ad group: created "' + adGroupName + '"' +
        (isFiniteNumber(maxCpc) ? (' (max CPC £' + Number(maxCpc).toFixed(2) + ')') : '') + '.');
    Logger.log('Created ad group "' + adGroupName + '".');
    return created;
  }

  var errs = operation.getErrors().join('; ');
  var failMsg = 'Failed to create ad group "' + adGroupName + '": ' + errs;
  Logger.log(failMsg);
  actions.push('Ad group: FAILED to create "' + adGroupName + '" (' + errs + ').');
  return null;
}

/* ===========================================================================
 *  Keywords (idempotent)
 * ======================================================================== */

/**
 * Ensures every keyword in the config exists in the ad group.
 * Returns { ensured: <total in config considered>, added: <newly created> }.
 */
function ensureKeywords(adGroup, keywords, actions) {
  var result = { ensured: 0, added: 0 };
  if (!isArray(keywords) || keywords.length === 0) {
    Logger.log('No keywords in config — skipping keyword sync.');
    return result;
  }

  // Build a set of existing keyword texts (normalised) for idempotent checks.
  var existing = {};
  var kwIterator = adGroup.keywords().get();
  while (kwIterator.hasNext()) {
    var existingKw = kwIterator.next();
    existing[normaliseKeywordText(existingKw.getText())] = true;
  }

  for (var i = 0; i < keywords.length; i++) {
    var entry = keywords[i];
    if (!entry || !entry.text) {
      Logger.log('Skipping malformed keyword entry at index ' + i + '.');
      continue;
    }
    result.ensured++;

    var matchType = (entry.match || 'BROAD').toString().toUpperCase();
    var builderText = toMatchTypeText(entry.text, matchType);
    var key = normaliseKeywordText(builderText);

    if (existing[key]) {
      Logger.log('Keyword already present: ' + builderText + ' — skipping.');
      continue;
    }

    var operation = adGroup.newKeywordBuilder()
        .withText(builderText)
        .build();

    if (operation.isSuccessful()) {
      existing[key] = true; // guard against duplicates within this same run
      result.added++;
      actions.push('Keyword added: ' + builderText + ' (' + matchType + ').');
      Logger.log('Added keyword: ' + builderText);
    } else {
      var errs = operation.getErrors().join('; ');
      Logger.log('Failed to add keyword ' + builderText + ': ' + errs);
      actions.push('Keyword FAILED: ' + builderText + ' (' + errs + ').');
    }
  }

  return result;
}

/**
 * Converts plain keyword text + match type into the Google Ads Scripts builder
 * syntax: broad = "shoes", phrase = "\"shoes\"", exact = "[shoes]".
 */
function toMatchTypeText(text, matchType) {
  var clean = String(text).trim();
  // If the text already carries match-type punctuation, leave it as-is.
  if (/^\[.*\]$/.test(clean) || /^".*"$/.test(clean)) {
    return clean;
  }
  switch (matchType) {
    case 'EXACT':
      return '[' + clean + ']';
    case 'PHRASE':
      return '"' + clean + '"';
    case 'BROAD':
    default:
      return clean;
  }
}

/**
 * Normalises keyword text for comparison: lowercase, collapse internal
 * whitespace, strip surrounding phrase/exact punctuation so the bare term is
 * compared consistently regardless of how it was stored.
 */
function normaliseKeywordText(text) {
  var t = String(text).trim().toLowerCase();
  if (/^\[.*\]$/.test(t)) {
    t = '[' + t.slice(1, -1).replace(/\s+/g, ' ').trim() + ']';
  } else if (/^".*"$/.test(t)) {
    t = '"' + t.slice(1, -1).replace(/\s+/g, ' ').trim() + '"';
  } else {
    t = t.replace(/\s+/g, ' ');
  }
  return t;
}

/* ===========================================================================
 *  Negative keywords (idempotent, campaign level)
 * ======================================================================== */

function ensureNegativeKeywords(campaign, negativeKeywords, actions) {
  if (!isArray(negativeKeywords) || negativeKeywords.length === 0) {
    Logger.log('No negativeKeywords in config — skipping.');
    return 0;
  }

  // Existing campaign-level negatives, normalised.
  var existing = {};
  var negIterator = campaign.negativeKeywords().get();
  while (negIterator.hasNext()) {
    var negKw = negIterator.next();
    existing[normaliseKeywordText(negKw.getText())] = true;
  }

  var added = 0;
  for (var i = 0; i < negativeKeywords.length; i++) {
    var raw = negativeKeywords[i];
    if (!raw) {
      continue;
    }
    var text = String(raw).trim();
    if (!text) {
      continue;
    }
    var key = normaliseKeywordText(text);
    if (existing[key]) {
      Logger.log('Negative already present: ' + text + ' — skipping.');
      continue;
    }

    // createNegativeKeyword adds a campaign-level negative; match type follows
    // the same text formatting rules (plain = broad, "x" = phrase, [x] = exact).
    campaign.createNegativeKeyword(text);
    existing[key] = true;
    added++;
    actions.push('Negative keyword added: ' + text + '.');
    Logger.log('Added negative keyword: ' + text);
  }

  return added;
}

/* ===========================================================================
 *  Bids (Manual CPC only)
 * ======================================================================== */

function applyMaxCpc(campaign, adGroup, maxCpc, actions) {
  if (!isFiniteNumber(maxCpc) || Number(maxCpc) <= 0) {
    Logger.log('No valid "maxCpc" in config — leaving bids unchanged.');
    return;
  }
  var target = Number(maxCpc);

  // Only meaningful on Manual CPC. Other strategies (Maximize Clicks, tCPA,
  // tROAS, etc.) ignore / disallow per-ad-group max CPC, so we only log.
  var strategyType = '';
  try {
    strategyType = String(campaign.getBiddingStrategyType() || '').toUpperCase();
  } catch (e) {
    Logger.log('Could not read bidding strategy type: ' + (e && e.message ? e.message : e));
  }

  var isManual = strategyType.indexOf('MANUAL_CPC') !== -1 ||
      strategyType.indexOf('MANUAL CPC') !== -1 ||
      strategyType === 'CPC' || strategyType === '';

  if (!isManual) {
    Logger.log('Campaign bid strategy is "' + strategyType + '" (not Manual CPC) — ' +
        'not changing bids in v1. maxCpc left to the automated strategy.');
    actions.push('Bids: skipped (strategy "' + strategyType + '" is not Manual CPC).');
    return;
  }

  var bidding = adGroup.bidding();
  var current = null;
  try {
    current = bidding.getCpc();
  } catch (e) {
    current = null;
  }

  if (current !== null && Math.abs(current - target) < 0.005) {
    Logger.log('Ad group max CPC already £' + current.toFixed(2) + ' — no change.');
    return;
  }

  bidding.setCpc(target);
  actions.push('Bids: set ad group max CPC to £' + target.toFixed(2) +
      (current !== null ? (' (was £' + current.toFixed(2) + ')') : '') + '.');
  Logger.log('Set ad group max CPC to £' + target.toFixed(2));
}

/* ===========================================================================
 *  Report
 * ======================================================================== */

function buildReport(campaign, config, kwResult, negAdded, actions, today) {
  var status = campaign.isEnabled() ? 'ENABLED' : 'PAUSED';
  var budgetAmount;
  try {
    budgetAmount = '£' + campaign.getBudget().getAmount().toFixed(2) + '/day';
  } catch (e) {
    budgetAmount = '(could not read budget)';
  }

  var statsLine;
  try {
    var stats = campaign.getStatsFor('LAST_30_DAYS');
    statsLine =
        'Impressions: ' + stats.getImpressions() + '\n' +
        'Clicks:      ' + stats.getClicks() + '\n' +
        'Cost:        £' + Number(stats.getCost()).toFixed(2) + '\n' +
        'Conversions: ' + stats.getConversions();
  } catch (e) {
    statsLine = '(stats unavailable: ' + (e && e.message ? e.message : e) + ')';
  }

  var changeSummary = actions.length > 0 ?
      ('- ' + actions.join('\n- ')) :
      'No changes were needed — the live campaign already matched the config.';

  var lines = [];
  lines.push('QuoteSmith Google Ads — control run summary');
  lines.push('Run time: ' + today);
  lines.push('Config source: ' + CONFIG_URL);
  lines.push('');
  lines.push('CAMPAIGN');
  lines.push('  Name:   ' + campaign.getName());
  lines.push('  Status: ' + status + (status === 'PAUSED' ? '  (NOT spending — flip config to ENABLED to go live)' : '  (LIVE / spending)'));
  lines.push('  Budget: ' + budgetAmount);
  lines.push('');
  lines.push('KEYWORDS');
  lines.push('  Ensured (in config): ' + kwResult.ensured);
  lines.push('  Newly added:         ' + kwResult.added);
  lines.push('  Negatives added:     ' + negAdded);
  lines.push('');
  lines.push('CHANGES THIS RUN');
  lines.push(changeSummary);
  lines.push('');
  lines.push('LAST 30 DAYS');
  lines.push(statsLine);
  lines.push('');
  lines.push('-- This is an automated message from the QuoteSmith Ads control script.');

  return lines.join('\n');
}

/* ===========================================================================
 *  Helpers
 * ======================================================================== */

function safeEmail(subject, body) {
  try {
    MailApp.sendEmail(ALERT_EMAIL, subject, body);
  } catch (e) {
    Logger.log('Could not send email "' + subject + '": ' + (e && e.message ? e.message : e));
  }
}

function isFiniteNumber(v) {
  return typeof v === 'number' ? isFinite(v) :
      (v !== null && v !== undefined && v !== '' && isFinite(Number(v)));
}

function isArray(v) {
  return Object.prototype.toString.call(v) === '[object Array]';
}

function escapeForCondition(name) {
  // Escape double quotes so a campaign name with quotes can't break the query.
  return String(name).replace(/"/g, '\\"');
}

function truncate(s, max) {
  s = String(s);
  return s.length > max ? (s.substring(0, max) + ' …[truncated]') : s;
}

function formatDate(d) {
  function pad(n) { return n < 10 ? ('0' + n) : ('' + n); }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
