import type { ERequest, EResponse } from '@fastly/expressly';
import {
  type Histogram,
  metrics,
  type UpDownCounter,
} from '@opentelemetry/api';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
} from '@opentelemetry/semantic-conventions';
import { routePatterns } from '../router.js';

const meter = metrics.getMeter('expressly-otel-middleware');

let requestDuration: Histogram | undefined;
let activeRequests: UpDownCounter | undefined;

function ensureInstruments() {
  if (!requestDuration) {
    requestDuration = meter.createHistogram('http.server.request.duration', {
      description: 'Duration of HTTP server requests',
      unit: 's',
    });
  }
  if (!activeRequests) {
    activeRequests = meter.createUpDownCounter('http.server.active_requests', {
      description: 'Number of active HTTP server requests',
      unit: '{request}',
    });
  }
}

export function createMetricsMiddleware() {
  return async function metricsMiddleware(req: ERequest, res: EResponse) {
    ensureInstruments();

    const startTime = performance.now();
    const method = req.method;

    activeRequests?.add(1, { [ATTR_HTTP_REQUEST_METHOD]: method });

    res.on('finish', (response: Response) => {
      const durationS = (performance.now() - startTime) / 1000;
      const statusCode = response.status;
      const routePattern = routePatterns.get(req);

      const attributes: Record<string, string | number> = {
        [ATTR_HTTP_REQUEST_METHOD]: method,
        [ATTR_HTTP_RESPONSE_STATUS_CODE]: statusCode,
      };

      if (routePattern) {
        attributes[ATTR_HTTP_ROUTE] = routePattern;
      }

      requestDuration?.record(durationS, attributes);
      activeRequests?.add(-1, { [ATTR_HTTP_REQUEST_METHOD]: method });
    });
  };
}
