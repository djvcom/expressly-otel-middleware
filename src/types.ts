import type { ERequest } from '@fastly/expressly';
import type { Span } from '@opentelemetry/api';
import type { Sampler } from '@opentelemetry/sdk-trace-base';

/** Attributes that can be set on OTel spans. */
export type SpanAttributes = Record<string, string | number | boolean>;

/** Controls which requests are traced and what extra attributes are captured. */
export interface TracingMiddlewareConfig {
  /** Paths to skip tracing for (exact match, e.g. `/health`). */
  ignorePaths?: string[];
  /** Static attributes added to every server span. */
  additionalAttributes?: SpanAttributes;
  /** Called per request to extract dynamic span attributes. */
  requestAttributes?: (req: ERequest) => SpanAttributes;
}

/** OTLP metrics export settings. */
export interface MetricsConfig {
  /** Fastly backend name for the OTLP metrics collector. Falls back to the tracing collector backend. */
  collectorBackend?: string;
}

/** Top-level telemetry configuration passed to {@link initTelemetry}. */
export interface TelemetryConfig {
  /** Service name reported in traces and metrics. */
  serviceName: string;
  /** Fastly backend name for the OTLP trace collector. */
  collectorBackend: string;
  /** Trace sampler. The Fastly SDK defaults to AlwaysOn when omitted. */
  sampler?: Sampler;
  /** Extra resource attributes beyond `service.name`. */
  resourceAttributes?: Record<string, string>;
  /** Extra instrumentations beyond the built-in backend fetch instrumentation. */
  instrumentations?: object[];
  /** Called on each backend fetch span to add custom attributes. */
  backendFetchAttributes?: (
    span: Span,
    request: RequestInfo | URL,
    init: RequestInit | undefined,
    response: Response,
  ) => void;
  /** Pass a config object to enable metrics collection, or omit to disable. */
  metrics?: MetricsConfig;
}
