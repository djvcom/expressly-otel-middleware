// import { context, trace } from "@opentelemetry/api";

import { getComputeJsAutoInstrumentations } from '@fastly/compute-js-opentelemetry/auto-instrumentations-compute-js';
import { OTLPTraceExporter } from '@fastly/compute-js-opentelemetry/exporter-trace-otlp-fastly-backend';

import { FastlySDK } from '@fastly/compute-js-opentelemetry/sdk-fastly';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const sdk = new FastlySDK({
  traceExporter: new OTLPTraceExporter({ backend: 'otlp-collector' }),
  instrumentations: [getComputeJsAutoInstrumentations()],
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'readme-demo' }),
});
await sdk.start();
