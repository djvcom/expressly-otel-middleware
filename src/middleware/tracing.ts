import { _setEventContext } from '@fastly/compute-js-opentelemetry/sdk-trace-fastly';
import type { ERequest, EResponse } from '@fastly/expressly';
import {
  context,
  defaultTextMapGetter,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {
  ATTR_CLIENT_ADDRESS,
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
  ATTR_USER_AGENT_ORIGINAL,
} from '@opentelemetry/semantic-conventions';
import { routePatterns } from '../router.js';
import type { TracingMiddlewareConfig } from '../types.js';

const tracer = trace.getTracer('expressly-otel-middleware');

export function createTracingMiddleware(config?: TracingMiddlewareConfig) {
  return async function tracingMiddleware(req: ERequest, res: EResponse) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (config?.ignorePaths?.includes(pathname)) {
      return;
    }

    const extractedContext = propagation.extract(
      context.active(),
      Object.fromEntries(req.headers),
      defaultTextMapGetter,
    );

    const span = tracer.startSpan(
      `${req.method} ${pathname}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          [ATTR_HTTP_REQUEST_METHOD]: req.method,
          [ATTR_URL_PATH]: pathname,
          [ATTR_URL_SCHEME]: url.protocol.replace(':', ''),
          [ATTR_SERVER_ADDRESS]: url.hostname,
          [ATTR_SERVER_PORT]:
            Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
          ...config?.additionalAttributes,
          ...config?.requestAttributes?.(req),
        },
      },
      extractedContext,
    );

    const userAgent = req.headers.get('user-agent');
    if (userAgent) {
      span.setAttribute(ATTR_USER_AGENT_ORIGINAL, userAgent);
    }

    const clientAddress =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip');
    if (clientAddress) {
      span.setAttribute(ATTR_CLIENT_ADDRESS, clientAddress);
    }

    const ctx = trace.setSpan(extractedContext, span);
    _setEventContext(ctx);

    res.on('finish', (response: Response) => {
      const statusCode = response.status;
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);

      const routePattern = routePatterns.get(req);
      if (routePattern) {
        span.setAttribute(ATTR_HTTP_ROUTE, routePattern);
        span.updateName(`${req.method} ${routePattern}`);
      }

      if (statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute(ATTR_ERROR_TYPE, String(statusCode));
      }

      span.end();
    });
  };
}

export function createErrorMiddleware() {
  return async function errorMiddleware(
    err: Error,
    _req: ERequest,
    res: EResponse,
  ) {
    const span = trace.getActiveSpan();

    if (span) {
      span.recordException(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err.message,
      });
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, 500);

      const errorType =
        err.constructor.name !== 'Error' ? err.constructor.name : '500';
      span.setAttribute(ATTR_ERROR_TYPE, errorType);
    }

    res.withStatus(500).send(`Error: ${err.message}`);
  };
}
