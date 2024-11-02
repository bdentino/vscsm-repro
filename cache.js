import { EventEmitter, once } from 'node:events';
import qs from 'node:querystring';
import { PassThrough } from 'node:stream';
import ms from 'ms';
import { Cache } from '#app/decorators/cache.js';
import Span from '#app/o11y/span.decorator.js';
import KevAdapter from '#app/util/caching/kev-adapter.js';
import MissOnErrorCache from '#app/util/caching/miss-on-error-cache.js';
import CacheInstrumenter from '#app/util/instrumentation/cache-instrumenter.js';
import { GetUser } from './auth.js';
import { GetDomain, GetLocale } from './i18n.js';
const PendingRequest = {};
const PendingRecache = {};
const CacheCtxMap = new WeakMap();
export function GetCacheCtx(ctx) {
    return CacheCtxMap.get(ctx) ?? Cache.getStore();
}
export default function cacheMiddleware({ kev, ttl, }) {
    return async function cache(ctx, next) {
        if (ctx.method !== 'GET')
            return next();
        const cc = ctx.get('cache-control') || '';
        const shouldRead = !cc.match(/no-cache/) || !cc.match(/server/);
        const shouldWrite = !cc.match(/no-store/) || !cc.match(/server/);
        const maxAgeMatch = cc.match(/max-age=(\d+)/);
        const authed = !!ctx.get('authorization');
        const scope = authed ? 'private' : '';
        const opts = { noCache: !shouldRead, noStore: !shouldWrite };
        if (maxAgeMatch && cc.match(/server/)) {
            const maxAge = parseInt(maxAgeMatch[1]);
            opts.maxAgeSeconds = maxAge;
        }
        const _cache = CacheInstrumenter.instrument(new MissOnErrorCache(new KevAdapter(kev, opts), opts), {
            name: 'request',
            bucket: 'server',
        });
        const ttlsec = typeof ttl === 'string' ? ms(ttl) / 1000 : ttl;
        const domain = GetDomain(ctx);
        const locale = GetLocale(ctx);
        const user = GetUser(ctx);
        const query = { ...ctx.query };
        delete query.lang_ID;
        const cachekeys = {
            isPro: !!user.pro,
            domain: domain?.prefix || 'none',
            lang: locale?.tag || 'none',
            format: domain?.numericFormat || 'none',
        };
        const encoding = ctx.get('accept-encoding') || '';
        if (encoding.match(/br/))
            cachekeys['encoding'] = 'br';
        else if (encoding.match(/gzip/))
            cachekeys['encoding'] = 'gzip';
        else if (encoding.match(/deflate/))
            cachekeys['encoding'] = 'deflate';
        else
            cachekeys['encoding'] = 'identity';
        const key = `${ctx.method} ${ctx.path}?${qs.stringify(query)} ${Object.entries(cachekeys)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`;
        const tryRespondWithCache = async () => {
            const cached = await _cache.get(key);
            if (!cached)
                return false;
            const { head, body } = cached;
            const headers = {
                'content-type': head['type'],
                'content-length': head['length'],
                'content-encoding': head['encoding'],
                'x-cache': 'hit',
                'x-cache-key': key,
            };
            let rtl = 0;
            let age = 0;
            if (head.iat && head.exp) {
                age = Math.floor(Date.now() / 1000) - head.iat;
                const maxage = head.exp - head.iat;
                rtl = maxage - age;
                headers['age'] = age.toString();
                headers['cache-control'] = [scope, `max-age=${maxage}`].filter(Boolean).join(', ');
            }
            ctx.res.writeHead(head.status, head['message'] || undefined, headers);
            ctx.res.end(body);
            return { rtl, age };
        };
        if (PendingRequest[key]) {
            await Promise.resolve(PendingRequest[key]).catch((e) => console.error('cache pending error', e));
            const ended = await tryRespondWithCache();
            if (ended)
                return;
        }
        else {
            const ended = await tryRespondWithCache();
            if (ended) {
                const recacheable = ended.rtl < ended.age || ended.age > ms('15m') / 1000;
                if (!PendingRecache[key] && recacheable) {
                    PendingRecache[key] = Span.Root(function recache() {
                        return (once(ctx.res, 'close')
                            .then(() => {
                            const start = Date.now();
                            ctx.req.headers['cache-control'] = `server; max-age=${Math.floor(ended.age / 2)};`;
                            const newHeaders = {};
                            let statusCode = 0;
                            let statusMessage = '';
                            const passthrough = new PassThrough().resume();
                            const resProxy = new Proxy(ctx.res, {
                                set: (target, prop, value) => {
                                    if (prop === 'statusCode')
                                        return (statusCode = value), true;
                                    if (prop === 'statusMessage')
                                        return (statusMessage = value), true;
                                    return Reflect.set(passthrough, prop, value) || Reflect.set(target, prop, value);
                                },
                                get: (target, prop) => {
                                    if (prop === 'recache')
                                        return true;
                                    if (prop === 'statusCode')
                                        return statusCode;
                                    if (prop === 'statusMessage')
                                        return statusMessage;
                                    if (prop === 'headersSent')
                                        return false;
                                    if (prop === 'writableEnded')
                                        return false;
                                    if (prop === 'finished')
                                        return false;
                                    if (prop === 'writable')
                                        return true;
                                    if (prop === 'socket')
                                        return undefined;
                                    if (prop === 'getHeaders')
                                        return () => newHeaders;
                                    if (prop === 'getHeaderNames')
                                        return () => Object.keys(newHeaders);
                                    if (prop === 'getHeader')
                                        return (key) => newHeaders[key.toLowerCase()];
                                    if (prop === 'removeHeader')
                                        return (key) => delete newHeaders[key.toLowerCase()];
                                    if (prop === 'hasHeader')
                                        return (key) => key.toLowerCase() in newHeaders;
                                    if (prop === 'setHeader') {
                                        return function (key, value) {
                                            newHeaders[key.toLowerCase()] = value;
                                            return this;
                                        };
                                    }
                                    if (prop === 'appendHeader') {
                                        return function (key, value) {
                                            const k = key.toLowerCase();
                                            if (!newHeaders[k])
                                                newHeaders[k] = value;
                                            else if (Array.isArray(newHeaders[k]))
                                                newHeaders[k].push(value);
                                            else
                                                newHeaders[k] = [newHeaders[k], value];
                                            return this;
                                        };
                                    }
                                    return passthrough[prop] ?? Reflect.get(target, prop);
                                },
                            });
                            return ctx.app
                                .callback()(ctx.req, resProxy)
                                .then(() => {
                                const age = parseInt(resProxy.getHeader('age')?.toString() ?? '0');
                                const cachecontrol = resProxy.getHeader('cache-control')?.toString() ?? '';
                                const maxAge = parseInt(cachecontrol.match(/max-age=(\d+)/)?.[1] ?? '0');
                                const timing = Date.now() - start;
                                if (resProxy.statusCode >= 200 && resProxy.statusCode < 500) {
                                    console.log(`Recached ${key} in ${timing}ms (ttl=${maxAge - age}s)`, {
                                        event: 'recache-success',
                                        cachekey: key,
                                        ttl: maxAge - age,
                                        recache_time_ms: timing,
                                    });
                                }
                                else {
                                    console.error(`Failed to recache ${key} (request returned ${resProxy.statusCode})`);
                                }
                            });
                        })
                            .catch((e) => console.error('recache error', e))
                            .finally(() => delete PendingRecache[key]));
                    })();
                }
                return;
            }
        }
        let finalStatus = 0;
        let finalStatusMessage = '';
        let contentType = '';
        let contentLength = '';
        let contentEncoding = '';
        const _writeHead = ctx.res.writeHead;
        ctx.res.writeHead = function (status, statusMessage, headers) {
            finalStatus = status;
            if (typeof statusMessage === 'string')
                finalStatusMessage = statusMessage;
            else {
                statusMessage = undefined;
                headers = statusMessage;
            }
            const setHeaders = this.getHeaders();
            headers = headers || {};
            if (Array.isArray(headers)) {
                while (headers.length) {
                    const key = headers.shift();
                    const value = headers.shift();
                    if (key)
                        setHeaders[key.toString()] = value?.toString() ?? '';
                }
            }
            else {
                for (const key of Object.keys(headers)) {
                    setHeaders[key] = headers[key]?.toString() ?? '';
                }
            }
            if (setHeaders['content-type'])
                contentType = setHeaders['content-type'].toString();
            if (setHeaders['content-length'])
                contentLength = setHeaders['content-length'].toString();
            if (setHeaders['content-encoding'])
                contentEncoding = setHeaders['content-encoding'].toString();
            if (!this.writable || this['recache'])
                return;
            return _writeHead.call(this, status, statusMessage, headers);
        };
        const chunks = [];
        const _write = ctx.res.write;
        ctx.res.write = function (chunk, encoding, cb) {
            chunks.push(Buffer.from(chunk));
            if (!this.writable || this['recache'])
                return;
            return _write.call(this, chunk, encoding, cb);
        };
        const signal = new EventEmitter();
        const _end = ctx.res.end;
        ctx.res.end = function (data, encoding, cb) {
            if (data !== undefined)
                chunks.push(Buffer.from(data));
            finalStatus = finalStatus || ctx.res.statusCode;
            finalStatusMessage = finalStatusMessage || ctx.res.statusMessage;
            contentType = contentType || ctx.res.getHeader('content-type')?.toString() || '';
            contentLength = contentLength || ctx.res.getHeader('content-length')?.toString() || '';
            contentEncoding = contentEncoding || ctx.res.getHeader('content-encoding')?.toString() || '';
            signal.emit('response');
            if (!this.writable || this['recache'])
                return;
            return _end.call(this, data, encoding, cb);
        };
        let onFinish = () => {
            signal.emit('finish');
        };
        signal.once('response', () => {
            onFinish();
        });
        if (!opts.maxAgeSeconds) {
            PendingRequest[key] = new Promise((resolve) => {
                let resolved = false;
                signal.once('finish', () => {
                    if (!resolved) {
                        resolved = true;
                        delete PendingRequest[key];
                        resolve(null);
                    }
                });
                ctx.res.on('close', () => {
                    if (!resolved) {
                        Object.defineProperty(ctx, 'writable', { value: true });
                    }
                });
            });
        }
        const cacheCtx = {
            cache: _cache,
            age: 0,
            maxage: ttlsec,
            depends: new Set(),
        };
        CacheCtxMap.set(ctx, cacheCtx);
        await Cache.run(cacheCtx, next).finally(() => {
            ctx.set('x-cache', 'miss');
            ctx.set('age', cacheCtx.age.toString());
            ctx.set('cache-control', [scope, `max-age=${cacheCtx.maxage}`].filter(Boolean).join(', '));
            onFinish = () => {
                if (finalStatus >= 200 && finalStatus < 500) {
                    const realttl = cacheCtx.maxage - cacheCtx.age;
                    const buffer = Buffer.concat(chunks);
                    const iat = Math.floor(Date.now() / 1000) - cacheCtx.age;
                    const exp = iat + cacheCtx.maxage;
                    const head = {
                        iat,
                        exp,
                        status: finalStatus,
                        message: finalStatusMessage,
                        type: contentType,
                        length: contentLength || Buffer.byteLength(buffer).toString(),
                        encoding: contentEncoding,
                    };
                    _cache.set(key, { head, body: buffer }, { ttl: realttl }).finally(() => signal.emit('finish'));
                }
                else {
                    signal.emit('finish');
                }
            };
        });
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FjaGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvYXBpL21pZGRsZXdhcmUvY2FjaGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFlBQVksRUFBRSxJQUFJLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFFakQsT0FBTyxFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDbEMsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUkxQyxPQUFPLEVBQUUsTUFBTSxJQUFJLENBQUM7QUFFcEIsT0FBTyxFQUFFLEtBQUssRUFBWSxNQUFNLDBCQUEwQixDQUFDO0FBQzNELE9BQU8sSUFBSSxNQUFNLDZCQUE2QixDQUFDO0FBQy9DLE9BQU8sVUFBdUIsTUFBTSxrQ0FBa0MsQ0FBQztBQUN2RSxPQUFPLGdCQUFnQixNQUFNLDBDQUEwQyxDQUFDO0FBQ3hFLE9BQU8saUJBQWlCLE1BQU0saURBQWlELENBQUM7QUFFaEYsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUNwQyxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUVqRCxNQUFNLGNBQWMsR0FBb0QsRUFBRSxDQUFDO0FBQzNFLE1BQU0sY0FBYyxHQUE2QyxFQUFFLENBQUM7QUFFcEUsTUFBTSxXQUFXLEdBQUcsSUFBSSxPQUFPLEVBQXlCLENBQUM7QUFFekQsTUFBTSxVQUFVLFdBQVcsQ0FBQyxHQUFnQjtJQUMxQyxPQUFPLFdBQVcsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksS0FBSyxDQUFDLFFBQVEsRUFBRSxDQUFDO0FBQ2xELENBQUM7QUFFRCxNQUFNLENBQUMsT0FBTyxVQUFVLGVBQWUsQ0FBb0QsRUFDekYsR0FBRyxFQUNILEdBQUcsR0FJSjtJQUNDLE9BQU8sS0FBSyxVQUFVLEtBQUssQ0FBQyxHQUFHLEVBQUUsSUFBSTtRQUduQyxJQUFJLEdBQUcsQ0FBQyxN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