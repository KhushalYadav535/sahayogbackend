/**
 * Seed: Tenant + Superadmin + Admin + Staff
 * Run: npx tsx scripts/seed-initial-users.ts
 */
import "dotenv/config";
import bcrypt from "bcrypt";
import prisma from "../src/db/prisma";

const SUPERADMIN_EMAIL = "sdsiteadmin@sentientdigital.in";
const SUPERADMIN_PASSWORD = "Sentient1234@";
const DEFAULT_PASSWORD = "Sentient1234@"; // for admin & staff

async function main() {
    // 1. Create tenant
    const tenantCode = "SD001";
    let tenant = await prisma.tenant.findUnique({ where: { code: tenantCode } });
    if (!tenant) {
        tenant = await prisma.tenant.create({
            data: {
                name: "Sentient Digital Society",
                code: tenantCode,
                district: "Pune",
                state: "Maharashtra",
                plan: "enterprise",
                status: "active",
            },
        });
        console.log("Created tenant:", tenant.name, "(", tenant.code, ")");
    } else {
        console.log("Tenant exists:", tenant.code);
    }

    // 2. Superadmin (platform-level, no tenant)
    const pwHash = await bcrypt.hash(SUPERADMIN_PASSWORD, 12);
    let superadmin = await prisma.user.findUnique({ where: { email: SUPERADMIN_EMAIL } });
    if (!superadmin) {
        superadmin = await prisma.user.create({
            data: {
                email: SUPERADMIN_EMAIL,
                passwordHash: pwHash,
                name: "Sentient Site Admin",
                role: "superadmin",
                status: "active",
                tenantId: null,
            },
        });
        console.log("Created superadmin:", superadmin.email);
    } else {
        await prisma.user.update({
            where: { id: superadmin.id },
            data: { passwordHash: pwHash, role: "superadmin", name: "Sentient Site Admin" },
        });
        console.log("Updated superadmin:", superadmin.email);
    }

    // 3. Admin & Staff for tenant
    const adminHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);
    const users = [
        { email: "admin@sentientdigital.in", name: "Sentient Admin", role: "admin" as const },
        { email: "staff@sentientdigital.in", name: "Sentient Staff", role: "staff" as const },
    ];

    for (const u of users) {
        const existing = await prisma.user.findUnique({ where: { email: u.email } });
        if (!existing) {
            await prisma.user.create({
                data: {
                    email: u.email,
                    passwordHash: adminHash,
                    name: u.name,
                    role: u.role,
                    tenantId: tenant.id,
                    status: "active",
                },
            });
            console.log("Created", u.role, ":", u.email);
        } else {
            console.log("User exists:", u.email);
        }
    }

    console.log("\n--- Done ---");
    console.log("Superadmin login: " + SUPERADMIN_EMAIL + " / " + SUPERADMIN_PASSWORD);
    console.log("Tenant users (admin/staff): same password " + DEFAULT_PASSWORD);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
