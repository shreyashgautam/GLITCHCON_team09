const Groq = require("groq-sdk");
const {
  getPatientRecord,
  getMultiplePatientRecords,
  getAllPatients,
  extractPatientIds,
  formatPatientContext,
  getPopulationSummary,
} = require("../tools/patientTools");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Detect query intent ──────────────────────────────────────────────────────
function detectQueryIntent(query) {
  const lower = query.toLowerCase();

  const allKeywords = [
    "all patients",
    "every patient",
    "all cases",
    "population",
    "list all",
    "show all",
    "overview",
    "summarize all",
    "compare all",
    "critical patients",
    "abnormal labs",
    "worsening",
    "high risk",
    "review all",
  ];

  const multiKeywords = [
    "compare",
    "between",
    "vs",
    "versus",
    "both",
    "multiple",
  ];

  if (allKeywords.some((k) => lower.includes(k))) return "all";
  if (multiKeywords.some((k) => lower.includes(k))) return "multi";

  const ids = extractPatientIds(query);
  if (ids.length > 1) return "multi";
  if (ids.length === 1) return "single";

  return "unknown";
}

// ─── Resolve which patient records to load ──────────────────────────────────
function resolvePatientContext(query, patientId = null) {
  const intent = detectQueryIntent(query);

  // Explicit patientId passed from frontend (single patient view)
  if (patientId) {
    const record = getPatientRecord(patientId);
    if (!record) return { error: `Patient ${patientId} not found.`, records: [] };
    return { intent: "single", records: [record] };
  }

  if (intent === "all") {
    const records = getAllPatients(true);
    return { intent: "all", records };
  }

  if (intent === "multi" || intent === "single") {
    const ids = extractPatientIds(query);
    if (ids.length === 0) {
      // No IDs found - return all patients for context
      const records = getAllPatients(true);
      return { intent: "all", records };
    }
    const records = getMultiplePatientRecords(ids);
    return { intent: ids.length > 1 ? "multi" : "single", records };
  }

  // Unknown intent with no IDs - return all patients
  const records = getAllPatients(true);
  return { intent: "all", records };
}

// ─── Build system prompt based on intent ────────────────────────────────────
function buildSystemPrompt(intent, patientCount) {
  const base = `You are an expert AI Medical Assistant helping doctors in a clinical setting.
You provide accurate, concise, and clinically relevant answers based strictly on the patient data provided.
Always be professional, clear, and highlight critical findings.
Format your responses clearly with relevant sections when needed.
Never make up information not present in the data.`;

  if (intent === "all" || patientCount > 1) {
    return (
      base +
      `\n\nYou are reviewing ${patientCount} patient records simultaneously.
When comparing or summarizing multiple patients:
- Identify patterns and critical findings across patients
- Flag high-risk patients clearly
- Provide structured comparisons when asked
- Use patient names and IDs to avoid confusion`
    );
  }

  return (
    base +
    `\n\nYou are reviewing a single patient record.
Provide focused, detailed analysis for this patient.
Highlight any critical lab values, drug interactions, or clinical concerns.`
  );
}

// ─── Main agent function ─────────────────────────────────────────────────────
async function runVoiceAgent(query, patientId = null) {
  try {
    // 1. Resolve patient context
    const { intent, records, error } = resolvePatientContext(query, patientId);

    if (error) return { success: false, response: error };
    if (records.length === 0)
      return { success: false, response: "No patient records found matching your query." };

    // 2. Format patient data for LLM
    const patientContext = formatPatientContext(records);

    // 3. Build population summary header if multi-patient
    let populationHeader = "";
    if (records.length > 1) {
      const summary = getPopulationSummary();
      populationHeader = `POPULATION OVERVIEW: ${summary.totalPatients} total patients in system | ${summary.patientsWithAbnormalLabs} with abnormal labs\n\n`;
    }

    // 4. Build prompt
    const systemPrompt = buildSystemPrompt(intent, records.length);

    const userMessage = `${populationHeader}PATIENT DATA:\n${patientContext}\n\n---\nDOCTOR QUERY: ${query}`;

    // 5. Call Groq LLM
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 1024,
    });

    const response = completion.choices[0]?.message?.content;

    return {
      success: true,
      response,
      meta: {
        intent,
        patientsAnalyzed: records.length,
        patientIds: records.map((r) => r.patient.patient_id),
      },
    };
  } catch (err) {
    console.error("VoiceAgent Error:", err.message);
    return {
      success: false,
      response: `Error processing query: ${err.message}`,
    };
  }
}

module.exports = { runVoiceAgent };
