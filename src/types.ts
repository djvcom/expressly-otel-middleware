import type { ERequest } from '@fastly/expressly';
import type { Span } from '@opentelemetry/api';
import type { Sampler } from '@opentelemetry/sdk-trace-base';

export interface TracingMiddlewareConfig {
  /** Paths to exclude from tracing (exact match). */
  ignorePaths?: string[];
  /** Additional attributes to set on every server span. */
  additionalAttributes?: Record<string, string | number | boolean>;
  /** Extract custom attributes from each request. */
  requestAttributes?: (
    req: ERequest,
  ) => Record<string, string | number | boolean>;
}

export interface MetricsConfig {
  /** Fastly backend name for the OTLP metrics collector. Defaults to the tracing collector backend. */
  collectorBackend?: string;
}

export interface TelemetryConfig {
  /** Service name reported in traces and metrics. */
  serviceName: string;
  /** Fastly backend name for the OTLP trace collector. */
  collectorBackend: string;
  /** Sampler to control trace sampling. Defaults to AlwaysOn. */
  sampler?: Sampler;
  /** Additional resource attributes beyond service.name. */
  resourceAttributes?: Record<string, string>;
  /** Additional instrumentations beyond FastlyBackendFetchInstrumentation. */
  instrumentations?: unknown[];
  /** Callback to add custom attributes to backend fetch spans. */
  backendFetchAttributes?: (
    span: Span,
    request: RequestInfo | URL,
    init: RequestInit | undefined,
    response: Response,
  ) => void;
  /** Enable metrics collection. Pass config object or false to disable. Omit to disable. */
  metrics?: MetricsConfig | false;
}
