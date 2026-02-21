import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  paginateUids,
  normalizeSort,
} from '../dist/query.js';

test('normalizeSort defaults to desc', () => {
  assert.equal(normalizeSort('asc'), 'asc');
  assert.equal(normalizeSort('desc'), 'desc');
  assert.equal(normalizeSort('anything-else'), 'desc');
});

test('clampLimit enforces defaults and max cap', () => {
  assert.equal(clampLimit(undefined, 200, 50), 50);
  assert.equal(clampLimit(10, 200, 50), 10);
  assert.equal(clampLimit(100000, 200, 50), 200);
  assert.equal(clampLimit(-2, 200, 50), 1);
});

test('cursor encode/decode roundtrip', () => {
  const cursor = encodeCursor(1234);
  assert.equal(decodeCursor(cursor), 1234);
});

test('decodeCursor throws on invalid cursor', () => {
  assert.throws(() => decodeCursor('not-base64'), /Invalid cursor/);
});

test('paginateUids returns stable desc order and nextCursor', () => {
  const { pageUids, nextCursor } = paginateUids([5, 2, 3, 4, 1], {
    limit: 2,
    maxResults: 200,
    sort: 'desc',
  });

  assert.deepEqual(pageUids, [5, 4]);
  assert.ok(nextCursor);

  const page2 = paginateUids([5, 2, 3, 4, 1], {
    limit: 2,
    maxResults: 200,
    sort: 'desc',
    cursor: nextCursor,
  });

  assert.deepEqual(page2.pageUids, [3, 2]);
});
