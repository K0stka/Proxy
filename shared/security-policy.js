import { z } from 'zod';
import { isIP } from 'node:net';

const mode = z.enum(['block', 'monitor', 'off']);
export const securityPolicySchema = z.object({
  mode: mode.default('block'), waf: z.boolean().default(true),
  behavior: z.boolean().default(true), reputation: z.boolean().default(true),
  updates: z.boolean().default(true), duration: z.enum(['1h', '4h', '24h']).default('4h'),
  appsecExceptions: z.object({
    socketIo: z.boolean().default(true),
  }).strip().default({ socketIo: true }),
  failure: z.enum(['allow', 'deny']).default('allow'),
  routes: z.record(z.string().regex(/^(?:catch-all|management|[0-9a-f-]{36})$/), z.enum(['inherit', 'block', 'monitor', 'off']))
    .refine((value) => Object.keys(value).length <= 512, 'Too many service overrides').default({}),
  exceptions: z.array(z.object({
    ip: z.string().refine((v) => !!isIP(v), 'Enter an IPv4 or IPv6 address'),
    note: z.string().trim().max(200).default(''),
  }).strict()).max(256).default([]),
}).strict();
export const defaultSecurityPolicy = securityPolicySchema.parse({});
