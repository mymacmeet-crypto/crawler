'use strict';

const path = require('node:path');
const { shortHash } = require('./misc');

/**
 * Mapping of URLs to filesystem paths that mirrors the site structure:
 *
 *   https://example.com/            -> <out>/example.com/index.html
 *   https://example.com/about       -> <out>/example.com/about.html
 *   https://example.com/blog/post-1 -> <out>/example.com/blog/post-1.html
 *   https://example.com/p?page=2    -> <out>/example.com/p_q_page-2.html
 *
 * Filenames are sanitized for cross-platform (notably Windows) safety and
 * length-limited; anything truncated gets a short hash suffix so distinct
 * URLs never collide silently.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_SEGMENT_LENGTH = 80;

/** Make a single path segment safe on Windows/macOS/Linux filesystems. */
function sanitizeSegment(segment) {
  let clean = segment
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // Leading dots are stripped so site paths can never collide with the
    // crawler's own dotfiles (.crawl-state.json, .reports/).
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (!clean) clean = '_';
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  if (clean.length > MAX_SEGMENT_LENGTH) {
    clean = `${clean.slice(0, MAX_SEGMENT_LENGTH)}-${shortHash(segment)}`;
  }
  return clean;
}

function decodeSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Compact readable token for a query string, hash-suffixed when truncated. */
function querySuffix(search) {
  const raw = search.replace(/^\?/, '');
  if (!raw) return '';
  let token = decodeSafe(raw).replace(/=/g, '-').replace(/&/g, '_');
  token = sanitizeSegment(token);
  if (token.length > 48) token = `${token.slice(0, 48)}-${shortHash(raw)}`;
  return `_q_${token}`;
}

/**
 * Map a normalized URL to an absolute file path below `baseDir`.
 * The first path level is always the host so multiple sites can share one
 * output folder without mixing files.
 */
function urlToFilePath(url, baseDir) {
  const u = new URL(url);
  const host = sanitizeSegment(u.hostname + (u.port ? `_${u.port}` : ''));

  const segments = u.pathname.split('/').filter(Boolean).map((s) => sanitizeSegment(decodeSafe(s)));

  let fileName;
  if (segments.length === 0) {
    fileName = 'index';
  } else {
    fileName = segments.pop().replace(/\.(html?|xhtml)$/i, '');
  }
  fileName = `${fileName}${querySuffix(u.search)}.html`;

  return path.join(baseDir, host, ...segments, fileName);
}

/** Directory that holds everything belonging to one archived site. */
function siteDir(startUrl, baseDir) {
  const u = new URL(startUrl);
  return path.join(baseDir, sanitizeSegment(u.hostname + (u.port ? `_${u.port}` : '')));
}

module.exports = { urlToFilePath, sanitizeSegment, siteDir };
