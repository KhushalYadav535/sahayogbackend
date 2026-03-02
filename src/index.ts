import "dotenv/config";
import app from "./api/app";

const PORT = parseInt(process.env.PORT || "4000", 10);

app.listen(PORT, () => {
    console.log(`🚀 Sahayog AI Backend running on http://localhost:${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`   API: http://localhost:${PORT}/api/v1`);
});
