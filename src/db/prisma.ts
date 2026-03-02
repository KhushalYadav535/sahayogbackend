/* eslint-disable @typescript-eslint/no-require-imports */
require("dotenv/config");
// Prisma v7 with PostgreSQL adapter (engine type "client")
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

type PrismaClientType = InstanceType<typeof PrismaClient>;

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClientType | undefined;
};

const connUrl = process.env.DATABASE_URL;
if (!connUrl || typeof connUrl !== "string") {
    throw new Error("DATABASE_URL must be set in environment");
}
const pool = new Pool({ connectionString: connUrl });
const adapter = new PrismaPg(pool);

const prisma: PrismaClientType =
    globalForPrisma.prisma ??
    new PrismaClient({
        adapter,
        log:
            process.env.NODE_ENV === "development"
                ? ["query", "error", "warn"]
                : ["error"],
    });

if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = prisma;
}

export default prisma;
