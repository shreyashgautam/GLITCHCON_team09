const express = require("express");
const router = express.Router();
const { runVoiceAgent } = require("../agents/voiceAgent");
const {
  getAllPatients,
  getPatientRecord,
  getPopulationSummary,
} = require("../tools/patientTools");

// ─── POST /api/voice  (main query endpoint) ──────────────────────────────────
// Body: { query: string, patientId?: string }
router.post("/voice", async (req, res) => {
  const { query, patientId } = req.body;

  if (!query || query.trim() === "") {
    return res.status(400).json({ success: false, error: "Query is required." });
  }

  console.log(`[QUERY] patientId=${patientId || "auto"} | "${query}"`);

  const result = await runVoiceAgent(query, patientId || null);

  return res.json(result);
});

// ─── GET /api/patients  (list all patients for dropdown) ─────────────────────
router.get("/patients", (req, res) => {
  try {
    const patients = getAllPatients(false);
    res.json({ success: true, patients });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/patients/:id  (get single patient record) ──────────────────────
router.get("/patients/:id", (req, res) => {
  try {
    const record = getPatientRecord(req.params.id);
    if (!record) {
      return res.status(404).json({ success: false, error: "Patient not found." });
    }
    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/summary  (population summary) ──────────────────────────────────
router.get("/summary", (req, res) => {
  try {
    const summary = getPopulationSummary();
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;