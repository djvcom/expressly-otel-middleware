import { OTLPTraceExporter } from '@fastly/compute-js-opentelemetry/exporter-trace-otlp-fastly-backend';
import { FastlyBackendFetchInstrumentation } from '@fastly/compute-js-opentelemetry/instrumentation-fastly-backend-fetch';
import { FastlySDK } from '@fastly/compute-js-opentelemetry/sdk-fastly';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const sdk = new FastlySDK({
  traceExporter: new OTLPTraceExporter({ backend: 'otlp-collector' }),
  instrumentations: [new FastlyBackendFetchInstrumentation()],
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'fastly-compute-app',
  }),
  textMapPropagator: new W3CTraceContextPropagator(),
});

await sdk.start();
