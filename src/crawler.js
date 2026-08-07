'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { Logger } = require('./logger');
const { CrawlQueue } = require('./queue');
const { RateLimiter } = require('./rateLimiter');
const { RobotsCache } = require('./robots');
const { CrawlReport } = require('./report');
const { CrawlState } = require('./state');
const { fetchPage } = require('./fetcher');
const { extractPageData } = require('./extractor');
const { loadSitemapEntries, sortByPriority } = require('./sitemap');
const { savePage } = require('./singlefile');
const { normalizeUrl, checkScope, isSameDomain } = require('./utils/url');
const { urlToFilePath, siteDir } = require('./utils/paths');
const { sleep, formatDuration } = require('./utils/misc');

const STATE_SAVE_INTERVAL = 10; // pages between periodic state saves

/**
 * Crawl orchestrator. Owns the frontier, the worker pool and the lifecycle
 * (resume -> crawl -> report). Every page-level failure is contained: a bad
 * URL is recorded and the crawl moves on.
 *
 * Two requests are made per page by design: a lightweight discovery fetch
 * (status + link extraction) and SingleFile's browser-based load for the
 * archive itself. Both go through the shared politeness rate limiter.
 */
class Crawler {
  constructor(config) {
    this.config = config;
    this.logger = new Logger(config.logLevel);

    this.startUrl = normalizeUrl(config.startUrl);
    if (!this.startUrl) {
      throw new Error(`Invalid start URL: "${config.startUrl}" (must be http(s))`);
    }

    this.siteDirectory = siteDir(this.startUrl, config.outputFolder);
    this.queue = new CrawlQueue();
    this.report = new CrawlReport(config);
    this.state = new CrawlState(this.siteDirectory);
    this.rateLimiter = new RateLimiter(config.delayMs);
    this.robots = config.respectRobots
      ? new RobotsCache({
          userAgent: config.userAgent,
          timeoutMs: config.timeoutMs,
          logger: this.logger,
        })
      : null;

    this.scope = {
      startUrl: this.startUrl,
      sameDomainOnly: config.sameDomainOnly,
      includePatterns: config.includePatterns,
      excludePatterns: config.excludePatterns,
    };

    this.processedCount = 0; // pages that consumed a --max-pages slot
    this.activeCount = 0;
    this.aborted = false;
    this._sinceLastSave = 0;
    // filePath -> url, so two URL forms of the same page (e.g. "/" and
    // "/index.html") can never silently overwrite each other's archive.
    this._claimedFiles = new Map();
  }

  /** Request a graceful stop: workers finish their current page, then exit. */
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.report.interrupted = true;
    this.logger.warn('Abort requested - finishing in-flight pages and saving state...');
  }

  async run() {
    const { config, logger } = this;
    const startedAt = Date.now();

    await this._initializeFrontier();

    logger.info(
      `Crawling ${this.startUrl} -> ${this.siteDirectory} ` +
        `(depth<=${config.maxDepth}, pages<=${config.maxPages}, ` +
        `concurrency=${config.concurrency}, delay=${config.delayMs}ms` +
        `${config.dryRun ? ', DRY RUN' : ''})`
    );

    const workers = Array.from({ length: config.concurrency }, () => this._worker());
    await Promise.all(workers);

    return this._finalize(startedAt);
  }

  async _initializeFrontier() {
    const previous = this.config.resume ? this.state.load(this.startUrl) : null;
    if (previous) {
      this.queue = CrawlQueue.fromJSON(previous.queue);
      this.report.restore(previous.stats);
      this.processedCount = previous.processedCount || 0;
      for (const page of this.report.pages) {
        if (page.file) {
          this._claimedFiles.set(path.join(this.config.outputFolder, page.file), page.url);
        }
      }
      this.logger.info(
        `Resuming crawl saved at ${previous.savedAt}: ` +
          `${this.queue.pendingCount} pending, ${this.queue.visited.size} visited, ` +
          `${this.report.pages.length} already downloaded ` +
          '(sitemap URLs are already part of the saved queue)'
      );
      return;
    }

    if (this.config.resume) {
      this.logger.info('No resumable state found - starting a fresh crawl');
    }
    this.queue.add(this.startUrl, 0);
    if (this.config.sitemapEnabled) await this._seedFromSitemap();
  }

  /**
   * Seed the frontier from sitemap.xml: sitemap URLs are enqueued (highest
   * <priority> first) ahead of any link-discovered URLs and enter at depth 0,
   * i.e. they are treated as first-class seeds just like the start URL.
   * Best-effort: a missing sitemap simply leaves plain link discovery.
   */
  async _seedFromSitemap() {
    const { logger, report } = this;
    let entries;
    let sources;
    try {
      ({ entries, sources } = await loadSitemapEntries(this.startUrl, this.config, logger));
    } catch (error) {
      logger.warn(`Sitemap loading failed (${error.message}) - continuing without it`);
      report.recordError(`sitemap loading failed: ${error.message}`);
      return;
    }

    if (sources.length === 0) {
      logger.info('No sitemap found - crawling via link discovery only');
      report.sitemapInfo = { found: false, sources: [], urlCount: 0, seeded: 0 };
      return;
    }

    this._saveSitemapCopies(sources);

    let seeded = 0;
    for (const entry of sortByPriority(entries)) {
      const normalized = normalizeUrl(entry.loc, this.startUrl);
      if (!normalized || this.queue.hasVisited(normalized)) continue;
      const scope = checkScope(normalized, this.scope);
      if (!scope.allowed) {
        report.recordSkipped(normalized, `sitemap-out-of-scope:${scope.reason}`);
        continue;
      }
      if (this.queue.add(normalized, 0)) seeded++;
    }

    report.sitemapInfo = {
      found: true,
      sources: sources.map((s) => s.url),
      urlCount: entries.length,
      seeded,
    };
    logger.info(
      `Sitemap: seeded ${seeded} URL(s) by priority from ${sources.length} sitemap file(s) ` +
        `(${entries.length} listed)`
    );
  }

  /** Archive the fetched sitemap documents under .reports/sitemaps/. */
  _saveSitemapCopies(sources) {
    const dir = path.join(this.siteDirectory, '.reports', 'sitemaps');
    try {
      fs.mkdirSync(dir, { recursive: true });
      sources.forEach(({ url, xml }, index) => {
        const base = path.basename(new URL(url).pathname) || 'sitemap.xml';
        const name = `${String(index + 1).padStart(2, '0')}-${base.replace(/\.gz$/i, '')}`;
        fs.writeFileSync(path.join(dir, name), xml);
      });
      this.logger.debug(`Saved ${sources.length} sitemap copy(ies) to ${dir}`);
    } catch (error) {
      this.report.recordError(`could not save sitemap copies: ${error.message}`);
      this.logger.warn(`Could not save sitemap copies: ${error.message}`);
    }
  }

  async _worker() {
    while (!this.aborted) {
      if (this.processedCount >= this.config.maxPages) break;

      const item = this.queue.next();
      if (!item) {
        if (this.activeCount === 0) break; // frontier drained, nothing in flight
        await sleep(100); // another worker may still discover links
        continue;
      }

      // The URL may have become an alias (redirect/canonical target) of a
      // page processed after this one was enqueued.
      if (this.queue.hasVisited(item.url)) {
        this.report.recordSkipped(item.url, 'already-visited-alias');
        continue;
      }

      this.activeCount++;
      this.processedCount++; // reserve the slot up-front so maxPages is never overshot
      try {
        await this._processPage(item);
      } catch (error) {
        this.logger.error(`Unexpected error on ${item.url}: ${error.stack || error}`);
        this.report.recordFailed({
          url: item.url,
          error: `internal: ${error.message}`,
          stage: 'internal',
        });
      } finally {
        this.queue.markVisited(item.url);
        this.activeCount--;
        this._maybePersistState();
      }
    }
  }

  async _processPage({ url, depth }) {
    const { config, logger, report } = this;

    if (this.robots && !(await this.robots.isAllowed(url))) {
      this.processedCount--; // robots skips should not consume --max-pages slots
      report.recordSkipped(url, 'robots-disallowed');
      logger.debug(`robots disallowed: ${url}`);
      return;
    }

    await this.rateLimiter.acquire();
    const result = await fetchPage(url, {
      timeoutMs: config.timeoutMs,
      followRedirects: config.followRedirects,
      userAgent: config.userAgent,
      maxRetries: config.maxRetries,
      retryDelayMs: config.retryDelayMs,
      onRetry: ({ attempt, wait, reason }) => {
        // Slow every worker down, not just this one - rate limiting is per site.
        this.rateLimiter.backOff(wait);
        logger.warn(`retry ${attempt}/${config.maxRetries} in ${wait}ms (${reason}): ${url}`);
      },
    });

    if (!result.ok) {
      if (result.redirected && !config.followRedirects) {
        report.recordSkipped(url, `redirect-not-followed:${result.status}`);
        logger.info(`skip (redirect ${result.status}, not followed): ${url}`);
      } else {
        report.recordFailed({
          url,
          error: result.error,
          attempts: result.attempts,
          stage: 'fetch',
        });
        logger.warn(`fetch failed (${result.error}) after ${result.attempts} attempt(s): ${url}`);
      }
      return;
    }

    // A followed redirect may land on a different page entirely.
    let effectiveUrl = url;
    if (result.finalUrl && result.finalUrl !== url) {
      if (this.queue.hasVisited(result.finalUrl)) {
        report.recordSkipped(url, 'redirect-target-already-visited');
        return;
      }
      const scope = checkScope(result.finalUrl, this.scope);
      if (!scope.allowed) {
        report.recordSkipped(url, `redirect-out-of-scope:${scope.reason}`);
        return;
      }
      this.queue.markVisited(result.finalUrl);
      effectiveUrl = result.finalUrl;
    }

    if (result.html === null) {
      report.recordSkipped(url, `non-html:${result.contentType || 'unknown'}`);
      logger.debug(`skip (non-HTML ${result.contentType}): ${url}`);
      return;
    }

    const { links, canonical, title } = extractPageData(result.html, effectiveUrl);

    // Canonical de-duplication: if the page declares a canonical URL that was
    // already handled, this is duplicate content - skip it. Otherwise mark the
    // canonical form visited so the same content is never downloaded twice.
    if (canonical && canonical !== effectiveUrl) {
      if (this.queue.hasVisited(canonical)) {
        report.recordSkipped(url, 'duplicate-canonical');
        logger.debug(`skip (canonical ${canonical} already visited): ${url}`);
        return;
      }
      if (isSameDomain(canonical, effectiveUrl)) {
        this.queue.markVisited(canonical);
      }
    }

    this._enqueueLinks(links, depth);
    await this._downloadPage(effectiveUrl, { depth, status: result.status, title, sourceUrl: url });
  }

  _enqueueLinks(links, depth) {
    if (depth >= this.config.maxDepth) return;
    for (const link of links) {
      if (this.queue.hasVisited(link) || this.queue.known.has(link)) continue;
      const scope = checkScope(link, this.scope);
      if (!scope.allowed) {
        this.report.recordSkipped(link, `out-of-scope:${scope.reason}`);
        continue;
      }
      this.queue.add(link, depth + 1);
    }
  }

  async _downloadPage(url, { depth, status, title, sourceUrl }) {
    const { config, logger, report } = this;
    const progress = `[${this.processedCount}/${config.maxPages}]`;

    if (config.dryRun) {
      report.recordDownloaded({ url, file: null, status, depth, title, dryRun: true });
      logger.info(`${progress} depth=${depth} ${status} ${url} (dry run)`);
      return;
    }

    const filePath = urlToFilePath(url, config.outputFolder);
    const relativePath = path.relative(config.outputFolder, filePath);

    const claimedBy = this._claimedFiles.get(filePath);
    if (claimedBy && claimedBy !== url) {
      report.recordSkipped(url, 'duplicate-file-path');
      logger.debug(`skip (same file as ${claimedBy}): ${url}`);
      return;
    }
    this._claimedFiles.set(filePath, url);

    if (!config.overwrite && fs.existsSync(filePath)) {
      report.recordSkipped(url, 'file-exists');
      logger.info(`${progress} depth=${depth} exists, skipped: ${relativePath}`);
      return;
    }

    // SingleFile drives a real browser and can fail transiently (first
    // launch, page wedging) - give each page one retry before falling back.
    let saved;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await this.rateLimiter.acquire(); // SingleFile loads the page again
      saved = await savePage(url, filePath, config);
      if (saved.ok) break;
      if (attempt === 1) logger.debug(`SingleFile retry (${saved.error}): ${url}`);
    }

    if (saved.ok) {
      report.recordDownloaded({
        url,
        file: relativePath,
        status,
        depth,
        title,
        durationMs: saved.durationMs,
      });
      logger.info(
        `${progress} depth=${depth} ${status} ${url} -> ${relativePath} ` +
          `(${formatDuration(saved.durationMs)})`
      );
      return;
    }

    if (config.rawFallback) {
      try {
        const result = await fetchPage(url, {
          timeoutMs: config.timeoutMs,
          followRedirects: true,
          userAgent: config.userAgent,
          maxRetries: 0,
          retryDelayMs: 0,
        });
        if (result.ok && result.html !== null) {
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          await fs.promises.writeFile(filePath, result.html);
          report.recordDownloaded({
            url,
            file: relativePath,
            status,
            depth,
            title,
            rawFallback: true,
          });
          logger.warn(
            `${progress} SingleFile failed (${saved.error}); saved raw HTML: ${relativePath}`
          );
          return;
        }
      } catch {
        /* fall through to failure record */
      }
    }

    report.recordFailed({ url: sourceUrl, error: saved.error, stage: 'singlefile' });
    logger.warn(`${progress} archive failed: ${url} -> ${saved.error}`);
  }

  _maybePersistState() {
    this._sinceLastSave++;
    if (this._sinceLastSave < STATE_SAVE_INTERVAL) return;
    this._sinceLastSave = 0;
    this._persistState();
  }

  _persistState() {
    try {
      this.state.save({
        startUrl: this.startUrl,
        queue: this.queue,
        stats: this.report.statsSnapshot(),
        processedCount: this.processedCount,
      });
    } catch (error) {
      this.report.recordError(`state save failed: ${error.message}`);
      this.logger.warn(`Could not save crawl state: ${error.message}`);
    }
  }

  _finalize(startedAt) {
    const { logger, report } = this;

    // The crawl is unfinished when it was aborted or cut off by --max-pages
    // with URLs still pending. Persist state first (so a resume re-processes
    // the pending URLs), then record them as skipped in this run's report.
    const unfinished = this.aborted || this.queue.pendingCount > 0;
    if (unfinished) {
      this._persistState();
      logger.info(
        this.aborted
          ? 'State saved - rerun with --resume to continue this crawl.'
          : `Reached --max-pages with ${this.queue.pendingCount} URL(s) pending - ` +
            'rerun with --resume and a higher --max-pages to continue.'
      );
    } else {
      this.state.clear();
    }

    const cutoff = this.aborted ? 'interrupted' : 'max-pages-reached';
    for (const item of this.queue.pending) report.recordSkipped(item.url, cutoff);

    const builtReport = report.build(this.queue.discoveredCount);
    let reportFile = null;
    let archiveSitemapFile = null;
    try {
      reportFile = report.write(builtReport, this.siteDirectory);
    } catch (error) {
      logger.error(`Could not write report file: ${error.message}`);
    }
    try {
      archiveSitemapFile = report.writeArchiveSitemap(builtReport, this.siteDirectory);
    } catch (error) {
      logger.error(`Could not write archive sitemap: ${error.message}`);
    }
    process.stdout.write(report.summary(builtReport, reportFile, archiveSitemapFile));
    logger.debug(`Total wall time: ${formatDuration(Date.now() - startedAt)}`);

    return builtReport;
  }
}

module.exports = { Crawler };
