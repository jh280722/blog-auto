import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  buildBodyImagePolicyActionGuard,
  buildBodyImagePolicyFailureResult,
  buildBodyImagePolicyReport,
  validateBlogAutoPayloadImagePolicy
} from '../utils/blog-image-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

test('validateBlogAutoPayloadImagePolicy rejects generated body images from PIL or baoyu fallback routes', () => {
  const report = validateBlogAutoPayloadImagePolicy({
    title: 'Generated image policy smoke',
    content: '<p>본문</p>',
    images: [
      {
        url: 'https://i.imgur.com/fallback.png',
        alt: '수제 인포그래픽',
        generated: true,
        generation: {
          tool: 'PIL infographic script',
          runner: 'python',
          model: 'pillow'
        }
      },
      {
        url: 'https://i.imgur.com/baoyu.png',
        generated: true,
        generation: {
          tool: 'baoyu-infographic',
          runner: 'hermes-skill',
          model: 'baoyu'
        }
      }
    ]
  });

  assert.equal(report.ok, false);
  assert.equal(report.generatedImageCount, 2);
  assert.deepEqual(report.violations.map((violation) => violation.reason), [
    'generated_image_disallowed_route',
    'generated_image_disallowed_route'
  ]);
  assert.match(report.violations[0].message, /Hermes image_generate/);
  assert.match(report.violations[1].message, /baoyu/);
});

test('validateBlogAutoPayloadImagePolicy allows Hermes image_generate via openai-codex gpt-image-2-medium', () => {
  const report = validateBlogAutoPayloadImagePolicy({
    images: [
      {
        url: 'https://i.imgur.com/hermes.png',
        generated: true,
        generation: {
          tool: 'Hermes image_generate',
          runner: 'openai-codex',
          model: 'gpt-image-2-medium',
          prompt: 'A clean blog hero image'
        }
      }
    ]
  });

  assert.equal(report.ok, true);
  assert.equal(report.generatedImageCount, 1);
  assert.equal(report.violations.length, 0);
  assert.equal(report.images[0].route, 'hermes_image_generate_openai_codex_gpt_image_2_medium');
});

test('validateBlogAutoPayloadImagePolicy treats unmarked external or product images as non-generated', () => {
  const report = validateBlogAutoPayloadImagePolicy({
    content: '<p><img src="https://example.com/product.jpg" alt="상품"></p>',
    images: [
      { url: 'https://example.com/product.jpg', alt: '상품 대표 이미지' }
    ]
  });

  assert.equal(report.ok, true);
  assert.equal(report.generatedImageCount, 0);
  assert.equal(report.unmarkedImageCount, 2);
  assert.equal(report.violations.length, 0);
});

test('buildBodyImagePolicyFailureResult packages cron-friendly failure diagnostics', () => {
  const report = buildBodyImagePolicyReport({
    action: 'WRITE_POST',
    payload: {
      images: [
        {
          url: 'https://i.imgur.com/handmade.png',
          generated: true,
          generation: { tool: 'PIL', runner: 'python', model: 'pillow' }
        }
      ]
    }
  });
  const result = buildBodyImagePolicyFailureResult({ action: 'WRITE_POST', report });

  assert.equal(result.success, false);
  assert.equal(result.status, 'body_image_policy_violation');
  assert.equal(result.action, 'WRITE_POST');
  assert.equal(result.bodyImagePolicy.ok, false);
  assert.equal(result.bodyImagePolicy.violations[0].reason, 'generated_image_disallowed_route');
});

test('buildBodyImagePolicyActionGuard returns fail-fast result only for publishable post actions', () => {
  const payload = {
    title: 'unsafe generated route',
    content: '<p>본문</p>',
    images: [
      {
        url: 'https://i.imgur.com/fallback.png',
        generated: true,
        generation: { tool: 'PIL infographic script', runner: 'python', model: 'pillow' }
      }
    ]
  };

  const writePostGuard = buildBodyImagePolicyActionGuard({ action: 'WRITE_POST', payload });
  assert.equal(writePostGuard?.status, 'body_image_policy_violation');
  assert.equal(writePostGuard?.bodyImagePolicy?.violations[0]?.reason, 'generated_image_disallowed_route');

  const addToQueueGuard = buildBodyImagePolicyActionGuard({ action: 'ADD_TO_QUEUE', payload });
  assert.equal(addToQueueGuard?.status, 'body_image_policy_violation');

  assert.equal(buildBodyImagePolicyActionGuard({ action: 'GET_QUEUE', payload }), null);
});

test('service worker gates WRITE_POST and ADD_TO_QUEUE with the shared body image policy guard', () => {
  const serviceWorker = readFileSync(resolve(repoRoot, 'background/service-worker.js'), 'utf8');
  assert.match(serviceWorker, /buildBodyImagePolicyActionGuard/);
  assert.match(serviceWorker, /const bodyImagePolicyFailure = buildBodyImagePolicyActionGuard\(\{\s*action: message\.action,\s*payload: message\.data\s*\}\);/s);

  const guardIndex = serviceWorker.indexOf('buildBodyImagePolicyActionGuard({');
  const writePostIndex = serviceWorker.indexOf("case 'WRITE_POST'");
  const addToQueueIndex = serviceWorker.indexOf("case 'ADD_TO_QUEUE'");
  assert.notEqual(guardIndex, -1);
  assert.ok(guardIndex < writePostIndex, 'policy guard should run before WRITE_POST opens or prepares an editor tab');
  assert.ok(guardIndex < addToQueueIndex, 'policy guard should run before ADD_TO_QUEUE persists unsafe queue data');
});
