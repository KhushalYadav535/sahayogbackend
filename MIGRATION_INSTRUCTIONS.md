# BRD v4.0 Migration Instructions

## Database Connection Issue

The migration failed because the database at `db.prisma.io:5432` is not reachable. This could be due to:
- Database server is down or paused
- Network/firewall blocking the connection
- Incorrect DATABASE_URL in `.env` file
- Prisma Accelerate/Cloud service not provisioned

## Solution Options

### Option 1: Fix Database Connection (Recommended)

1. **Check your `.env` file**:
   ```bash
   cd sahyagbackend
   cat .env | grep DATABASE_URL
   ```

2. **Verify database is accessible**:
   - If using Prisma Accelerate: Check your Prisma Cloud dashboard
   - If using local PostgreSQL: Ensure PostgreSQL is running
   - If using cloud provider: Check connection string and network settings

3. **Once connection is restored**, run:
   ```bash
   npx prisma migrate dev --name add_brd_v4_interest_engine
   ```

### Option 2: Manual SQL Migration

If you can't fix the connection immediately, you can run the SQL manually:

1. **Get database access** (via pgAdmin, psql, or database console)

2. **Run the migration SQL**:
   ```bash
   # Copy the SQL from migrations/manual/add_brd_v4_interest_engine.sql
   # Execute it directly on your database
   ```

3. **Mark migration as applied** (if using Prisma Migrate):
   ```bash
   # After running SQL manually, create a migration record:
   npx prisma migrate resolve --applied add_brd_v4_interest_engine
   ```

### Option 3: Use Prisma DB Push (Development Only)

**⚠️ Warning**: `db push` is for development only. Don't use in production.

```bash
npx prisma db push
```

This will sync your schema without creating migration files.

## After Migration

1. **Generate Prisma Client**:
   ```bash
   npx prisma generate
   ```

2. **Seed v4.0 Parameters**:
   ```bash
   npx ts-node scripts/seed-v4-parameters.ts
   ```

3. **Verify Tables Created**:
   ```bash
   npx prisma studio
   # Check for: interest_schemes, interest_scheme_slabs, interest_accruals, member_photos, member_signatures
   ```

## New Tables Created

- `interest_schemes` - Interest rate schemes
- `interest_scheme_slabs` - Slab-based rate configuration
- `interest_scheme_audit` - Audit trail for rate changes
- `interest_accruals` - Daily interest accrual records
- `member_photos` - Member photograph management
- `member_signatures` - Member signature management

## Troubleshooting

### If migration fails with foreign key errors:
- Ensure `tenants` and `members` tables exist first
- Check that referenced columns exist and have correct types

### If you see "relation already exists":
- Tables may have been created manually
- Use `CREATE TABLE IF NOT EXISTS` version of the SQL (provided in manual migration)

### If Prisma Client is out of sync:
```bash
npx prisma generate
```

---

**Next Steps**: Once migration is complete, continue with Interest Engine implementation as per `BRD_V4_IMPLEMENTATION_STATUS.md`
