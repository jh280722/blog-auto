import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTistoryTagsForInput } from '../utils/tistory-tags.js';

test('normalizeTistoryTagsForInput caps tags to the Tistory-safe default of three', () => {
  assert.deepEqual(
    normalizeTistoryTagsForInput(['위탁판매', '반품관리', '셀러운영', '주문관리', '위탁판매자동화', '상태값관리']),
    ['위탁판매', '반품관리', '셀러운영']
  );
});

test('normalizeTistoryTagsForInput trims hashes, blanks, and duplicates before capping', () => {
  assert.deepEqual(
    normalizeTistoryTagsForInput([' #위탁판매 ', '', '반품관리', '위탁판매', ' 셀러운영 ']),
    ['위탁판매', '반품관리', '셀러운영']
  );
});
