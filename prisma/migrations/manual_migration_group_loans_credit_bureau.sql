-- Migration: Add Group Loans (JLG) and Credit Bureau Integration
-- Created: 2025-03-08
-- Features: LN-023 (Group Loan/JLG), LN-024 (CIBIL/Experian Integration)

-- Create GroupLoan table
CREATE TABLE IF NOT EXISTS "group_loans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "groupCode" TEXT NOT NULL,
    "groupType" TEXT NOT NULL DEFAULT 'JLG',
    "totalLoanAmount" DECIMAL(15,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "formedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_loans_pkey" PRIMARY KEY ("id")
);

-- Create GroupLoanMember table
CREATE TABLE IF NOT EXISTS "group_loan_members" (
    "id" TEXT NOT NULL,
    "groupLoanId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "individualLoanAmount" DECIMAL(15,2) NOT NULL,
    "role" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitedAt" TIMESTAMP(3),

    CONSTRAINT "group_loan_members_pkey" PRIMARY KEY ("id")
);

-- Add unique constraint on group_loans
CREATE UNIQUE INDEX IF NOT EXISTS "group_loans_tenantId_groupCode_key" ON "group_loans"("tenantId", "groupCode");

-- Add unique constraint on group_loan_members
CREATE UNIQUE INDEX IF NOT EXISTS "group_loan_members_groupLoanId_memberId_key" ON "group_loan_members"("groupLoanId", "memberId");

-- Add foreign key constraints for group_loans
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'group_loans_tenantId_fkey'
    ) THEN
        ALTER TABLE "group_loans" ADD CONSTRAINT "group_loans_tenantId_fkey" 
        FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- Add foreign key constraints for group_loan_members
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'group_loan_members_groupLoanId_fkey'
    ) THEN
        ALTER TABLE "group_loan_members" ADD CONSTRAINT "group_loan_members_groupLoanId_fkey" 
        FOREIGN KEY ("groupLoanId") REFERENCES "group_loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'group_loan_members_memberId_fkey'
    ) THEN
        ALTER TABLE "group_loan_members" ADD CONSTRAINT "group_loan_members_memberId_fkey" 
        FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- Add groupLoanId to loans table (LN-023)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'loans' AND column_name = 'groupLoanId'
    ) THEN
        ALTER TABLE "loans" ADD COLUMN "groupLoanId" TEXT;
    END IF;
END $$;

-- Add foreign key constraint for loans.groupLoanId
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'loans_groupLoanId_fkey'
    ) THEN
        ALTER TABLE "loans" ADD CONSTRAINT "loans_groupLoanId_fkey" 
        FOREIGN KEY ("groupLoanId") REFERENCES "group_loans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- Add groupLoanId to loan_applications table (LN-023)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'loan_applications' AND column_name = 'groupLoanId'
    ) THEN
        ALTER TABLE "loan_applications" ADD COLUMN "groupLoanId" TEXT;
    END IF;
END $$;

-- Add CIBIL/Experian fields to loans table (LN-024)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'loans' AND column_name = 'cibilScore'
    ) THEN
        ALTER TABLE "loans" ADD COLUMN "cibilScore" DECIMAL(5,2);
    END IF;
END $$;

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'loans' AND column_name = 'cibilReportDate'
    ) THEN
        ALTER TABLE "loans" ADD COLUMN "cibilReportDate" TIMESTAMP(3);
    END IF;
END $$;

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'loans' AND column_name = 'cibilReportId'
    ) THEN
        ALTER TABLE "loans" ADD COLUMN "cibilReportId" TEXT;
    END IF;
END $$;

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'loans' AND column_name = 'experianScore'
    ) THEN
        ALTER TABLE "loans" ADD COLUMN "experianScore" DECIMAL(5,2);
    END IF;
END $$;

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'loans' AND column_name = 'experianReportDate'
    ) THEN
        ALTER TABLE "loans" ADD COLUMN "experianReportDate" TIMESTAMP(3);
    END IF;
END $$;

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'loans' AND column_name = 'experianReportId'
    ) THEN
        ALTER TABLE "loans" ADD COLUMN "experianReportId" TEXT;
    END IF;
END $$;
