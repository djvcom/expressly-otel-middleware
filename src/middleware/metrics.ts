import type { ERequest, EResponse } from '@fastly/expressly';
import { metrics } from '@opentelemetry/api';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
} from '@opentelemetry/semantic-conventions';
import { routePatterns } from '../router.js';

/**
 * Creates Expressly middleware that records HTTP server metrics:
 * - `http.server.request.duration` — histogram in seconds
 * - `http.server.active_requests` — up/down counter of in-flight requests
 */
export function createMetricsMiddleware() {
  const meter = metrics.getMeter('expressly-otel-middleware');

  const requestDuration = meter.createHistogram(
    'http.server.request.duration',
    { description: 'Duration of HTTP server requests', unit: 's' },
  );
  const activeRequests = meter.createUpDownCounter(
    'http.server.active_requests',
    { description: 'Number of active HTTP server requests', unit: '{request}' },
  );

  return async function metricsMiddleware(req: ERequest, res: EResponse) {
    const startTime = performance.now();
    const method = req.method;

    activeRequests.add(1, { [ATTR_HTTP_REQUEST_METHOD]: method });

    res.on('finish', (response: Response) => {
      const durationS = (performance.now() - startTime) / 1000;
      const routePattern = routePatterns.get(req);

      const attributes: Record<string, string | number> = {
        [ATTR_HTTP_REQUEST_METHOD]: method,
        [ATTR_HTTP_RESPONSE_STATUS_CODE]: response.status,
      };

      if (routePattern) {
        attributes[ATTR_HTTP_ROUTE] = routePattern;
      }

      requestDuration.record(durationS, attributes);
      activeRequests.add(-1, { [ATTR_HTTP_REQUEST_METHOD]: method });
    });
  };
}
