'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { urlToFilePath, sanitizeSegment } = require('../src/utils/paths');

const BASE = path.resolve('out');
const rel = (p) => path.relative(BASE, p).split(path.sep).join('/');

test('root URL maps to host/index.html', () => {
  assert.equal(rel(urlToFilePath('https://example.com/', BASE)), 'example.com/index.html');
});

test('paths mirror the URL structure', () => {
  assert.equal(
    rel(urlToFilePath('https://example.com/blog/post-1', BASE)),
    'example.com/blog/post-1.html'
  );
});

test('.html extension is not duplicated', () => {
  assert.equal(
    rel(urlToFilePath('https://example.com/docs/intro.html', BASE)),
    'example.com/docs/intro.html'
  );
});

test('sibling page and directory do not collide', () => {
  const page = rel(urlToFilePath('https://example.com/about', BASE));
  const child = rel(urlToFilePath('https://example.com/about/team', BASE));
  assert.equal(page, 'example.com/about.html');
  assert.equal(child, 'example.com/about/team.html');
});

test('query strings produce distinct readable filenames', () => {
  const p1 = rel(urlToFilePath('https://example.com/list?page=2', BASE));
  const p2 = rel(urlToFilePath('https://example.com/list?page=3', BASE));
  assert.equal(p1, 'example.com/list_q_page-2.html');
  assert.notEqual(p1, p2);
});

test('non-default port is encoded in the host folder', () => {
  assert.equal(
    rel(urlToFilePath('http://localhost:8080/x', BASE)),
    'localhost_8080/x.html'
  );
});

test('sanitizeSegment neutralizes Windows-illegal names', () => {
  assert.equal(sanitizeSegment('a<b>:c|d?e*f'), 'a-b--c-d-e-f');
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment('trailing dot.'), 'trailing dot');
  assert.equal(sanitizeSegment('...hidden'), 'hidden');
  assert.equal(sanitizeSegment(''), '_');
});

test('overlong segments are truncated with a stable hash suffix', () => {
  const long = 'x'.repeat(300);
  const a = sanitizeSegment(long);
  const b = sanitizeSegment(long);
  assert.equal(a, b);
  assert.ok(a.length <= 100);
  const other = sanitizeSegment('x'.repeat(299) + 'y');
  assert.notEqual(a, other);
});

test('long query strings stay bounded but unique', () => {
  const q1 = rel(urlToFilePath(`https://example.com/s?query=${'a'.repeat(200)}`, BASE));
  const q2 = rel(urlToFilePath(`https://example.com/s?query=${'a'.repeat(201)}`, BASE));
  assert.ok(q1.length < 160);
  assert.notEqual(q1, q2);
});
