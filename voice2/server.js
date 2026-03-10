require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const voiceRoutes = require("./routes/voiceRoutes");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use("/api", voiceRoutes);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "voiceChat.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n🏥 AI Doctor Assistant running at http://localhost:${PORT}`);
  console.log(`   → Frontend: http://localhost:${PORT}`);
  console.log(`   → API:      http://localhost:${PORT}/api`);
  console.log(`   → Patients: http://localhost:${PORT}/api/patients\n`);
});