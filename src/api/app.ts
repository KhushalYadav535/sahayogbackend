import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";

import { errorHandler, notFound } from "./middleware/error";
import { idempotencyMiddleware } from "./middleware/idempotency";

// Route imports
import authRoutes from "./routes/auth";
import tenantRoutes from "./routes/tenants";
import platformBillingRoutes from "./routes/platform-billing";
import platformRulesRoutes from "./routes/platform-rules";
import platformConfigRoutes from "./routes/platform-config";
import platformUsageRoutes from "./routes/platform-usage";
import configRoutes from "./routes/config";
import memberRoutes from "./routes/members";
import sbRoutes from "./routes/sb";
import loanRoutes from "./routes/loans";
import depositRoutes from "./routes/deposits";
import glRoutes from "./routes/gl";
import suspenseRoutes from "./routes/suspense";
import bankReconRoutes from "./routes/bank-recon";
import governanceRoutes from "./routes/governance";
import complianceRoutes from "./routes/compliance";
import meRoutes from "./routes/me";
import jobRoutes from "./routes/jobs";
import userRoutes from "./routes/users";
import dashboardRoutes from "./routes/dashboard";
import reportsRoutes from "./routes/reports";
import approvalsRoutes from "./routes/approvals";
import aiRoutes from "./routes/ai";

dotenv.config();

const app = express();

// Security & parsing
app.set("trust proxy", 1); // Trust the first proxy (Render)

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        const allowedOrigins = [
            process.env.FRONTEND_URL,
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:3001",
            "http://127.0.0.1:3001",
            "https://sahayogai-ella.vercel.app"
        ];

        // Check if origin matches any of the allowed specific origins
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        // Also allow any vercel.app deploy previews if needed
        if (origin.endsWith('.vercel.app')) {
            return callback(null, true);
        }

        callback(new Error('Not allowed by CORS'));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    credentials: true,
    optionsSuccessStatus: 200,
};

// Handle preflight explicitly
app.options("*", cors(corsOptions));
app.use(cors(corsOptions));

app.use(helmet());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Logging
if (process.env.NODE_ENV !== "test") {
    app.use(morgan("dev"));
}

// Health check
app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API routes
const v1 = express.Router();
v1.use(idempotencyMiddleware);

v1.use("/auth", authRoutes);
v1.use("/platform/tenants", tenantRoutes);
v1.use("/platform/billing", platformBillingRoutes);
v1.use("/platform/rules", platformRulesRoutes);
v1.use("/platform/config", platformConfigRoutes);
v1.use("/platform/usage", platformUsageRoutes);
v1.use("/config", configRoutes);
v1.use("/members", memberRoutes);
v1.use("/sb", sbRoutes);
v1.use("/loans", loanRoutes);
v1.use("/deposits", depositRoutes);
v1.use("/gl", glRoutes);
v1.use("/suspense", suspenseRoutes);
v1.use("/bank-recon", bankReconRoutes);
v1.use("/governance", governanceRoutes);
v1.use("/compliance", complianceRoutes);
v1.use("/me", meRoutes);
v1.use("/users", userRoutes);
v1.use("/jobs", jobRoutes);
v1.use("/dashboard", dashboardRoutes);
v1.use("/reports", reportsRoutes);
v1.use("/approvals", approvalsRoutes);
v1.use("/ai", aiRoutes);

app.use("/api/v1", v1);

// 404 & error handling
app.use(notFound);
app.use(errorHandler);

export default app;
