# Dependency versions

Runtime: Node.js 22 LTS, PostgreSQL 14+ (tested on 18.3), Redis 6.2+ (tested on 8.x locally, 7.4 in compose). Exact versions installed from the lockfiles:

### server

| Package | Version |
|---|---|
| @types/bcryptjs | 2.4.6 |
| @types/cookie-parser | 1.4.8 |
| @types/cors | 2.8.17 |
| @types/express | 5.0.0 |
| @types/jsonwebtoken | 9.0.7 |
| @types/luxon | 3.4.2 |
| @types/multer | 1.4.12 |
| @types/node | 22.10.7 |
| @types/nodemailer | 6.4.17 |
| @types/pdfkit | 0.13.8 |
| @types/pg | 8.11.10 |
| @types/supertest | 6.0.2 |
| @types/swagger-ui-express | 4.1.7 |
| @types/web-push | 3.6.4 |
| bcryptjs | 2.4.3 |
| bullmq | 5.34.0 |
| cookie-parser | 1.4.7 |
| cors | 2.8.5 |
| dotenv | 16.4.7 |
| exceljs | 4.4.0 |
| express | 5.1.0 |
| express-rate-limit | 7.5.0 |
| helmet | 8.0.0 |
| ioredis | 5.4.2 |
| jsonwebtoken | 9.0.2 |
| knex | 3.1.0 |
| luxon | 3.5.0 |
| multer | 2.5.0 |
| nodemailer | 10.6.1 |
| pdfkit | 0.15.2 |
| pg | 8.13.1 |
| pino | 9.6.0 |
| pino-http | 10.4.0 |
| socket.io | 4.8.1 |
| supertest | 7.0.0 |
| swagger-ui-express | 5.0.1 |
| tsx | 4.20.6 |
| typescript | 5.7.3 |
| vitest | 3.0.5 |
| web-push | 3.6.7 |
| zod | 4.6.7 |

### web

| Package | Version |
|---|---|
| @playwright/test | 1.49.1 |
| @tanstack/react-query | 5.64.1 |
| @types/react | 18.3.18 |
| @types/react-dom | 18.3.5 |
| @vitejs/plugin-react | 4.3.4 |
| autoprefixer | 10.4.20 |
| clsx | 2.1.1 |
| date-fns | 4.1.0 |
| lucide-react | 0.469.0 |
| postcss | 8.4.49 |
| react | 18.3.1 |
| react-dom | 18.3.1 |
| react-router-dom | 7.18.6 |
| recharts | 2.15.0 |
| socket.io-client | 4.8.1 |
| tailwindcss | 3.4.17 |
| typescript | 5.7.3 |
| vite | 6.0.7 |

`npm audit --omit=dev` (2026-11-21): server — 3 moderate findings, all the transitive `uuid` buffer-bounds advisory via BullMQ/ExcelJS (only affects `uuid.v3/v5/v6` called with a `buf` argument, which this code base does not do); web — 0.
