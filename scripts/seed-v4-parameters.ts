/**
 * Seed BRD v4.0 Parameters to SystemConfig
 * Run: npx ts-node scripts/seed-v4-parameters.ts
 */

import prisma from "../src/db/prisma";

const v4Parameters = [
    // Platform-scope parameters (tenantId = "platform" or null)
    {
        tenantId: null, // Platform-scope
        key: "interest.day.count.convention",
        value: "ACTUAL_365",
        label: "Day-Count Convention (Platform)",
    },
    {
        tenantId: null,
        key: "fdr.senior.citizen.age.years",
        value: "60",
        label: "Senior Citizen Age Threshold (Platform)",
    },
    {
        tenantId: null,
        key: "loan.penal.interest.rate",
        value: "24.00",
        label: "Penal Interest Rate Ceiling % p.a. (Platform - RBI Cap)",
    },
    {
        tenantId: null,
        key: "loan.penal.interest.compounding",
        value: "FALSE",
        label: "Penal Interest Compounding (Platform - RBI Prohibits)",
    },
    {
        tenantId: null,
        key: "member.minor.age.threshold",
        value: "18",
        label: "Minor Age Threshold (Platform)",
    },
    {
        tenantId: null,
        key: "member.photo.mandatory.onboarding",
        value: "TRUE",
        label: "Photo Mandatory on Onboarding (Platform)",
    },
    {
        tenantId: null,
        key: "member.photo.maker.checker.enabled",
        value: "TRUE",
        label: "Photo Maker-Checker Enabled (Platform)",
    },
    {
        tenantId: null,
        key: "member.photo.image.hash.algorithm",
        value: "SHA256",
        label: "Photo Image Hash Algorithm (Platform)",
    },
    {
        tenantId: null,
        key: "member.photo.watermark.enabled",
        value: "TRUE",
        label: "Photo Watermark Enabled (Platform)",
    },
    {
        tenantId: null,
        key: "member.signature.mandatory.onboarding",
        value: "TRUE",
        label: "Signature Mandatory on Onboarding (Platform)",
    },
    {
        tenantId: null,
        key: "member.signature.mismatch.auto.alert",
        value: "TRUE",
        label: "Signature Mismatch Auto Alert (Platform)",
    },
    {
        tenantId: null,
        key: "member.signature.blank.reject.threshold.pct",
        value: "5",
        label: "Signature Blank Reject Threshold % (Platform)",
    },
    {
        tenantId: null,
        key: "maker.checker.sla.live.counter.minutes",
        value: "30",
        label: "Maker-Checker SLA Live Counter Minutes (Platform)",
    },
    {
        tenantId: null,
        key: "fdr.tds.threshold.annual",
        value: "40000",
        label: "FDR TDS Threshold Annual ₹ (Platform - Sec 194A)",
    },
    {
        tenantId: null,
        key: "fdr.tds.rate",
        value: "10.00",
        label: "FDR TDS Rate % (Platform - Statutory)",
    },
    {
        tenantId: null,
        key: "fdr.preclosure.minimum.interest.floor",
        value: "TRUE",
        label: "FDR Pre-closure Minimum Interest Floor (Platform)",
    },
    {
        tenantId: null,
        key: "loan.provision.pct.map",
        value: JSON.stringify({ SUB_STANDARD: 10, DOUBTFUL: 100 }),
        label: "Loan Provision % Map (Platform - RBI Mandated)",
    },
];

async function seedV4Parameters() {
    console.log("Seeding BRD v4.0 parameters...");

    // First, ensure a PLATFORM tenant exists for platform-scope parameters
    let platformTenantId = "PLATFORM";
    try {
        const platformTenant = await prisma.tenant.findUnique({
            where: { id: platformTenantId },
        });

        if (!platformTenant) {
            // Create platform tenant if it doesn't exist
            await prisma.tenant.create({
                data: {
                    id: platformTenantId,
                    name: "Platform (System)",
                    code: "PLATFORM",
                    plan: "enterprise",
                    status: "active",
                },
            });
            console.log("  ✓ Created PLATFORM tenant for platform-scope parameters");
        }
    } catch (err) {
        console.error("  ✗ Error creating/finding PLATFORM tenant:", err);
        // Try to find an existing tenant to use instead
        const anyTenant = await prisma.tenant.findFirst();
        if (anyTenant) {
            platformTenantId = anyTenant.id;
            console.log(`  ⚠ Using existing tenant ${anyTenant.code} for platform parameters`);
        } else {
            console.error("  ✗ No tenants found. Cannot seed platform parameters.");
            await prisma.$disconnect();
            return;
        }
    }

    for (const param of v4Parameters) {
        try {
            const targetTenantId = param.tenantId || platformTenantId;

            // Check if parameter exists
            const existing = await prisma.systemConfig.findFirst({
                where: {
                    key: param.key,
                    tenantId: targetTenantId,
                },
            });

            if (existing) {
                console.log(`  ✓ ${param.key} already exists, skipping`);
                continue;
            }

            await prisma.systemConfig.create({
                data: {
                    tenantId: targetTenantId,
                    key: param.key,
                    value: param.value,
                    label: param.label,
                },
            });

            console.log(`  ✓ Created ${param.key} (tenant: ${targetTenantId === platformTenantId ? "PLATFORM" : targetTenantId})`);
        } catch (err) {
            console.error(`  ✗ Error creating ${param.key}:`, err);
        }
    }

    console.log("\nDone seeding v4.0 parameters!");
    console.log("\nNote: Tenant-scope parameters should be created per tenant during tenant setup.");
    console.log("Tenant-scope parameters include:");
    console.log("  - interest.slab.application.method (default: FLAT)");
    console.log("  - interest.recalculation.max.backdate.days (default: 90)");
    console.log("  - interest.anomaly.threshold.pct (default: 0.01)");
    console.log("  - interest.anomaly.threshold.mode (default: RELATIVE)");
    console.log("  - emi.rounding.mode (default: HALF_EVEN)");
    console.log("  - interest.scheme.checker.role (default: SOCIETY_ADMIN)");
    console.log("  - interest.scheme.large.change.threshold.pct (default: 0.50)");
    console.log("  - maker.checker.sla.hours (default: 4)");
    console.log("  - member.photo.capture.mode, member.photo.max.size.kb, etc.");
    console.log("  - member.signature.capture.mode, member.signature.max.size.kb, etc.");

    await prisma.$disconnect();
}

seedV4Parameters().catch(console.error);
