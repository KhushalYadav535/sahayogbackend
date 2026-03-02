"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable @typescript-eslint/no-require-imports */
require("dotenv/config");
// Prisma v7 with PostgreSQL adapter (engine type "client")
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const globalForPrisma = globalThis;
const connUrl = process.env.DATABASE_URL;
if (!connUrl || typeof connUrl !== "string") {
    throw new Error("DATABASE_URL must be set in environment");
}
const pool = new Pool({ connectionString: connUrl });
const adapter = new PrismaPg(pool);
const prisma = globalForPrisma.prisma ??
    new PrismaClient({
        adapter,
        log: process.env.NODE_ENV === "development"
            ? ["query", "error", "warn"]
            : ["error"],
    });
if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = prisma;
}
exports.default = prisma;
//# sourceMappingURL=prisma.js.map