/**
 * Platform config seed script — seeds default MDA config for new tenants
 * Run: tsx scripts/seed.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    // Create a default tenant if none exists
    let tenant = await prisma.tenant.findFirst();
    if (!tenant) {
        tenant = await prisma.tenant.create({
            data: {
                name: "Default Society",
                code: "DEFAULT001",
                district: "Pune",
                state: "Maharashtra",
                plan: "starter",
                status: "active",
            },
        });
        console.log("Created default tenant:", tenant.code);
    }

    const loanEligibilityRules = JSON.stringify([
        { field: "age", operator: ">=", value: 21 },
        { field: "share_count", operator: ">=", value: 5 },
        { field: "kyc_status", operator: "==", value: "verified" },
        { field: "membership_months", operator: ">=", value: 6 },
        { field: "active_loan_count", operator: "<=", value: 2 },
    ]);

    const glMatrix = JSON.stringify({
        LOAN_DISBURSEMENT: { DR: "Loans & Advances", CR: "Savings Bank Deposits" },
        EMI_RECEIPT: { DR: "Savings Bank Deposits", CR: "Loan Repayment Suspense" },
        FDR_CREATION: { DR: "Cash/SB", CR: "Fixed Deposits" },
        SB_INTEREST_CREDIT: { DR: "Interest on SB", CR: "Savings Bank Deposits" },
    });

    const configs = [
        { key: "mda_interest_rate_sb", value: "3.5", label: "SB Interest Rate (%)" },
        { key: "mda_min_sb_balance", value: "500", label: "Minimum SB Balance (₹)" },
        { key: "mda_npa_days", value: "90", label: "NPA Days (overdue)" },
        { key: "mda_financial_year_start", value: "04", label: "FY Start Month (1-12)" },
        { key: "loan.eligibility.rules", value: loanEligibilityRules, label: "Loan Eligibility Rules (JSON)" },
        { key: "gl.auto.posting.matrix", value: glMatrix, label: "Auto GL Posting Matrix (JSON)" },
    ];

    for (const c of configs) {
        await prisma.systemConfig.upsert({
            where: { tenantId_key: { tenantId: tenant.id, key: c.key } },
            update: { value: c.value, label: c.label },
            create: { tenantId: tenant.id, key: c.key, value: c.value, label: c.label },
        });
    }
    console.log("Seeded", configs.length, "config keys for tenant", tenant.code);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
