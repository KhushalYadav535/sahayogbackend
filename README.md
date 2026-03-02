# Sahayog AI Backend

Express + Prisma + PostgreSQL backend for Sahayog AI cooperative society platform.

## Prerequisites

- Node.js 18+
- PostgreSQL (or use Prisma Postgres)
- Redis (optional, for BullMQ workers)

## Setup

1. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — PostgreSQL connection string
   - `JWT_SECRET` — secret for admin/staff tokens
   - `MEMBER_JWT_SECRET` — secret for member portal tokens
   - `REDIS_URL` — Redis URL (default: redis://localhost:6379)
   - `BYTEZ_API_KEY` — optional, for AI duplicate detection
   - `FRONTEND_URL` — frontend origin for CORS (default: http://localhost:3000)

2. Install and generate Prisma:
   ```bash
   npm install
   npx prisma generate
   ```

3. Push schema to DB:
   ```bash
   npm run db:push
   ```

4. Seed default config (optional):
   ```bash
   npm run db:seed
   ```

## Run

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

API: `http://localhost:4000/api/v1`

## Endpoints

- `POST /auth/login` — staff login
- `GET/POST/PATCH /platform/tenants` — tenant CRUD (superadmin)
- `GET/PUT /config/:key` — MDA config (tenant-scoped)
- `GET/POST/PATCH /members` — member CRUD
- `GET/POST /sb/accounts` — SB accounts, deposit, withdraw, transfer
- `GET/POST /loans/*` — loan applications, disburse, EMI pay
- `GET/POST /gl/*` — vouchers, trial balance, P&L
- `GET/POST /me/*` — member self-service (accounts, loans, pay)
- `POST /jobs/day-end` — trigger day-end (SB interest)
- `POST /jobs/month-end` — trigger month-end (NPA)
