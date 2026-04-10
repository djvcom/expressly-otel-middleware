import { OTLPTraceExporter } from '@fastly/compute-js-opentelemetry/exporter-trace-otlp-fastly-backend';
import { FastlyBackendFetchInstrumentation } from '@fastly/compute-js-opentelemetry/instrumentation-fastly-backend-fetch';
import { FastlySDK } from '@fastly/compute-js-opentelemetry/sdk-fastly';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { TelemetryConfig } from './types.js';

/**
 * Initialise the OTel SDK for a Fastly Compute application.
 * Call once at the top of your entry point, before registering any routes.
 */
export async function initTelemetry(config: TelemetryConfig): Promise<void> {
  const backendFetchInstrumentation = new FastlyBackendFetchInstrumentation(
    config.backendFetchAttributes
      ? { applyCustomAttributesOnSpan: config.backendFetchAttributes }
      : undefined,
  );

  let metricReader: object | undefined;
  if (config.metrics) {
    const { OTLPMetricExporter } = await import(
      '@fastly/compute-js-opentelemetry/exporter-metrics-otlp-fastly-backend'
    );
    const { FastlyMetricReader } = await import(
      '@fastly/compute-js-opentelemetry/sdk-metrics-fastly'
    );
    metricReader = new FastlyMetricReader({
      exporter: new OTLPMetricExporter({
        backend: config.metrics.collectorBackend ?? config.collectorBackend,
      }),
    });
  }

  const sdk = new FastlySDK({
    traceExporter: new OTLPTraceExporter({ backend: config.collectorBackend }),
    instrumentations: [
      backendFetchInstrumentation,
      ...(config.instrumentations ?? []),
    ],
    resource: new Resource({
      [ATTR_SERVICE_NAME]: config.serviceName,
      ...config.resourceAttributes,
    }),
    textMapPropagator: new W3CTraceContextPropagator(),
    ...(config.sampler ? { sampler: config.sampler } : {}),
    ...(metricReader ? { metricReader } : {}),
  } as ConstructorParameters<typeof FastlySDK>[0]);

  await sdk.start();
}
