import { OTLPTraceExporter } from '@fastly/compute-js-opentelemetry/exporter-trace-otlp-fastly-backend';
import { FastlyBackendFetchInstrumentation } from '@fastly/compute-js-opentelemetry/instrumentation-fastly-backend-fetch';
import { FastlySDK } from '@fastly/compute-js-opentelemetry/sdk-fastly';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { TelemetryConfig } from './types.js';

export async function initTelemetry(config: TelemetryConfig): Promise<void> {
  const resourceAttributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...config.resourceAttributes,
  };

  const backendFetchInstrumentation = new FastlyBackendFetchInstrumentation(
    config.backendFetchAttributes
      ? { applyCustomAttributesOnSpan: config.backendFetchAttributes }
      : undefined,
  );

  const sdkConfig: Record<string, unknown> = {
    traceExporter: new OTLPTraceExporter({
      backend: config.collectorBackend,
    }),
    instrumentations: [
      backendFetchInstrumentation,
      ...(config.instrumentations ?? []),
    ],
    resource: new Resource(resourceAttributes),
    textMapPropagator: new W3CTraceContextPropagator(),
  };

  if (config.sampler) {
    sdkConfig.sampler = config.sampler;
  }

  if (config.metrics) {
    const { OTLPMetricExporter } = await import(
      '@fastly/compute-js-opentelemetry/exporter-metrics-otlp-fastly-backend'
    );
    const { FastlyMetricReader } = await import(
      '@fastly/compute-js-opentelemetry/sdk-metrics-fastly'
    );
    sdkConfig.metricReader = new FastlyMetricReader({
      exporter: new OTLPMetricExporter({
        backend: config.metrics.collectorBackend ?? config.collectorBackend,
      }),
    });
  }

  const sdk = new FastlySDK(
    sdkConfig as ConstructorParameters<typeof FastlySDK>[0],
  );
  await sdk.start();
}
