/**
 * ============================================================================
 *  Hitchens Group — Remote-Controlled Google Ads Script (MULTI-CAMPAIGN)
 * ============================================================================
 *
 *  WHAT THIS DOES
 *  --------------
 *  Every time it runs, this script downloads a small JSON "config" file from a
 *  fixed GitHub URL and then makes one OR MORE Google Ads campaigns match that
 *  config. The config is now a LIST of campaigns:
 *
 *      { "campaigns": [ { ...campaign1... }, { ...campaign2... }, ... ] }
 *
 *  For EACH campaign in the list, it will:
 *    - Find the campaign by its exact name.
 *    - IF FOUND, manage it (idempotently):
 *        * Turn the campaign ON or OFF        (status)
 *        * Set the daily budget               (dailyBudget, in GBP)
 *        * Ensure an ad group exists          (adGroupName)
 *        * Ensure keywords exist              (keywords)
 *        * Ensure negative keywords exist     (negativeKeywords)
 *        * Set the ad group max CPC bid        (maxCpc, only on Manual CPC)
 *    - IF NOT FOUND and "createIfMissing": true:
 *        * CREATE a brand-new SEARCH campaign from scratch:
 *            budget + campaign (Google Search only, Manual CPC, UK geo),
 *            ad group, ONE responsive search ad (headlines/descriptions),
 *            keywords and negative keywords.
 *        * It is ALWAYS created PAUSED for safety (config.status is ignored on
 *          first creation). It will only go live on a LATER run, once the
 *          config "status" is flipped to ENABLED and the manage path enables it.
 *    - IF NOT FOUND and "createIfMissing" is false/absent: log + skip.
 *
 *  Then it emails a single combined summary report covering every campaign.
 *
 *  HOW THE OWNER USES IT (paste once, then forget)
 *  -----------------------------------------------
 *    1. Google Ads  ->  Tools  ->  Bulk actions  ->  Scripts  ->  "+"
 *    2. Paste this whole file in, click Authorize, then Save.
 *    3. Schedule it to run HOURLY.
 *  After that you NEVER touch Google Ads again. To change anything (go live,
 *  pause, change budget, add keywords, add a whole new campaign) you only edit
 *  the JSON config file at CONFIG_URL (below).
 *
 *  GO-LIVE / SAFETY
 *  ----------------
 *  A campaign only spends money when its config entry says "status":"ENABLED".
 *  Newly CREATED campaigns are always PAUSED on the run that creates them,
 *  regardless of config — they only go live on a subsequent run after you have
 *  reviewed them and the config still says ENABLED.
 *
 *  This script is FAIL-SAFE and IDEMPOTENT:
 *    - If the config can't be fetched / isn't valid JSON / has no campaigns
 *      array, it changes NOTHING and emails an alert.
 *    - One campaign's error never stops the others — each is processed in its
 *      own try/catch and results are collected for the report.
 *    - Running it ten times in a row produces the same result as running once
 *      (no duplicate campaigns, ad groups, keywords or budget writes).
 *    - Any unexpected error is caught, logged, and emailed — it never throws.
 *
 *  Uses only Google Ads Scripts built-ins: AdsApp, UrlFetchApp, MailApp, Logger.
 * ============================================================================
 */

// The single source of truth. Edit the file at this URL to control everything.
var CONFIG_URL = 'https://raw.githubusercontent.com/johnhitchenswork-cmyk/qs-ads-control/main/config.json';

// Where run reports and alerts are sent.
var ALERT_EMAIL = 'johnhitchenswork@gmail.com';

// Sensible fallbacks if a campaign entry omits an optional field.
var DEFAULT_AD_GROUP_NAME = 'Ad Group 1';
var DEFAULT_MAX_CPC = 0.40;

// United Kingdom geo target (Google Ads location criterion id). Used when
// creating a brand-new campaign so it targets the UK only.
var UK_LOCATION_ID = 2826;

// Temp-ID counter for mutate operations (campaign + budget creation).
var TEMP_ID_COUNTER = -1;
function getNextTempId() {
  return TEMP_ID_COUNTER--;
}

function main() {
  try {
    run();
  } catch (e) {
    // Absolute last line of defence — nothing should ever throw past here.
    var msg = 'Hitchens Ads control FATAL error: ' + (e && e.message ? e.message : e) +
        (e && e.stack ? ('\n\n' + e.stack) : '');
    Logger.log(msg);
    safeEmail('Hitchens Ads control — FATAL error', msg);
  }
}

/**
 * Core logic. May throw; main() catches everything.
 */
function run() {
  var today = formatDate(new Date());
  Logger.log('=== Hitchens Ads control run @ ' + today + ' ===');

  // ----- 1) Fetch + parse config (fail safe) -------------------------------
  var config = fetchConfig();
  if (!config) {
    // fetchConfig already logged + emailed the reason. Exit without changes.
    Logger.log('No valid config — exiting without any changes.');
    return;
  }

  if (!isArray(config.campaigns) || config.campaigns.length === 0) {
    var noList = 'Config is missing a non-empty "campaigns" array. No changes made.\n\n' +
        'Expected shape: { "campaigns": [ { "campaignName": "...", ... } ] }';
    Logger.log(noList);
    safeEmail('Hitchens Ads control — config error', noList);
    return;
  }

  // ----- 2) Process each campaign independently ----------------------------
  var results = []; // one per-campaign result object for the report
  for (var i = 0; i < config.campaigns.length; i++) {
    var entry = config.campaigns[i];
    var result = processCampaignSafely(entry, i);
    results.push(result);
  }

  // ----- 3) One combined report --------------------------------------------
  var report = buildReport(results, today);
  Logger.log(report);
  safeEmail('Hitchens Ads control run — ' + today, report);
}

/**
 * Wraps processing of a single campaign entry so one failure can never stop
 * the rest. Always returns a result object for the report.
 */
function processCampaignSafely(entry, index) {
  var name = (entry && entry.campaignName) ? String(entry.campaignName) : ('(entry #' + (index + 1) + ' — no name)');
  var result = {
    name: name,
    outcome: 'UNKNOWN',
    status: '(unknown)',
    budget: '(unknown)',
    kwEnsured: 0,
    kwAdded: 0,
    negAdded: 0,
    actions: [],
    stats: null,
    error: null
  };
  try {
    if (!entry || typeof entry !== 'object') {
      result.outcome = 'SKIPPED';
      result.error = 'Campaign entry #' + (index + 1) + ' is not an object.';
      Logger.log(result.error);
      return result;
    }
    if (!entry.campaignName) {
      result.outcome = 'SKIPPED';
      result.error = 'Campaign entry #' + (index + 1) + ' is missing "campaignName".';
      Logger.log(result.error);
      return result;
    }
    processCampaign(entry, result);
  } catch (e) {
    result.outcome = 'ERROR';
    result.error = (e && e.message ? e.message : String(e)) + (e && e.stack ? ('\n' + e.stack) : '');
    Logger.log('Error processing "' + name + '": ' + result.error);
  }
  return result;
}

/**
 * Find-or-create + manage a single campaign. Mutates `result` in place.
 */
function processCampaign(entry, result) {
  Logger.log('--- Processing campaign: "' + entry.campaignName + '" ---');

  var campaign = findCampaign(entry.campaignName);

  if (!campaign) {
    if (entry.createIfMissing === true) {
      Logger.log('Campaign not found — createIfMissing is true. Creating it PAUSED.');
      campaign = createCampaign(entry, result);
      if (!campaign) {
        // createCampaign already populated result.error / outcome.
        return;
      }
      result.outcome = 'CREATED';
      // IMPORTANT: do NOT enable on the creation run. It is left PAUSED on
      // purpose; a later run will enable it if config.status is ENABLED.
      result.actions.push('Created brand-new SEARCH campaign PAUSED (will go live only on a later run if status=ENABLED).');
      finishReportFields(campaign, result);
      return;
    }
    result.outcome = 'NOT_FOUND_SKIPPED';
    result.error = 'Campaign not found and createIfMissing is not true — skipped.';
    Logger.log(result.error);
    return;
  }

  // Found — manage it exactly as the original single-campaign script did.
  result.outcome = 'MANAGED';
  manageCampaign(campaign, entry, result);
  finishReportFields(campaign, result);
}

/**
 * Manage an existing campaign idempotently: status, budget, ad group,
 * keywords, negatives, bids.
 */
function manageCampaign(campaign, entry, result) {
  // ----- Status (this is the go-live switch) -------------------------------
  applyStatus(campaign, entry.status, result.actions);

  // ----- Budget ------------------------------------------------------------
  applyBudget(campaign, entry.dailyBudget, result.actions);

  // ----- Ensure an ad group (create if none) -------------------------------
  var adGroupName = entry.adGroupName || DEFAULT_AD_GROUP_NAME;
  var maxCpc = isFiniteNumber(entry.maxCpc) ? Number(entry.maxCpc) : DEFAULT_MAX_CPC;
  var adGroup = ensureAdGroup(campaign, adGroupName, maxCpc, result.actions);

  // ----- Keywords (idempotent) ---------------------------------------------
  if (adGroup) {
    var kwResult = ensureKeywords(adGroup, entry.keywords, result.actions);
    result.kwEnsured = kwResult.ensured;
    result.kwAdded = kwResult.added;
  } else {
    Logger.log('No ad group available — skipping keyword sync.');
  }

  // ----- Negative keywords (idempotent) ------------------------------------
  result.negAdded = ensureNegativeKeywords(campaign, entry.negativeKeywords, result.actions);

  // ----- Bids (only on Manual CPC) -----------------------------------------
  if (adGroup) {
    applyMaxCpc(campaign, adGroup, entry.maxCpc, result.actions);
  }
}

/**
 * Fills in status / budget / stats on the result for the report. Safe.
 */
function finishReportFields(campaign, result) {
  try {
    result.status = campaign.isEnabled() ? 'ENABLED' : 'PAUSED';
  } catch (e) {
    result.status = '(unknown)';
  }
  try {
    result.budget = '£' + campaign.getBudget().getAmount().toFixed(2) + '/day';
  } catch (e) {
    result.budget = '(could not read budget)';
  }
  try {
    var stats = campaign.getStatsFor('LAST_30_DAYS');
    result.stats = {
      impressions: stats.getImpressions(),
      clicks: stats.getClicks(),
      cost: Number(stats.getCost()).toFixed(2),
      conversions: stats.getConversions()
    };
  } catch (e) {
    result.stats = null;
  }
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
    safeEmail('Hitchens Ads control — config fetch failed', fetchErr);
    return null;
  }

  var code = response.getResponseCode();
  if (code !== 200) {
    var httpErr = 'Config fetch returned HTTP ' + code + ' from ' + CONFIG_URL +
        '. No changes made.\n\nResponse body:\n' + truncate(response.getContentText(), 500);
    Logger.log(httpErr);
    safeEmail('Hitchens Ads control — config HTTP ' + code, httpErr);
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
    safeEmail('Hitchens Ads control — invalid JSON config', parseErr);
    return null;
  }

  if (!config || typeof config !== 'object') {
    var shapeErr = 'Config did not parse to an object. No changes made.';
    Logger.log(shapeErr);
    safeEmail('Hitchens Ads control — bad config shape', shapeErr);
    return null;
  }

  Logger.log('Config loaded OK: ' + truncate(text, 1200));
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
 *  Campaign creation (create-if-missing) — always PAUSED on creation
 * ======================================================================== */

/**
 * Creates a brand-new SEARCH campaign from scratch using the Google Ads Scripts
 * mutate flow (budget operation + campaign operation), then layers on the geo
 * target, ad group, responsive search ad, keywords and negatives using the
 * idempotent AdsApp builders. Returns the created Campaign, or null on failure
 * (in which case result.error / result.outcome are set).
 *
 * The campaign is ALWAYS created with status PAUSED for safety — config.status
 * is deliberately ignored here.
 */
function createCampaign(entry, result) {
  var name = entry.campaignName;

  // --- Validate the minimum we need to safely create a campaign -----------
  var dailyBudget = isFiniteNumber(entry.dailyBudget) ? Number(entry.dailyBudget) : 0;
  if (!(dailyBudget > 0)) {
    result.outcome = 'CREATE_FAILED';
    result.error = 'Cannot create "' + name + '": missing/invalid dailyBudget (must be > 0).';
    Logger.log(result.error);
    return null;
  }

  var customerId;
  try {
    customerId = AdsApp.currentAccount().getCustomerId();
  } catch (e) {
    result.outcome = 'CREATE_FAILED';
    result.error = 'Cannot create "' + name + '": could not read customer id (' + (e && e.message ? e.message : e) + ').';
    Logger.log(result.error);
    return null;
  }

  // --- Build budget + campaign operations (atomic mutateAll) --------------
  // Budget amount is in micros (1,000,000 micros = 1 unit of account currency).
  var amountMicros = Math.round(dailyBudget * 1000000);
  // Unique budget name so we never collide / reuse another campaign's budget.
  var budgetName = name + ' — budget ' + (new Date()).getTime();

  var budgetResourceName = 'customers/' + customerId + '/campaignBudgets/' + getNextTempId();
  var campaignResourceName = 'customers/' + customerId + '/campaigns/' + getNextTempId();

  var operations = [];
  operations.push({
    'campaignBudgetOperation': {
      'create': {
        'resourceName': budgetResourceName,
        'name': budgetName,
        'amountMicros': String(amountMicros),
        'deliveryMethod': 'STANDARD',
        'explicitlyShared': false
      }
    }
  });
  operations.push({
    'campaignOperation': {
      'create': {
        'resourceName': campaignResourceName,
        'name': name,
        // ALWAYS paused on creation. Ignore entry.status here on purpose.
        'status': 'PAUSED',
        'advertisingChannelType': 'SEARCH',
        'campaignBudget': budgetResourceName,
        'biddingStrategyType': 'MANUAL_CPC',
        'manualCpc': {
          'enhancedCpcEnabled': false
        },
        // Google Search ONLY — no display, no search partners — keep it tight.
        'networkSettings': {
          'targetGoogleSearch': true,
          'targetSearchNetwork': false,
          'targetContentNetwork': false,
          'targetPartnerSearchNetwork': false
        }
      }
    }
  });

  var mutateOk = false;
  try {
    var mutateResults = AdsApp.mutateAll(operations);
    mutateOk = true;
    for (var m = 0; m < mutateResults.length; m++) {
      if (!mutateResults[m].isSuccessful()) {
        mutateOk = false;
        var errText = '(no detail)';
        try { errText = mutateResults[m].getErrorMessages().join('; '); } catch (ignored) {}
        Logger.log('mutateAll operation ' + m + ' failed: ' + errText);
        result.actions.push('Create FAILED at operation ' + m + ': ' + errText);
      }
    }
  } catch (e) {
    result.outcome = 'CREATE_FAILED';
    result.error = 'mutateAll threw while creating "' + name + '": ' + (e && e.message ? e.message : e);
    Logger.log(result.error);
    return null;
  }

  if (!mutateOk) {
    result.outcome = 'CREATE_FAILED';
    result.error = 'Budget/campaign creation reported errors for "' + name + '". See actions/log.';
    return null;
  }

  result.actions.push('Created budget "' + budgetName + '" at £' + dailyBudget.toFixed(2) + '/day.');
  result.actions.push('Created SEARCH campaign (Google Search only, Manual CPC, PAUSED).');

  // --- Re-find the now-real campaign so we can use the builders -----------
  var campaign = findCampaign(name);
  if (!campaign) {
    result.outcome = 'CREATE_FAILED';
    result.error = 'Created campaign "' + name + '" but could not re-find it afterwards.';
    Logger.log(result.error);
    return null;
  }

  // --- Geo target: United Kingdom -----------------------------------------
  try {
    campaign.addLocation(UK_LOCATION_ID);
    result.actions.push('Geo: targeted United Kingdom (location ' + UK_LOCATION_ID + ').');
    Logger.log('Added UK geo target.');
  } catch (e) {
    // Non-fatal: campaign still exists; just note it.
    Logger.log('Could not add UK geo target: ' + (e && e.message ? e.message : e));
    result.actions.push('Geo: FAILED to add UK target (' + (e && e.message ? e.message : e) + ') — set it manually.');
  }

  // --- Ad group ------------------------------------------------------------
  var adGroupName = entry.adGroupName || DEFAULT_AD_GROUP_NAME;
  var maxCpc = isFiniteNumber(entry.maxCpc) ? Number(entry.maxCpc) : DEFAULT_MAX_CPC;
  var adGroup = ensureAdGroup(campaign, adGroupName, maxCpc, result.actions);

  if (adGroup) {
    // --- Responsive search ad (one) ----------------------------------------
    createResponsiveSearchAd(adGroup, entry, result.actions);

    // --- Keywords ----------------------------------------------------------
    var kwResult = ensureKeywords(adGroup, entry.keywords, result.actions);
    result.kwEnsured = kwResult.ensured;
    result.kwAdded = kwResult.added;
  } else {
    Logger.log('No ad group after creation — skipping ad + keywords.');
  }

  // --- Negative keywords ---------------------------------------------------
  result.negAdded = ensureNegativeKeywords(campaign, entry.negativeKeywords, result.actions);

  return campaign;
}

/**
 * Creates ONE responsive search ad in the ad group from entry.headlines and
 * entry.descriptions, with entry.finalUrl as the final URL. Idempotent enough:
 * if the ad group already has an enabled ad, it does nothing.
 */
function createResponsiveSearchAd(adGroup, entry, actions) {
  // If an ad already exists, don't create a duplicate.
  try {
    var existingAds = adGroup.ads().get();
    if (existingAds.hasNext()) {
      Logger.log('Ad group already has an ad — not creating another RSA.');
      return;
    }
  } catch (e) {
    Logger.log('Could not check existing ads (continuing to create): ' + (e && e.message ? e.message : e));
  }

  var headlines = isArray(entry.headlines) ? entry.headlines.filter(isNonEmptyString) : [];
  var descriptions = isArray(entry.descriptions) ? entry.descriptions.filter(isNonEmptyString) : [];
  var finalUrl = isNonEmptyString(entry.finalUrl) ? String(entry.finalUrl).trim() : '';

  // Responsive search ads require >=3 headlines and >=2 descriptions + a URL.
  if (headlines.length < 3 || descriptions.length < 2 || !finalUrl) {
    var why = 'Responsive search ad NOT created (needs >=3 headlines, >=2 descriptions and a finalUrl; got ' +
        headlines.length + ' headlines, ' + descriptions.length + ' descriptions, finalUrl=' + (finalUrl ? 'yes' : 'no') + ').';
    Logger.log(why);
    actions.push(why);
    return;
  }

  try {
    var operation = adGroup.newAd().responsiveSearchAdBuilder()
        .withHeadlines(headlines)
        .withDescriptions(descriptions)
        .withFinalUrl(finalUrl)
        .build();

    if (operation.isSuccessful()) {
      actions.push('Responsive search ad created (' + headlines.length + ' headlines, ' + descriptions.length + ' descriptions).');
      Logger.log('Created responsive search ad.');
    } else {
      var errs = operation.getErrors().join('; ');
      actions.push('Responsive search ad FAILED: ' + errs);
      Logger.log('RSA creation failed: ' + errs);
    }
  } catch (e) {
    actions.push('Responsive search ad FAILED: ' + (e && e.message ? e.message : e));
    Logger.log('RSA creation threw: ' + (e && e.message ? e.message : e));
  }
}

/* ===========================================================================
 *  Status
 * ======================================================================== */

function applyStatus(campaign, status, actions) {
  if (!status) {
    Logger.log('No "status" in entry — leaving campaign status unchanged.');
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
    Logger.log('No valid "dailyBudget" in entry — leaving budget unchanged.');
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
 * Ensures every keyword in the entry exists in the ad group.
 * Returns { ensured: <total in config considered>, added: <newly created> }.
 */
function ensureKeywords(adGroup, keywords, actions) {
  var result = { ensured: 0, added: 0 };
  if (!isArray(keywords) || keywords.length === 0) {
    Logger.log('No keywords in entry — skipping keyword sync.');
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
    Logger.log('No negativeKeywords in entry — skipping.');
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
    Logger.log('No valid "maxCpc" in entry — leaving bids unchanged.');
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
        'not changing bids. maxCpc left to the automated strategy.');
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

function buildReport(results, today) {
  var lines = [];
  lines.push('Hitchens Group Google Ads — control run summary');
  lines.push('Run time: ' + today);
  lines.push('Config source: ' + CONFIG_URL);
  lines.push('Campaigns in config: ' + results.length);
  lines.push('');

  // Top-line tally.
  var counts = {};
  for (var c = 0; c < results.length; c++) {
    var o = results[c].outcome;
    counts[o] = (counts[o] || 0) + 1;
  }
  var tally = [];
  for (var k in counts) {
    if (counts.hasOwnProperty(k)) {
      tally.push(k + ': ' + counts[k]);
    }
  }
  lines.push('OUTCOMES — ' + (tally.length ? tally.join(', ') : 'none'));
  lines.push('================================================================');

  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    lines.push('');
    lines.push((i + 1) + ') ' + r.name);
    lines.push('   Outcome: ' + r.outcome);
    lines.push('   Status:  ' + r.status +
        (r.status === 'PAUSED' ? '  (NOT spending — flip status to ENABLED to go live)' :
         (r.status === 'ENABLED' ? '  (LIVE / spending)' : '')));
    lines.push('   Budget:  ' + r.budget);
    lines.push('   Keywords ensured (in config): ' + r.kwEnsured);
    lines.push('   Keywords newly added:         ' + r.kwAdded);
    lines.push('   Negatives newly added:        ' + r.negAdded);

    if (r.error) {
      lines.push('   ERROR: ' + r.error);
    }

    if (r.actions && r.actions.length > 0) {
      lines.push('   Changes this run:');
      for (var a = 0; a < r.actions.length; a++) {
        lines.push('     - ' + r.actions[a]);
      }
    } else if (r.outcome === 'MANAGED') {
      lines.push('   Changes this run: none — live campaign already matched the config.');
    }

    if (r.stats) {
      lines.push('   Last 30 days: ' +
          'impr ' + r.stats.impressions + ', ' +
          'clicks ' + r.stats.clicks + ', ' +
          'cost £' + r.stats.cost + ', ' +
          'conv ' + r.stats.conversions + '.');
    }
  }

  lines.push('');
  lines.push('-- Automated message from the Hitchens Group Ads control script.');
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

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
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
