#!/usr/bin/env node

import process from 'node:process';
import { readFile } from 'node:fs/promises';

import {
  DEFAULT_CHROME_DEBUG_BASE_URL,
  DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
  DEFAULT_EXTENSION_ID,
  DEFAULT_RUNTIME_TIMEOUT_MS,
  buildBridgeSetupFailureResult,
  buildBridgeTimeoutResult,
  buildSetupDiagnosticFailurePayload,
  buildTimeoutDiagnosticFailurePayload,
  callExtensionAction,
  collectSetupDiagnostics,
  collectTimeoutDiagnostics,
  ensureApiTarget,
  parseCliArgs
} from '../utils/blog-auto-call.js';
import {
  buildBodyImagePolicyFailureResult,
  buildBodyImagePolicyReport,
  shouldValidateBodyImagePolicy
} from '../utils/blog-image-policy.js';

function printUsage() {
  console.error(`Usage:
  node scripts/blog_auto_call.mjs --action WRITE_POST --data-file payload.json
  node scripts/blog_auto_call.mjs --action PREPARE_EDITOR --data-json '{"blogName":"nakseo-dev"}'

Options:
  --action <name>                 Extension action to call (required)
  --data-json <json>              Inline JSON payload
  --data-file <path>              Read JSON payload from file
  --stdin                         Read JSON payload from stdin
  --timeout-ms <ms>               Structured bridge timeout (default: ${DEFAULT_RUNTIME_TIMEOUT_MS}, env BLOG_AUTO_CALL_TIMEOUT_MS)
  --diagnostic-timeout-ms <ms>    Timeout for follow-up diagnostic calls (default: ${DEFAULT_DIAGNOSTIC_TIMEOUT_MS})
  --chrome-debug-base-url <url>   Chrome DevTools base URL (default: ${DEFAULT_CHROME_DEBUG_BASE_URL})
  --extension-id <id>             Extension ID (default: ${DEFAULT_EXTENSION_ID})
  --api-page-url <url>            Explicit API page URL (default: chrome-extension://<extension-id>/api/api-page.html)
  --help                          Show this message
`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function loadPayload(options) {
  const sources = [options.dataJson != null, options.dataFile != null, options.dataStdin].filter(Boolean).length;
  if (sources > 1) {
    throw new Error('Use only one of --data-json, --data-file, or --stdin');
  }
  if (options.dataJson != null) {
    return JSON.parse(options.dataJson);
  }
  if (options.dataFile != null) {
    return JSON.parse(await readFile(options.dataFile, 'utf8'));
  }
  if (options.dataStdin) {
    const stdinText = await readStdin();
    return stdinText.trim() ? JSON.parse(stdinText) : {};
  }
  return {};
}

function withBridgeMeta(response, bridgeMeta) {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    return {
      ...response,
      bridgeMeta
    };
  }
  return {
    success: true,
    result: response,
    bridgeMeta
  };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    process.exit(0);
    return;
  }
  if (!options.action) {
    throw new Error('--action is required');
  }
  const data = await loadPayload(options);

  if (shouldValidateBodyImagePolicy(options.action)) {
    const bodyImagePolicy = buildBodyImagePolicyReport({
      action: options.action,
      payload: data
    });
    if (!bodyImagePolicy.ok) {
      console.log(JSON.stringify(buildBodyImagePolicyFailureResult({
        action: options.action,
        report: bodyImagePolicy
      }), null, 2));
      process.exit(6);
      return;
    }
  }

  const startedAt = new Date().toISOString();

  let apiTarget;
  try {
    apiTarget = await ensureApiTarget({
      chromeDebugBaseUrl: options.chromeDebugBaseUrl,
      apiPageUrl: options.apiPageUrl
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    let setupDiagnostics;
    try {
      setupDiagnostics = await collectSetupDiagnostics({
        chromeDebugBaseUrl: options.chromeDebugBaseUrl,
        apiPageUrl: options.apiPageUrl,
        timeoutMs: options.diagnosticTimeoutMs
      });
    } catch (diagnosticError) {
      setupDiagnostics = buildSetupDiagnosticFailurePayload(diagnosticError);
    }

    const setupFailure = buildBridgeSetupFailureResult({
      action: options.action,
      stage: 'ensure_api_target',
      error,
      runtimeTimeoutMs: options.runtimeTimeoutMs,
      startedAt,
      failedAt,
      chromeDebugBaseUrl: options.chromeDebugBaseUrl,
      apiPageUrl: options.apiPageUrl,
      apiTarget: null,
      ...setupDiagnostics
    });

    console.log(JSON.stringify(setupFailure, null, 2));
    process.exit(4);
    return;
  }

  let response;
  try {
    response = await callExtensionAction({
      targetWebSocketUrl: apiTarget.webSocketDebuggerUrl,
      extensionId: options.extensionId,
      action: options.action,
      data,
      runtimeTimeoutMs: options.runtimeTimeoutMs
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    let setupDiagnostics;
    try {
      setupDiagnostics = await collectSetupDiagnostics({
        chromeDebugBaseUrl: options.chromeDebugBaseUrl,
        apiPageUrl: options.apiPageUrl,
        timeoutMs: options.diagnosticTimeoutMs
      });
    } catch (diagnosticError) {
      setupDiagnostics = buildSetupDiagnosticFailurePayload(diagnosticError);
    }

    const transportFailure = buildBridgeSetupFailureResult({
      action: options.action,
      stage: 'call_extension_action',
      error,
      runtimeTimeoutMs: options.runtimeTimeoutMs,
      startedAt,
      failedAt,
      chromeDebugBaseUrl: options.chromeDebugBaseUrl,
      apiPageUrl: options.apiPageUrl,
      apiTarget,
      ...setupDiagnostics
    });

    console.log(JSON.stringify(transportFailure, null, 2));
    process.exit(5);
    return;
  }

  if (response?.__bridgeTimeout) {
    const timedOutAt = new Date().toISOString();
    let diagnostics;
    try {
      diagnostics = await collectTimeoutDiagnostics({
        targetWebSocketUrl: apiTarget.webSocketDebuggerUrl,
        extensionId: options.extensionId,
        action: options.action,
        originalData: data,
        runtimeTimeoutMs: options.diagnosticTimeoutMs
      });
    } catch (error) {
      diagnostics = buildTimeoutDiagnosticFailurePayload(error);
    }

    const timeoutResult = buildBridgeTimeoutResult({
      action: options.action,
      runtimeTimeoutMs: options.runtimeTimeoutMs,
      startedAt,
      timedOutAt,
      apiTarget: {
        id: apiTarget.id,
        title: apiTarget.title,
        url: apiTarget.url
      },
      ...diagnostics
    });

    console.log(JSON.stringify(timeoutResult, null, 2));
    process.exit(2);
    return;
  }

  if (response?.__bridgeError) {
    const bridgeError = {
      success: false,
      status: 'bridge_error',
      error: response.error || `${options.action} bridge call failed`,
      action: options.action,
      bridgeMeta: {
        startedAt,
        finishedAt: new Date().toISOString(),
        runtimeTimeoutMs: options.runtimeTimeoutMs,
        extensionId: options.extensionId,
        apiTarget: {
          id: apiTarget.id,
          title: apiTarget.title,
          url: apiTarget.url
        }
      }
    };
    console.log(JSON.stringify(bridgeError, null, 2));
    process.exit(3);
    return;
  }

  const finishedAt = new Date().toISOString();
  const result = withBridgeMeta(response, {
    startedAt,
    finishedAt,
    runtimeTimeoutMs: options.runtimeTimeoutMs,
    extensionId: options.extensionId,
    apiTarget: {
      id: apiTarget.id,
      title: apiTarget.title,
      url: apiTarget.url
    }
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({
    success: false,
    status: 'bridge_wrapper_error',
    error: error?.message || String(error)
  }, null, 2));
  process.exit(1);
});
