import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getLocalDraftMetrics,
  shouldReadMainWorldSnapshot,
  mergeDraftSnapshotMetrics
} = require('../utils/draft-snapshot.js');

test('shouldReadMainWorldSnapshot requests fallback when editor is not ready', () => {
  assert.equal(shouldReadMainWorldSnapshot({
    editorReady: false,
    localHtmlLength: 120,
    localTextLength: 80
  }), true);
});

test('shouldReadMainWorldSnapshot requests fallback when local draft looks empty', () => {
  assert.equal(shouldReadMainWorldSnapshot({
    editorReady: true,
    localHtmlLength: 0,
    localTextLength: 42
  }), true);

  assert.equal(shouldReadMainWorldSnapshot({
    editorReady: true,
    localHtmlLength: 120,
    localTextLength: 0
  }), true);
});

test('getLocalDraftMetrics counts text and images from local html', () => {
  const metrics = getLocalDraftMetrics('<p>Hello</p><img src="a.png">', ' Hello\nworld ');

  assert.deepEqual(metrics, {
    contentHtmlLength: 29,
    contentTextLength: 11,
    imageCount: 1,
    contentPreview: 'Hello world'
  });
});

test('mergeDraftSnapshotMetrics prefers longer main-world lengths and preview fallback', () => {
  const merged = mergeDraftSnapshotMetrics({
    localMetrics: {
      contentHtmlLength: 0,
      contentTextLength: 0,
      imageCount: 0,
      contentPreview: ''
    },
    mainWorldSnapshot: {
      htmlLength: 321,
      textLength: 210,
      imageCount: 2,
      textPreview: 'publish layer is open but text still exists'
    }
  });

  assert.deepEqual(merged, {
    contentHtmlLength: 321,
    contentTextLength: 210,
    imageCount: 2,
    contentPreview: 'publish layer is open but text still exists'
  });
});

test('mergeDraftSnapshotMetrics keeps richer local preview when main-world snapshot is shorter', () => {
  const merged = mergeDraftSnapshotMetrics({
    localMetrics: {
      contentHtmlLength: 200,
      contentTextLength: 90,
      imageCount: 1,
      contentPreview: 'local preview wins'
    },
    mainWorldSnapshot: {
      htmlLength: 120,
      textLength: 50,
      imageCount: 0,
      textPreview: 'main world preview'
    }
  });

  assert.deepEqual(merged, {
    contentHtmlLength: 200,
    contentTextLength: 90,
    imageCount: 1,
    contentPreview: 'local preview wins'
  });
});
