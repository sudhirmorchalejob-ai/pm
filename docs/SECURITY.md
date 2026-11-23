# Security

| Area | Implementation |
|---|---|
| Passwords | bcrypt (cost 12), policy ≥ 8 chars with letter + digit, temporary passwords force change at first login, timing-equalised login |
| Brute force | 20 login attempts / 15 min per IP; account lock for 15 min after 5 consecutive failures; global API limit 600 req/min/IP |
| Sessions | 15-min JWT access token (memory only, never localStorage); 14-day opaque refresh token in an `HttpOnly; SameSite=Strict; Secure` cookie scoped to `/api/auth`, stored HMAC-hashed; **rotation on every refresh** with reuse detection that revokes the whole session family; revoke-all on password change/reset/deactivation; per-user session list |
| Tenant isolation | every business table has `organization_id` with forced PostgreSQL row-level security keyed on a per-transaction `app.org_id`; each authenticated request and background job runs in an org-scoped transaction; cross-tenant ids return 404; the app must use a non-superuser DB role (startup warns otherwise) |
| Registration | `POST /api/auth/register` rate-limited (5/hour/IP), password policy enforced, globally unique emails, can be disabled with `ALLOW_REGISTRATION=false` |
| Authorization | every route guarded by permission keys; row-level scoping on every query; out-of-scope = 404; no self-approval; rank checks on role assignment; permission cache ≤ 10 s |
| Input | Zod schemas on every body/query; Knex parameterised queries (no string-built SQL with user input); whitelisted sort columns; JSON body limit 1 MB |
| Files | extension + MIME allow-list, magic-byte verification for binary types, random stored names outside the web root, size limit (25 MB default), downloads authorised through the owning task/project, `Content-Disposition: attachment` + `nosniff` |
| Transport | helmet security headers, strict CORS allow-list (`CORS_ORIGINS`), HTTPS required in production (secure cookies) |
| Secrets | environment variables only; startup refuses default JWT secrets in production; `.env` git-ignored |
| Checklists | answers locked after submission; revisions need a reason + expected revision (409 on stale edits) and are append-only (DB trigger); attachments downloadable only by the employee or supervisors in scope; deactivated employees receive no assignments or notifications |
| Audit | append-only `audit_logs` (DB trigger blocks UPDATE/DELETE) recording actor, IP, user agent, before/after diffs |
| Privacy | confidential employee data (performance, reports, contact details) only via scoped endpoints; the people picker exposes name/designation/department only |
| Errors | generic 500 responses; DB constraint errors mapped to 400/409 without SQL text |
