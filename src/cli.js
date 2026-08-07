'use strict';

const { Command, Option } = require('commander');
const { buildConfig } = require('./config');
const { Crawler } = require('./crawler');
const pkg = require('../package.json');

/** Collect repeatable flags (--include a --include b) into an array. */
const collect = (value, previous) => [...previous, value];

function createProgram() {
  const program = new Command();

  program
    .name('site-archiver')
    .description(
      'Crawl a website and archive every discovered page as a standalone HTML file using SingleFile.'
    )
    .version(pkg.version)
    .argument('<url>', 'start URL of the website to crawl')
    .option('-d, --depth <n>', 'maximum crawl depth (0 = start page only)', '3')
    .option('-p, --max-pages <n>', 'maximum number of pages to process', '100')
    .option('--all-domains', 'follow links to external domains (default: same domain only)')
    .option(
      '--include <regex>',
      'only crawl URLs matching this pattern (repeatable)',
      collect,
      []
    )
    .option(
      '--exclude <regex>',
      'never crawl URLs matching this pattern (repeatable, wins over --include)',
      collect,
      []
    )
    .option('--delay <ms>', 'minimum delay between requests to the site', '500')
    .option('-c, --concurrency <n>', 'number of pages processed in parallel', '2')
    .option('-t, --timeout <ms>', 'per-request / per-page timeout', '30000')
    .option('--no-follow-redirects', 'do not follow HTTP redirects')
    .option('--overwrite', 'overwrite files that already exist in the output folder')
    .option('--resume', 'resume an interrupted crawl of the same start URL')
    .option('--respect-robots', 'honor robots.txt disallow rules (off by default)')
    .option('--raw-fallback', 'save the raw fetched HTML when SingleFile fails on a page')
    .option('--dry-run', 'crawl and report without archiving any pages')
    .option('-o, --output <dir>', 'base output directory (overrides OUTPUT_FOLDER from .env)')
    .option('--user-agent <ua>', 'User-Agent header for discovery requests and SingleFile')
    .option('--report <file>', 'write the JSON crawl report to this exact path')
    .addOption(new Option('-q, --quiet', 'only log warnings and errors').conflicts('verbose'))
    .addOption(new Option('-v, --verbose', 'enable debug logging').conflicts('quiet'))
    .showHelpAfterError();

  return program;
}

/** Parse argv, run the crawl, and resolve with the built report. */
async function run(argv) {
  const program = createProgram();
  program.parse(argv);

  const config = buildConfig(program.args[0], program.opts());
  const crawler = new Crawler(config);

  // First Ctrl+C: graceful stop (finish in-flight pages, save resume state).
  // Second Ctrl+C: hard exit.
  let interrupts = 0;
  const onInterrupt = () => {
    interrupts++;
    if (interrupts === 1) {
      crawler.abort();
    } else {
      process.stderr.write('\nForced exit without saving.\n');
      process.exit(130);
    }
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    return await crawler.run();
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
}

module.exports = { run, createProgram };
