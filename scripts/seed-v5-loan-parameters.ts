/**
 * Seed BRD v5.0 Loan Management Parameters to SystemConfig
 * Run: npx ts-node scripts/seed-v5-loan-parameters.ts
 */

import prisma from "../src/db/prisma";

// BRD v5.0 Section 6: Parameter Catalogue Additions
const v5LoanParameters = [
  // Tenant-scope parameters
  {
    tenantId: null, // Will be set per tenant during tenant setup
    key: "loan.sanction.authority.matrix",
    value: JSON.stringify([
      { level: 1, maxAmount: 50000, approverRole: "LOAN_OFFICER" },
      { level: 2, maxAmount: 200000, approverRole: "PRESIDENT" },
      { level: 3, maxAmount: 999999999, approverRole: "COMMITTEE" },
    ]),
    label: "Loan Sanction Authority Matrix (Tenant)",
    description: "Multi-level sanction workflow based on loan amount thresholds",
  },
  {
    tenantId: null,
    key: "loan.bureau.min.score",
    value: "600",
    label: "Credit Bureau Minimum Score (Tenant)",
    description: "Minimum CIBIL/Experian score threshold for loan approval",
  },
  {
    tenantId: null,
    key: "loan.disbursement.modes",
    value: JSON.stringify(["CASH", "NEFT", "RTGS", "INTERNAL_TRANSFER", "DEMAND_DRAFT"]),
    label: "Loan Disbursement Modes (Tenant)",
    description: "Available disbursement modes for loan disbursement",
  },
  {
    tenantId: null,
    key: "loan.product.fee.processing.pct",
    value: "1.00",
    label: "Loan Product Processing Fee % (Tenant)",
    description: "Default processing fee percentage for loan products",
  },
  {
    tenantId: null,
    key: "loan.document.checklist.config",
    value: JSON.stringify([]),
    label: "Loan Document Checklist Configuration (Tenant)",
    description: "Product-wise document checklist configuration",
  },
  {
    tenantId: null,
    key: "loan.collateral.ltv.property.pct",
    value: "60.00",
    label: "Loan Collateral LTV Property % (Tenant)",
    description: "Loan-to-Value ratio for property-backed loans (max 80%)",
  },
  {
    tenantId: null,
    key: "loan.sanction.large.threshold",
    value: "500000",
    label: "Loan Sanction Large Threshold ₹ (Tenant)",
    description: "Amount threshold for large loan sanctions",
  },
  {
    tenantId: null,
    key: "loan.sanction.committee.threshold",
    value: "2000000",
    label: "Loan Sanction Committee Threshold ₹ (Tenant)",
    description: "Amount threshold requiring committee approval",
  },
  {
    tenantId: null,
    key: "loan.tranche.max.count",
    value: "4",
    label: "Loan Tranche Maximum Count (Tenant)",
    description: "Maximum number of tranches allowed per loan",
  },
  // Platform-scope parameter
  {
    tenantId: null, // Platform-scope
    key: "loan.product.fee.gst.pct",
    value: "18.00",
    label: "Loan Product GST on Fees % (Platform)",
    description: "GST rate on loan fees - statutory, non-overridable",
  },
];

async function seedV5LoanParameters() {
  console.log("Seeding BRD v5.0 Loan Management parameters...");

  // Get all tenants to seed tenant-scope parameters
  const tenants = await prisma.tenant.findMany({
    where: { status: { not: "offboarded" } },
  });

  if (tenants.length === 0) {
    console.log("⚠ No active tenants found. Parameters will be seeded when tenants are created.");
    console.log("Platform-scope parameters will be created with tenantId = null.");
  }

  let seededCount = 0;
  let skippedCount = 0;

  for (const param of v5LoanParameters) {
    try {
      if (param.tenantId === null && param.key === "loan.product.fee.gst.pct") {
        // Platform-scope parameter - create with null tenantId
        const existing = await prisma.systemConfig.findFirst({
          where: {
            key: param.key,
            tenantId: null,
          },
        });

        if (!existing) {
          await prisma.systemConfig.create({
            data: {
              tenantId: null,
              key: param.key,
              value: param.value,
              label: param.label,
            },
          });
          console.log(`  ✓ Created ${param.key} (Platform-scope)`);
          seededCount++;
        } else {
          console.log(`  ⊙ ${param.key} already exists (Platform-scope), skipping`);
          skippedCount++;
        }
      } else {
        // Tenant-scope parameters - seed for each tenant
        for (const tenant of tenants) {
          const existing = await prisma.systemConfig.findFirst({
            where: {
              key: param.key,
              tenantId: tenant.id,
            },
          });

          if (!existing) {
            await prisma.systemConfig.create({
              data: {
                tenantId: tenant.id,
                key: param.key,
                value: param.value,
                label: param.label,
              },
            });
            console.log(`  ✓ Created ${param.key} for tenant ${tenant.code}`);
            seededCount++;
          } else {
            console.log(`  ⊙ ${param.key} already exists for tenant ${tenant.code}, skipping`);
            skippedCount++;
          }
        }
      }
    } catch (err: any) {
      console.error(`  ✗ Error creating ${param.key}:`, err.message);
    }
  }

  console.log(`\n✓ Seeded ${seededCount} parameters`);
  console.log(`⊙ Skipped ${skippedCount} existing parameters`);
  console.log("\nDone seeding BRD v5.0 Loan Management parameters!");

  await prisma.$disconnect();
}

seedV5LoanParameters().catch(console.error);
