import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findQueueCaptchaItem,
  getQueueCaptchaSelectionFailure,
  summarizeQueueCaptchaSelection
} from '../utils/queue-captcha.js';

function buildQueue() {
  return [
    { id: 'pending', status: 'pending' },
    { id: 'paused-a', status: 'captcha_paused', captchaTabId: 101 },
    { id: 'paused-b', status: 'captcha_paused', captchaTabId: 202 },
    { id: 'done', status: 'completed', captchaTabId: 303 }
  ];
}

test('findQueueCaptchaItem prefers an explicit paused queue item id', () => {
  const item = findQueueCaptchaItem(buildQueue(), { itemId: 'paused-b' });
  assert.equal(item?.id, 'paused-b');
  assert.equal(item?.captchaTabId, 202);
});

test('findQueueCaptchaItem resolves a unique paused queue item by captcha tab id', () => {
  const item = findQueueCaptchaItem(buildQueue(), { tabId: 101 });
  assert.equal(item?.id, 'paused-a');
});

test('findQueueCaptchaItem auto-selects the only paused queue item when id and tabId are omitted', () => {
  const item = findQueueCaptchaItem([
    { id: 'pending', status: 'pending' },
    { id: 'paused-only', status: 'captcha_paused', captchaTabId: 777 }
  ]);

  assert.equal(item?.id, 'paused-only');
});

test('findQueueCaptchaItem stays fail-closed when multiple paused items exist and no selector is provided', () => {
  const item = findQueueCaptchaItem(buildQueue());
  assert.equal(item, null);
});

test('findQueueCaptchaItem stays fail-closed when a tab id matches multiple paused items', () => {
  const item = findQueueCaptchaItem([
    { id: 'paused-a', status: 'captcha_paused', captchaTabId: 555 },
    { id: 'paused-b', status: 'captcha_paused', captchaTabId: '555' }
  ], { tabId: 555 });

  assert.equal(item, null);
});

test('findQueueCaptchaItem does not auto-select when an explicit tab id is invalid', () => {
  const item = findQueueCaptchaItem([
    { id: 'paused-only', status: 'captcha_paused', captchaTabId: 777 }
  ], { tabId: 'abc' });

  assert.equal(item, null);
});

test('summarizeQueueCaptchaSelection reports paused queue metadata for diagnostics', () => {
  const summary = summarizeQueueCaptchaSelection(buildQueue(), { tabId: '202' });

  assert.deepEqual(summary, {
    pausedCount: 2,
    requestedItemId: null,
    requestedTabId: 202,
    pausedItemIds: ['paused-a', 'paused-b'],
    pausedTabIds: [101, 202]
  });
});

test('getQueueCaptchaSelectionFailure fail-closes an explicit queue item id miss', () => {
  const failure = getQueueCaptchaSelectionFailure({
    queue: buildQueue(),
    itemId: 'missing',
    matchedItem: null,
    directPublishTabId: null
  });

  assert.deepEqual(failure, {
    status: 'item_not_found',
    error: '지정한 captcha_paused 큐 항목을 찾지 못했습니다.',
    queueSelection: {
      pausedCount: 2,
      requestedItemId: 'missing',
      requestedTabId: null,
      pausedItemIds: ['paused-a', 'paused-b'],
      pausedTabIds: [101, 202]
    }
  });
});

test('getQueueCaptchaSelectionFailure fail-closes mismatched explicit id and tab id selectors', () => {
  const matchedItem = findQueueCaptchaItem(buildQueue(), { itemId: 'paused-a', tabId: 202 });
  const failure = getQueueCaptchaSelectionFailure({
    queue: buildQueue(),
    itemId: 'paused-a',
    tabId: 202,
    matchedItem,
    directPublishTabId: null
  });

  assert.deepEqual(failure, {
    status: 'queue_captcha_target_required',
    error: '지정한 id와 captchaTabId가 같은 captcha_paused 큐 항목을 가리키지 않습니다.',
    queueSelection: {
      pausedCount: 2,
      requestedItemId: 'paused-a',
      requestedTabId: 202,
      pausedItemIds: ['paused-a', 'paused-b'],
      pausedTabIds: [101, 202]
    }
  });
});

test('getQueueCaptchaSelectionFailure fail-closes an explicit queue tab id miss when no direct publish target matches', () => {
  const failure = getQueueCaptchaSelectionFailure({
    queue: buildQueue(),
    tabId: 999,
    matchedItem: null,
    directPublishTabId: null
  });

  assert.deepEqual(failure, {
    status: 'item_not_found',
    error: '지정한 captchaTabId와 일치하는 captcha_paused 큐 항목을 찾지 못했습니다.',
    queueSelection: {
      pausedCount: 2,
      requestedItemId: null,
      requestedTabId: 999,
      pausedItemIds: ['paused-a', 'paused-b'],
      pausedTabIds: [101, 202]
    }
  });
});

test('getQueueCaptchaSelectionFailure fail-closes an explicit but invalid queue tab id', () => {
  const failure = getQueueCaptchaSelectionFailure({
    queue: [{ id: 'paused-only', status: 'captcha_paused', captchaTabId: 777 }],
    tabId: 'abc',
    matchedItem: null,
    directPublishTabId: null
  });

  assert.deepEqual(failure, {
    status: 'item_not_found',
    error: '유효한 captchaTabId를 지정하세요.',
    queueSelection: {
      pausedCount: 1,
      requestedItemId: null,
      requestedTabId: null,
      pausedItemIds: ['paused-only'],
      pausedTabIds: [777]
    }
  });
});

test('getQueueCaptchaSelectionFailure allows an explicit tab id when it matches the direct publish target', () => {
  const failure = getQueueCaptchaSelectionFailure({
    queue: buildQueue(),
    tabId: 999,
    matchedItem: null,
    directPublishTabId: 999
  });

  assert.equal(failure, null);
});

test('getQueueCaptchaSelectionFailure requires a selector when multiple paused queue items exist and no direct publish target is active', () => {
  const failure = getQueueCaptchaSelectionFailure({
    queue: buildQueue(),
    matchedItem: null,
    directPublishTabId: null
  });

  assert.deepEqual(failure, {
    status: 'queue_captcha_target_required',
    error: 'captcha_paused 큐 항목이 여러 개입니다. id 또는 tabId를 지정하세요.',
    queueSelection: {
      pausedCount: 2,
      requestedItemId: null,
      requestedTabId: null,
      pausedItemIds: ['paused-a', 'paused-b'],
      pausedTabIds: [101, 202]
    }
  });
});
