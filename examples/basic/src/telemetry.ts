import { initTelemetry } from '../../../src/index.js';

await initTelemetry({
  serviceName: 'fastly-compute-app',
  collectorBackend: 'otlp-collector',
});
