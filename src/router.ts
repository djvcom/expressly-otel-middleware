import { type ERequest, type EResponse, Router } from '@fastly/expressly';

export const routePatterns = new WeakMap<ERequest, string>();

type HandlerFn = (req: ERequest, res: EResponse) => Promise<unknown>;

const HTTP_METHODS = [
  'get',
  'post',
  'put',
  'delete',
  'head',
  'options',
  'patch',
  'purge',
  'all',
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

function wrapCallback(pattern: string, callback: HandlerFn): HandlerFn {
  return async (req: ERequest, res: EResponse) => {
    routePatterns.set(req, pattern);
    return callback(req, res);
  };
}

/**
 * Drop-in replacement for `new Router()` that captures matched route patterns.
 * The tracing middleware reads these to set `http.route` and update span names,
 * preventing cardinality explosion from high-cardinality URL paths.
 */
export function createTracedRouter(
  config?: ConstructorParameters<typeof Router>[0],
): Router {
  const router = new Router(config);

  for (const method of HTTP_METHODS) {
    const original = router[method].bind(router) as (
      pattern: string,
      callback: HandlerFn,
    ) => void;

    (router as Record<HttpMethod, unknown>)[method] = (
      pattern: string,
      callback: HandlerFn,
    ) => {
      original(pattern, wrapCallback(pattern, callback));
    };
  }

  const originalRoute = router.route.bind(router);
  router.route = (
    methods: Parameters<typeof router.route>[0],
    pattern: string,
    callback: HandlerFn,
  ) => {
    originalRoute(methods, pattern, wrapCallback(pattern, callback));
  };

  return router;
}
