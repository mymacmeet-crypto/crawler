'use strict';

const path = require('node:path');
require('dotenv').config();

const DEFAULT_USER_AGENT =
  'SiteArchiver/1.0 (+https://github.com/single-file-archiver) SingleFile-crawler';

/** Compile CLI-provided pattern strings into RegExp, failing fast on typos. */
function compilePatterns(patterns, flagName) {
  return (patterns || []).map((raw) => {
    try {
      return new RegExp(raw);
    } catch (error) {
      throw new Error(`Invalid regular expression for ${flagName}: "${raw}" (${error.message})`);
    }
  });
}

function positiveInt(value, flagName, { min = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || !Number.isInteger(n)) {
    throw new Error(`${flagName} must be an integer >= ${min}, got "${value}"`);
  }
  return n;
}

/**
 * Merge CLI options over .env values over built-in defaults into the single
 * frozen config object that the rest of the crawler consumes.
 */
function buildConfig(startUrl, cliOptions) {
  const env = process.env;

  const outputFolder = path.resolve(
    cliOptions.output || env.OUTPUT_FOLDER || './archive'
  );

  const config = {
    startUrl,
    outputFolder,

    maxDepth: positiveInt(cliOptions.depth, '--depth'),
    maxPages: positiveInt(cliOptions.maxPages, '--max-pages', { min: 1 }),
    sameDomainOnly: !cliOptions.allDomains,
    includePatterns: compilePatterns(cliOptions.include, '--include'),
    excludePatterns: compilePatterns(cliOptions.exclude, '--exclude'),

    delayMs: positiveInt(cliOptions.delay, '--delay'),
    concurrency: positiveInt(cliOptions.concurrency, '--concurrency', { min: 1 }),
    timeoutMs: positiveInt(cliOptions.timeout, '--timeout', { min: 1000 }),
    followRedirects: cliOptions.followRedirects !== false,

    // --sitemap <url> yields a string, --no-sitemap yields false,
    // and omitting both leaves undefined (= enabled, auto-discover).
    sitemapEnabled: cliOptions.sitemap !== false,
    sitemapUrl: typeof cliOptions.sitemap === 'string' ? cliOptions.sitemap : null,

    overwrite: Boolean(cliOptions.overwrite),
    resume: Boolean(cliOptions.resume),
    respectRobots: Boolean(cliOptions.respectRobots),
    rawFallback: Boolean(cliOptions.rawFallback),
    dryRun: Boolean(cliOptions.dryRun),

    userAgent: cliOptions.userAgent || env.USER_AGENT || DEFAULT_USER_AGENT,
    maxRetries: positiveInt(env.MAX_RETRIES ?? 3, 'MAX_RETRIES'),
    retryDelayMs: positiveInt(env.RETRY_DELAY_MS ?? 1000, 'RETRY_DELAY_MS'),

    singlefile: {
      executablePath: env.SINGLEFILE_PATH || null,
      extraArgs: (env.SINGLEFILE_ARGS || '').split(/\s+/).filter(Boolean),
      browserExecutablePath: env.BROWSER_EXECUTABLE_PATH || null,
    },

    logLevel: cliOptions.verbose ? 'debug' : cliOptions.quiet ? 'warn' : 'info',
    reportFile: cliOptions.report || null,
  };

  return Object.freeze(config);
}

module.exports = { buildConfig, DEFAULT_USER_AGENT };
