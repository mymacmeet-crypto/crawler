# site-archiver

Production-ready Node.js CLI website crawler that archives every discovered
page as a **complete standalone HTML file** using the
[SingleFile CLI](https://github.com/gildas-lormeau/single-file-cli). Styles,
images and fonts are inlined, so each saved page opens offline exactly as it
looked online.

```
node bin/crawl.js https://example.com --depth 2 --max-pages 50
```

## Requirements

- Node.js >= 18.17 (built-in `fetch` is used for discovery requests)
- A Chromium-based browser (Chrome, Edge, Chromium or Brave). SingleFile
  auto-detects an installed browser; set `BROWSER_EXECUTABLE_PATH` in `.env`
  to pin a specific one.

## Install

```bash
npm install
cp .env.example .env   # then adjust OUTPUT_FOLDER
```

Optionally `npm link` to get a global `site-archiver` command.

## Configuration (.env)

| Variable | Default | Purpose |
| --- | --- | --- |
| `OUTPUT_FOLDER` | `./archive` | Base directory for all archived sites |
| `USER_AGENT` | built-in UA | User-Agent for discovery requests, robots.txt and SingleFile |
| `SINGLEFILE_PATH` | auto-resolved | Explicit path to a SingleFile CLI executable/script |
| `SINGLEFILE_ARGS` | — | Extra arguments appended to every SingleFile call |
| `BROWSER_EXECUTABLE_PATH` | auto-detected | Browser binary SingleFile should drive |
| `MAX_RETRIES` | `3` | Retries per discovery request (network errors, 429/5xx) |
| `RETRY_DELAY_MS` | `1000` | Base delay for exponential retry backoff |

CLI flags always win over `.env` values, which win over built-in defaults.

## CLI options

```
site-archiver [options] <url>

-d, --depth <n>          maximum link depth from seed pages          [3]
                         (0 = seeds only: start URL + sitemap URLs)
-p, --max-pages <n>      maximum number of pages to process          [100]
--sitemap <url>          seed from this sitemap URL instead of auto-discovery
--no-sitemap             disable sitemap seeding (link discovery only)
--all-domains            follow links to external domains (default: same domain only,
                         www.example.com and example.com count as the same domain)
--include <regex>        only crawl URLs matching this pattern (repeatable)
--exclude <regex>        never crawl URLs matching this pattern (repeatable, wins over include)
--delay <ms>             minimum delay between any two requests to the site [500]
-c, --concurrency <n>    pages processed in parallel                 [2]
-t, --timeout <ms>       per-request / per-page-load timeout         [30000]
--no-follow-redirects    treat HTTP redirects as skips instead of following them
--overwrite              re-download pages whose files already exist
--resume                 resume an interrupted or page-capped crawl
--respect-robots         honor robots.txt disallow rules (off unless requested)
--raw-fallback           save raw fetched HTML when SingleFile fails on a page
--dry-run                crawl, discover and report without archiving anything
-o, --output <dir>       base output directory (overrides OUTPUT_FOLDER)
--user-agent <ua>        override the User-Agent header
--report <file>          exact path for the JSON crawl report
-q, --quiet / -v, --verbose
```

### Examples

```bash
# Archive a blog two levels deep, at most 40 pages, politely
node bin/crawl.js https://blog.example.com -d 2 -p 40 --delay 1000 --respect-robots

# Only the docs section, skipping printable views
node bin/crawl.js https://example.com/docs --include "/docs/" --exclude "\?print="

# Faster crawl of a site you own
node bin/crawl.js https://my-site.dev -c 6 --delay 100 --overwrite

# Interrupted with Ctrl+C, or hit --max-pages? Continue where it stopped:
node bin/crawl.js https://blog.example.com --resume -p 200
```

## Output layout

Files mirror the site's URL structure under `OUTPUT_FOLDER/<host>/`:

```
archive/
└── example.com/
    ├── index.html                  # https://example.com/
    ├── about.html                  # https://example.com/about
    ├── blog/
    │   ├── post-1.html             # https://example.com/blog/post-1
    │   └── list_q_page-2.html      # https://example.com/blog/list?page=2
    ├── .crawl-state.json           # resume state (only while unfinished)
    └── .reports/
        ├── crawl-report-<timestamp>.json
        ├── sitemap.xml             # generated: pages actually archived
        └── sitemaps/               # copies of the site's original sitemaps
            ├── 01-sitemap-index.xml
            └── 02-sitemap-pages.xml
```

Filenames are sanitized for Windows/macOS/Linux (illegal characters, reserved
device names, trailing dots). Over-long segments and query strings are
truncated with a short content hash so distinct URLs can never collide
silently. Site paths can never clash with the crawler's own dotfiles because
leading dots are stripped during sanitization.

## Crawl behaviour

- **Sitemap-first crawling** (default) — before link discovery starts, the
  crawler locates the site's sitemap (an explicit `--sitemap <url>`, else
  `Sitemap:` directives in robots.txt, else `<origin>/sitemap.xml`), follows
  sitemap-index files, decompresses `.gz` sitemaps, and enqueues all in-scope
  URLs sorted by their `<priority>` value (highest first, default 0.5) ahead
  of any link-discovered URLs. Sitemap URLs enter at depth 0 - they are seeds
  like the start URL. Copies of every fetched sitemap land in
  `.reports/sitemaps/`, and a missing sitemap simply falls back to plain link
  discovery. Disable with `--no-sitemap`. Traversal is capped at 50 sitemap
  files / 50,000 URLs.
- **Normalization & de-duplication** — every URL is normalized (fragment
  stripped, host lowercased, default ports removed, duplicate slashes
  collapsed, trailing slash trimmed, query keys sorted) before it is queued,
  so each page is fetched at most once.
- **Canonical URLs** — if a page declares `<link rel="canonical">` pointing at
  an already-visited URL it is skipped as duplicate content; otherwise the
  canonical form is marked visited so the same content is never saved twice.
- **Redirects** — followed by default; the redirect *target* is scope-checked
  and de-duplicated. With `--no-follow-redirects` redirected URLs are recorded
  as skips with their status code.
- **Error containment** — network failures, timeouts, HTTP errors and
  SingleFile crashes are retried (exponential backoff, `Retry-After` honored,
  a 429 slows *all* workers down), then recorded as failures; the crawl always
  continues.
- **Resume** — state (`.crawl-state.json`) is saved atomically every few pages
  and on Ctrl+C. `--resume` with the same start URL and output folder picks up
  the pending queue, visited set and counters. The state file is removed once
  a crawl truly finishes. Press Ctrl+C twice to force-quit without saving.
- **robots.txt** — only consulted with `--respect-robots` (per-origin cache;
  unreachable robots files fail open). Pages denied by robots do not consume
  `--max-pages` slots.
- **Two requests per page** — a lightweight `fetch` for status + link
  extraction, then SingleFile's real browser load for the archive. Both go
  through the shared rate limiter, so `--delay` bounds total request pressure
  on the site.

## Crawl report

Each run writes a JSON report (and prints a summary) containing: start URL,
effective options, timestamps and duration, sitemap info (sources found, URL
count, seeded count), totals (URLs discovered, pages downloaded, skipped,
failed), skip counts by reason, the full list of downloaded pages (URL →
file, HTTP status, depth, title, archive time), skipped URLs with reasons
(detail capped at 5000 entries; counts always complete), failed URLs with
error and attempt count, and any crawl-level errors.

Alongside the JSON report, `.reports/sitemap.xml` is generated listing every
page archived in the crawl (an index of the archive), and
`.reports/sitemaps/` holds verbatim copies of the site's own sitemap files.

Exit codes: `0` success, `1` fatal setup error (bad arguments, invalid URL),
`2` nothing archived and at least one failure, `130` interrupted.

## Architecture

```
bin/crawl.js          thin entry point, exit-code mapping
src/cli.js            commander definition, signal handling
src/config.js         .env + CLI merge, validation, frozen config object
src/crawler.js        orchestrator: worker pool, per-page pipeline, lifecycle
src/queue.js          FIFO frontier + visited/known tracking (serializable)
src/fetcher.js        discovery fetch: retries, backoff, redirects, Retry-After
src/extractor.js      cheerio link/canonical/title extraction (base-href aware)
src/sitemap.js        sitemap discovery, index recursion, .gz support, priority sort
src/singlefile.js     SingleFile CLI resolution + hardened spawn wrapper
src/robots.js         opt-in per-origin robots.txt cache (fails open)
src/rateLimiter.js    global politeness limiter shared by all workers
src/state.js          atomic resume-state persistence
src/report.js         outcome collection, JSON report, console summary
src/utils/url.js      normalization, scope rules, non-HTML detection
src/utils/paths.js    URL → sanitized file path mapping
src/logger.js         dependency-free leveled logger
```

Every page-level concern is behind a small module with a narrow interface,
which is where future features slot in:

- **Authentication** — add headers/cookies in `fetcher.js` and pass
  `--browser-cookie`/`--http-header` through `singlefile.js`.
- **JavaScript-rendered discovery** — swap `fetcher.js` for a browser-based
  fetch (SingleFile already renders JS for the archive itself).
- **Incremental crawling** — compare against the previous report in
  `_downloadPage` (e.g. ETag/Last-Modified via a HEAD request) before saving.
- **Different logger/storage** — `logger.js` and `paths.js` are drop-in
  replaceable.

## Testing

```bash
npm test   # node:test unit suite for URL normalization, path mapping, queue, extractor
```
