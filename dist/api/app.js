"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const dotenv_1 = __importDefault(require("dotenv"));
const error_1 = require("./middleware/error");
const idempotency_1 = require("./middleware/idempotency");
// Route imports
const auth_1 = __importDefault(require("./routes/auth"));
const tenants_1 = __importDefault(require("./routes/tenants"));
const platform_billing_1 = __importDefault(require("./routes/platform-billing"));
const platform_rules_1 = __importDefault(require("./routes/platform-rules"));
const platform_config_1 = __importDefault(require("./routes/platform-config"));
const platform_usage_1 = __importDefault(require("./routes/platform-usage"));
const config_1 = __importDefault(require("./routes/config"));
const members_1 = __importDefault(require("./routes/members"));
const sb_1 = __importDefault(require("./routes/sb"));
const loans_1 = __importDefault(require("./routes/loans"));
const deposits_1 = __importDefault(require("./routes/deposits"));
const gl_1 = __importDefault(require("./routes/gl"));
const suspense_1 = __importDefault(require("./routes/suspense"));
const bank_recon_1 = __importDefault(require("./routes/bank-recon"));
const governance_1 = __importDefault(require("./routes/governance"));
const compliance_1 = __importDefault(require("./routes/compliance"));
const me_1 = __importDefault(require("./routes/me"));
const jobs_1 = __importDefault(require("./routes/jobs"));
const users_1 = __importDefault(require("./routes/users"));
const dashboard_1 = __importDefault(require("./routes/dashboard"));
const reports_1 = __importDefault(require("./routes/reports"));
const approvals_1 = __importDefault(require("./routes/approvals"));
const ai_1 = __importDefault(require("./routes/ai"));
const fixed_assets_1 = __importDefault(require("./routes/fixed-assets"));
const risk_controls_1 = __importDefault(require("./routes/risk-controls"));
const security_1 = __importDefault(require("./routes/security"));
const integrations_1 = __importDefault(require("./routes/integrations"));
dotenv_1.default.config();
const app = (0, express_1.default)();
app.set("trust proxy", 1);
// ✅ Filter out undefined values (e.g. if FRONTEND_URL is not set)
const allowedOrigins = [
    process.env.FRONTEND_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "https://sahayogai-ella.vercel.app",
].filter(Boolean);
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, curl, Postman)
        if (!origin)
            return callback(null, true);
        if (allowedOrigins.includes(origin))
            return callback(null, true);
        // Allow any Vercel preview deployments
        if (origin.endsWith(".vercel.app"))
            return callback(null, true);
        callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    credentials: true,
    optionsSuccessStatus: 200,
};
// ✅ Handle preflight BEFORE helmet
app.options("/{*path}", (0, cors_1.default)(corsOptions));
app.use((0, cors_1.default)(corsOptions));
// ✅ Helmet AFTER cors, with crossOriginResourcePolicy relaxed
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: false,
}));
app.use(express_1.default.json({ limit: "10mb" }));
app.use(express_1.default.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== "test") {
    app.use((0, morgan_1.default)("dev"));
}
// Health check
app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});
// API routes
const v1 = express_1.default.Router();
v1.use(idempotency_1.idempotencyMiddleware);
v1.use("/auth", auth_1.default);
v1.use("/platform/tenants", tenants_1.default);
v1.use("/platform/billing", platform_billing_1.default);
v1.use("/platform/rules", platform_rules_1.default);
v1.use("/platform/config", platform_config_1.default);
v1.use("/platform/usage", platform_usage_1.default);
v1.use("/config", config_1.default);
v1.use("/members", members_1.default);
v1.use("/sb", sb_1.default);
v1.use("/loans", loans_1.default);
v1.use("/deposits", deposits_1.default);
v1.use("/gl", gl_1.default);
v1.use("/suspense", suspense_1.default);
v1.use("/bank-recon", bank_recon_1.default);
v1.use("/governance", governance_1.default);
v1.use("/compliance", compliance_1.default);
v1.use("/me", me_1.default);
v1.use("/users", users_1.default);
v1.use("/jobs", jobs_1.default);
v1.use("/dashboard", dashboard_1.default);
v1.use("/reports", reports_1.default);
v1.use("/approvals", approvals_1.default);
v1.use("/ai", ai_1.default);
v1.use("/fixed-assets", fixed_assets_1.default);
v1.use("/risk-controls", risk_controls_1.default);
v1.use("/security", security_1.default);
v1.use("/integrations", integrations_1.default);
app.use("/api/v1", v1);
// 404 & error handling
app.use(error_1.notFound);
app.use(error_1.errorHandler);
exports.default = app;
//# sourceMappingURL=app.js.map