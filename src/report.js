'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { formatDuration } = require('./utils/misc');

// Full skipped-URL details are capped so a crawl of a heavily linked site
// cannot balloon the report; counts per reason always cover everything.
const MAX_SKIPPED_DETAIL = 5000;

/**
 * Collects per-page outcomes during the crawl and renders them as a JSON
 * report file plus a human-readable console summary.
 */
class CrawlReport {
  constructor(config) {
    this.config = config;
    this.startedAt = new Date();
    this.pages = [];          // { url, file, status, depth, title, durationMs }
    this.skipped = [];        // { url, reason } - capped detail list
    this.skippedCounts = {};  // reason -> count - always complete
    this.skippedOverflow = 0;
    this.failed = [];         // { url, error, attempts, stage }
    this.errors = [];         // crawl-level errors (state save failures, ...)
    this.interrupted = false;
    this._seenSkips = new Set();
  }

  recordDownloaded(page) {
    this.pages.push(page);
  }

  recordSkipped(url, reason) {
    if (this._seenSkips.has(url)) return;
    this._seenSkips.add(url);
    this.skippedCounts[reason] = (this.skippedCounts[reason] || 0) + 1;
    if (this.skipped.length < MAX_SKIPPED_DETAIL) this.skipped.push({ url, reason });
    else this.skippedOverflow++;
  }

  recordFailed(entry) {
    this.failed.push(entry);
  }

  recordError(message) {
    this.errors.push(message);
  }

  /** Restore counters from a resumed crawl's saved state. */
  restore(stats) {
    if (!stats) return;
    this.pages = stats.pages || [];
    this.skipped = stats.skipped || [];
    this.skippedCounts = stats.skippedCounts || {};
    this.skippedOverflow = stats.skippedOverflow || 0;
    this.failed = stats.failed || [];
    this.errors = stats.errors || [];
    this._seenSkips = new Set(this.skipped.map((s) => s.url));
  }

  /** Serializable snapshot stored inside the resume state file. */
  statsSnapshot() {
    return {
      pages: this.pages,
      skipped: this.skipped,
      skippedCounts: this.skippedCounts,
      skippedOverflow: this.skippedOverflow,
      failed: this.failed,
      errors: this.errors,
    };
  }

  build(discoveredCount) {
    const finishedAt = new Date();
    const skippedTotal = Object.values(this.skippedCounts).reduce((a, b) => a + b, 0);

    return {
      startUrl: this.config.startUrl,
      outputFolder: this.config.outputFolder,
      interrupted: this.interrupted,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - this.startedAt,
      options: {
        maxDepth: this.config.maxDepth,
        maxPages: this.config.maxPages,
        sameDomainOnly: this.config.sameDomainOnly,
        include: this.config.includePatterns.map((p) => p.source),
        exclude: this.config.excludePatterns.map((p) => p.source),
        delayMs: this.config.delayMs,
        concurrency: this.config.concurrency,
        timeoutMs: this.config.timeoutMs,
        followRedirects: this.config.followRedirects,
        respectRobots: this.config.respectRobots,
        overwrite: this.config.overwrite,
        dryRun: this.config.dryRun,
      },
      totals: {
        discovered: discoveredCount,
        downloaded: this.pages.length,
        skipped: skippedTotal,
        failed: this.failed.length,
      },
      skippedByReason: this.skippedCounts,
      downloadedPages: this.pages,
      skippedUrls: this.skipped,
      skippedUrlsTruncated: this.skippedOverflow,
      failedUrls: this.failed,
      errors: this.errors,
    };
  }

  /** Write the JSON report; returns the file path. */
  write(report, siteDirectory) {
    const file =
      this.config.reportFile ||
      path.join(
        siteDirectory,
        '.reports',
        `crawl-report-${report.finishedAt.replace(/[:.]/g, '-')}.json`
      );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    return file;
  }

  /** Render the console summary. */
  summary(report, reportFile) {
    const t = report.totals;
    const lines = [
      '',
      `Crawl ${report.interrupted ? 'INTERRUPTED' : 'finished'}: ${report.startUrl}`,
      `  Duration:          ${formatDuration(report.durationMs)}`,
      `  URLs discovered:   ${t.discovered}`,
      `  Pages downloaded:  ${t.downloaded}`,
      `  Skipped:           ${t.skipped}${
        t.skipped
          ? ` (${Object.entries(report.skippedByReason)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => `${reason}: ${count}`)
              .join(', ')})`
          : ''
      }`,
      `  Failed:            ${t.failed}`,
    ];
    if (report.failedUrls.length > 0) {
      lines.push('  Failures:');
      for (const failure of report.failedUrls.slice(0, 10)) {
        lines.push(`    - ${failure.url} -> ${failure.error}`);
      }
      if (report.failedUrls.length > 10) {
        lines.push(`    ... and ${report.failedUrls.length - 10} more (see report)`);
      }
    }
    if (report.interrupted) {
      lines.push('  Resume with:       --resume');
    }
    if (reportFile) lines.push(`  Report:            ${reportFile}`);
    lines.push('');
    return lines.join('\n');
  }
}

module.exports = { CrawlReport };
