import {Counter, Registry} from 'prom-client';

export const metricsRegistry = new Registry();

/**
 * Compilation cache checks made before queueing, by outcome: hit, miss, skipped (the request is one whose key the
 * router can't reproduce exactly; `reason` says why) or error. The hit rate is hit / (hit + miss).
 */
export const compilationCacheCounter = new Counter({
    name: 'ce_router_compilation_cache_total',
    help: 'Compilation cache checks made before queueing a compile request, by result',
    labelNames: ['result', 'reason'] as const,
    registers: [metricsRegistry],
});
