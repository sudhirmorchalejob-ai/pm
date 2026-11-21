import { Router } from 'express';

/**
 * OpenAPI 3 document generated from the mounted Express routers, so every
 * implemented endpoint appears in Swagger UI (/api/docs). Request bodies are
 * validated server-side with zod; see each module for the exact schema.
 */
const mounts: { prefix: string; router: Router; tag: string; auth: boolean }[] = [];

export function registerMount(prefix: string, router: Router, tag: string, auth = true) {
  mounts.push({ prefix, router, tag, auth });
}

const DESCRIPTIONS: Record<string, string> = {
  'POST /api/auth/login': 'Sign in with email + password. Returns an access token; the refresh token is set as an httpOnly cookie.',
  'POST /api/auth/refresh': 'Rotate the refresh token (cookie) and obtain a new access token. Reuse of a rotated token revokes the whole session family.',
  'POST /api/tasks/{id}/submit': 'Assignee submits work for review (status → submitted).',
  'POST /api/tasks/{id}/review': 'Reviewer decision: approved (→ completed), revision_required or rejected. Only approval completes a task.',
  'POST /api/notifications/schedules': 'Create a custom reminder at any local date/time in any IANA timezone: one_time, recurring (minutely…yearly) or deadline_offset.',
  'POST /api/future-projects/{id}/convert': 'One-click conversion of a future project to an active project (planning data preserved).',
  'GET /api/reports/{type}': 'type = employees | departments | projects | tasks | pipeline; format = json | xlsx | pdf; period = daily | weekly | monthly | custom.',
};

export function buildOpenApi() {
  const paths: Record<string, any> = {};
  for (const m of mounts) {
    for (const layer of (m.router as any).stack ?? []) {
      const route = layer.route;
      if (!route) continue;
      const routePaths: string[] = Array.isArray(route.path) ? route.path : [route.path];
      for (const rp of routePaths) {
        const full = (m.prefix + (rp === '/' ? '' : rp)).replace(/:(\w+)/g, '{$1}');
        const params = [...full.matchAll(/\{(\w+)\}/g)].map((x) => ({ name: x[1], in: 'path', required: true, schema: { type: x[1].toLowerCase().includes('id') ? 'integer' : 'string' } }));
        for (const method of Object.keys(route.methods)) {
          const key = `${method.toUpperCase()} ${full}`;
          paths[full] ??= {};
          paths[full][method] = {
            tags: [m.tag],
            summary: DESCRIPTIONS[key] ?? `${method.toUpperCase()} ${full.replace('/api', '')}`,
            parameters: params,
            ...(m.auth ? { security: [{ bearer: [] }] } : {}),
            ...(['post', 'put', 'patch'].includes(method) ? { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
            responses: { 200: { description: 'OK' }, 400: { description: 'Validation error' }, 401: { description: 'Unauthenticated' }, 403: { description: 'Forbidden (RBAC)' }, 404: { description: 'Not found / out of scope' } },
          };
        }
      }
    }
  }
  return {
    openapi: '3.0.3',
    info: { title: 'OrgPM API', version: '1.0.0', description: 'Enterprise project & organizational management API. All endpoints except /auth/login and /auth/refresh require a Bearer access token. Permissions and data scope are enforced server-side.' },
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    paths,
  };
}
