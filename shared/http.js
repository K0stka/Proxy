import http from 'node:http';
import { Problem } from './model.js';

export async function bodyJSON(req, limit = 65536) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new Problem(415, 'Expected a JSON request');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Problem(413, 'Request is too large');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch {
    throw new Problem(400, 'Invalid JSON request');
  }
}
export function json(res, value, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}
export function unixRequest(
  socketPath,
  path,
  { method = 'GET', body, timeout = 12000, service = 'Edge' } = {},
) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path,
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        timeout,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (c) => {
          size += c.length;
          if (size > 2_000_000) response.destroy(new Error('Response too large'));
          else chunks.push(c);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (response.statusCode !== 200)
              reject(
                new Problem(
                  response.statusCode >= 400 && response.statusCode < 500
                    ? response.statusCode
                    : 502,
                  data.error ?? `${service} rejected the request`,
                ),
              );
            else resolve(data);
          } catch {
            reject(new Problem(502, `Invalid ${service.toLowerCase()} response`));
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error(`${service} timed out`)));
    request.on('error', () =>
      reject(
        new Problem(
          503,
          `${service} did not confirm the result. Check the ${service.toLowerCase()} service before retrying.`,
        ),
      ),
    );
    request.end(body ? JSON.stringify(body) : undefined);
  });
}
