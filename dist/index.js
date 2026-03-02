"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const app_1 = __importDefault(require("./api/app"));
const PORT = parseInt(process.env.PORT || "4000", 10);
app_1.default.listen(PORT, () => {
    console.log(`🚀 Sahayog AI Backend running on http://localhost:${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`   API: http://localhost:${PORT}/api/v1`);
});
//# sourceMappingURL=index.js.map