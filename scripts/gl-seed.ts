/**
 * GL Seed Script — Sahayog AI
 * Seeds all 137 CoA accounts for a given tenant (or all tenants) on first setup.
 * Usage: npx ts-node scripts/gl-seed.ts [tenantId?]
 */

import prisma from "../src/db/prisma";
import { COA_ACCOUNTS } from "../src/lib/coa-constants";

async function seedGlAccounts(tenantId: string): Promise<number> {
    let seeded = 0;
    for (const account of COA_ACCOUNTS) {
        await prisma.glAccount.upsert({
            where: { tenantId_code: { tenantId, code: account.code } },
            update: {
                name: account.name,
                type: account.type,
                isActive: true,
            },
            create: {
                tenantId,
                code: account.code,
                name: account.name,
                type: account.type,
                parentCode: account.parentCode ?? null,
                isActive: true,
            },
        });
        seeded++;
    }
    return seeded;
}

async function main() {
    const targetTenantId = process.argv[2];

    if (targetTenantId) {
        console.log(`[GL Seed] Seeding tenant: ${targetTenantId}`);
        const count = await seedGlAccounts(targetTenantId);
        console.log(`[GL Seed] ✓ Seeded ${count} accounts for tenant ${targetTenantId}`);
    } else {
        // Seed all active tenants
        const tenants = await prisma.tenant.findMany({
            where: { status: { notIn: ["offboarded"] } },
            select: { id: true, name: true, code: true },
        });

        console.log(`[GL Seed] Seeding ${tenants.length} tenants...`);
        for (const tenant of tenants) {
            const count = await seedGlAccounts(tenant.id);
            console.log(`[GL Seed] ✓ ${tenant.code} (${tenant.name}): ${count} accounts`);
        }
    }

    await prisma.$disconnect();
    console.log("[GL Seed] Done.");
}

main().catch((e) => {
    console.error("[GL Seed] Error:", e);
    process.exit(1);
});
