import {
  DEFAULT_ANONYMOUS_PERFORMANCE_DIAGNOSTIC_CONFIG,
  type AnonymousPerformanceDiagnosticConfig,
  type AnonymousPerformanceDiagnosticPayload,
  type AnonymousPerformanceDiagnosticPreview,
  type AnonymousPerformanceEnvironment,
  type AnonymousPerformanceMetrics,
} from "./contracts";
import { parseAnonymousPerformanceDiagnosticPayload } from "./validation";

export function buildAnonymousPerformanceDiagnosticPayload(
  environment: AnonymousPerformanceEnvironment,
  metrics: AnonymousPerformanceMetrics,
  config: AnonymousPerformanceDiagnosticConfig = DEFAULT_ANONYMOUS_PERFORMANCE_DIAGNOSTIC_CONFIG,
): AnonymousPerformanceDiagnosticPayload | null {
  if (!config.enabled) return null;
  return parseAnonymousPerformanceDiagnosticPayload({
    schemaVersion: "1",
    category: "performance",
    environment,
    metrics,
  });
}

export function previewAnonymousPerformanceDiagnostic(
  environment: AnonymousPerformanceEnvironment,
  metrics: AnonymousPerformanceMetrics,
  config: AnonymousPerformanceDiagnosticConfig = DEFAULT_ANONYMOUS_PERFORMANCE_DIAGNOSTIC_CONFIG,
): AnonymousPerformanceDiagnosticPreview {
  const payload = buildAnonymousPerformanceDiagnosticPayload(environment, metrics, config);
  if (!payload) {
    return Object.freeze({
      enabled: false,
      payload: null,
      serializedPayload: null,
      byteLength: 0,
      notice: "Anonymous performance diagnostics are off. Nothing will be sent.",
    });
  }
  const serializedPayload = JSON.stringify(payload);
  return Object.freeze({
    enabled: true,
    payload,
    serializedPayload,
    byteLength: new TextEncoder().encode(serializedPayload).byteLength,
    notice: "This is the exact allowlisted payload. Sending still requires an explicit caller action.",
  });
}
