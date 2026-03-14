-- Migration: Add BRD v4.0 Interest Engine & Member Documents
-- Generated manually due to database connection issues
-- Run this SQL directly on your database when connection is restored

-- ─────────────────────────────────────────────
-- MODULE 16 — Interest Engine & Rate Management
-- ─────────────────────────────────────────────

-- INT-001: Interest Rate Scheme Management
CREATE TABLE IF NOT EXISTS "interest_schemes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "schemeCode" TEXT NOT NULL,
    "schemeName" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "interestMethod" TEXT NOT NULL,
    "compoundingFreq" TEXT NOT NULL,
    "slabApplicationMethod" TEXT NOT NULL DEFAULT 'FLAT',
    "calculationBasis" TEXT NOT NULL,
    "effectiveFromDate" TIMESTAMP(3) NOT NULL,
    "effectiveToDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "makerId" TEXT,
    "checkerId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "rateDeltaPct" DECIMAL(5,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interest_schemes_pkey" PRIMARY KEY ("id")
);

-- INT-002: Slab-based Rate Configuration
CREATE TABLE IF NOT EXISTS "interest_scheme_slabs" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "minAmount" DECIMAL(15,2),
    "maxAmount" DECIMAL(15,2),
    "minTenureDays" INTEGER,
    "maxTenureDays" INTEGER,
    "rate" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interest_scheme_slabs_pkey" PRIMARY KEY ("id")
);

-- INT-013: Interest Audit Trail
CREATE TABLE IF NOT EXISTS "interest_scheme_audit" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "oldParameters" TEXT NOT NULL,
    "newParameters" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "changeDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "approvalDate" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "rateDeltaPct" DECIMAL(5,4),

    CONSTRAINT "interest_scheme_audit_pkey" PRIMARY KEY ("id")
);

-- INT-003, INT-009: Interest Accrual Records
CREATE TABLE IF NOT EXISTS "interest_accruals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "schemeId" TEXT,
    "accrualDate" TIMESTAMP(3) NOT NULL,
    "rateApplied" DECIMAL(5,2) NOT NULL,
    "schemeVersion" TEXT,
    "amountAccrued" DECIMAL(15,2) NOT NULL,
    "calculationBasis" TEXT NOT NULL,
    "posted" BOOLEAN NOT NULL DEFAULT false,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interest_accruals_pkey" PRIMARY KEY ("id")
);

-- MEM-027: Member Photograph Management
CREATE TABLE IF NOT EXISTS "member_photos" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purposeCode" TEXT NOT NULL,
    "captureMode" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "imageHash" TEXT NOT NULL,
    "watermarkMetadata" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "makerId" TEXT,
    "checkerId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_photos_pkey" PRIMARY KEY ("id")
);

-- MEM-028: Member Signature Management
CREATE TABLE IF NOT EXISTS "member_signatures" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purposeCode" TEXT NOT NULL,
    "captureMode" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "imageHash" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "isGuardianSig" BOOLEAN NOT NULL DEFAULT false,
    "guardianValidUntil" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "makerId" TEXT,
    "checkerId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_signatures_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "interest_schemes_tenantId_schemeCode_key" ON "interest_schemes"("tenantId", "schemeCode");
CREATE INDEX IF NOT EXISTS "interest_schemes_tenantId_productType_status_idx" ON "interest_schemes"("tenantId", "productType", "status");
CREATE INDEX IF NOT EXISTS "interest_schemes_tenantId_effectiveFromDate_effectiveToDate_idx" ON "interest_schemes"("tenantId", "effectiveFromDate", "effectiveToDate");

CREATE INDEX IF NOT EXISTS "interest_scheme_slabs_schemeId_idx" ON "interest_scheme_slabs"("schemeId");

CREATE INDEX IF NOT EXISTS "interest_scheme_audit_schemeId_idx" ON "interest_scheme_audit"("schemeId");
CREATE INDEX IF NOT EXISTS "interest_scheme_audit_changeDate_idx" ON "interest_scheme_audit"("changeDate");

CREATE UNIQUE INDEX IF NOT EXISTS "interest_accruals_tenantId_accountId_accountType_accrualDate_key" ON "interest_accruals"("tenantId", "accountId", "accountType", "accrualDate");
CREATE INDEX IF NOT EXISTS "interest_accruals_tenantId_accountId_accountType_idx" ON "interest_accruals"("tenantId", "accountId", "accountType");
CREATE INDEX IF NOT EXISTS "interest_accruals_accrualDate_idx" ON "interest_accruals"("accrualDate");
CREATE INDEX IF NOT EXISTS "interest_accruals_posted_idx" ON "interest_accruals"("posted");

CREATE INDEX IF NOT EXISTS "member_photos_memberId_isCurrent_idx" ON "member_photos"("memberId", "isCurrent");
CREATE INDEX IF NOT EXISTS "member_photos_tenantId_status_idx" ON "member_photos"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "member_photos_status_submittedAt_idx" ON "member_photos"("status", "submittedAt");

CREATE INDEX IF NOT EXISTS "member_signatures_memberId_isCurrent_idx" ON "member_signatures"("memberId", "isCurrent");
CREATE INDEX IF NOT EXISTS "member_signatures_tenantId_status_idx" ON "member_signatures"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "member_signatures_status_submittedAt_idx" ON "member_signatures"("status", "submittedAt");

-- ─────────────────────────────────────────────
-- Foreign Keys
-- ─────────────────────────────────────────────

ALTER TABLE "interest_schemes" ADD CONSTRAINT "interest_schemes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "interest_scheme_slabs" ADD CONSTRAINT "interest_scheme_slabs_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "interest_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "interest_scheme_audit" ADD CONSTRAINT "interest_scheme_audit_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "interest_schemes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "interest_accruals" ADD CONSTRAINT "interest_accruals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "interest_accruals" ADD CONSTRAINT "interest_accruals_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "interest_schemes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "member_photos" ADD CONSTRAINT "member_photos_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_photos" ADD CONSTRAINT "member_photos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "member_signatures" ADD CONSTRAINT "member_signatures_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_signatures" ADD CONSTRAINT "member_signatures_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
