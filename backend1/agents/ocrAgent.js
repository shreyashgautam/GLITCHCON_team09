require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

function getGemini(apiKeyOverride) {
  const key = apiKeyOverride || process.env.GEMINI_API_KEY;
  if (!key) return null;
  return new GoogleGenerativeAI(key);
}

function detectMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".txt") return "text/plain";
  return "application/octet-stream";
}

function buildExpectedSchema() {
  return {
    patient_name: "string|null",
    date: "YYYY-MM-DD|null",
    symptoms: ["string"],
    medications: [
      {
        name: "string",
        dose: "string|null",
        frequency: "string|null",
        route: "string|null",
      },
    ],
    diagnosis: ["string"],
    allergies: ["string"],
    tests_recommended: ["string"],
    clinical_summary: "string",
    lab_results: [
      {
        test: "string",
        value: "number|string|null",
        unit: "string|null",
        date: "YYYY-MM-DD|null",
        status: "string|null",
        referenceRange: "string|null",
      },
    ],
    raw_text: "string",
    extraction_warnings: ["string"],
  };
}

function heuristicExtract(rawText) {
  const text = rawText || "";
  const compact = text.replace(/\r/g, "");
  const lines = compact.split("\n").map((l) => l.trim()).filter(Boolean);

  const meds = [];
  for (const line of lines) {
    if (/(tablet|tab|capsule|cap|mg|ml|once|twice|daily|bd|od|hs)/i.test(line)) {
      meds.push(line);
    }
  }

  const bpMatch = compact.match(/(?:BP|Blood\s*Pressure)\s*[:\-]?\s*(\d{2,3})\s*\/\s*(\d{2,3})/i);
  const hba1cMatch = compact.match(/HbA1c\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i);
  const crMatch = compact.match(/(?:Creatinine|Serum\s*Creatinine)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i);
  const egfrMatch = compact.match(/eGFR\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i);
  const hbMatch = compact.match(/(?:Haemoglobin|Hemoglobin|Hb)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i);

  return {
    patient_name: null,
    symptoms: [],
    medications: meds.slice(0, 20),
    diagnosis: [],
    allergies: [],
    tests_recommended: [],
    clinical_summary: lines.slice(0, 12).join(" "),
    lab_results: {
      BloodPressure: bpMatch ? { systolic: Number(bpMatch[1]), diastolic: Number(bpMatch[2]) } : null,
      HbA1c: hba1cMatch ? Number(hba1cMatch[1]) : null,
      SerumCreatinine: crMatch ? Number(crMatch[1]) : null,
      eGFR: egfrMatch ? Number(egfrMatch[1]) : null,
      Haemoglobin: hbMatch ? Number(hbMatch[1]) : null,
    },
    raw_text: compact.slice(0, 20000),
  };
}

async function llmStructure(rawText, apiKeyOverride, modelOverride) {
  const genAI = getGemini(apiKeyOverride);
  if (!genAI) return null;

  const model = genAI.getGenerativeModel({
    model: modelOverride || "gemini-3-flash-preview",
    systemInstruction: "Extract medical text into strict JSON only.",
  });

  const prompt = `Extract structured clinical data from this OCR text and return JSON only.
Schema:
{
  "patient_name": "string|null",
  "symptoms": ["string"],
  "medications": ["string"],
  "diagnosis": ["string"],
  "allergies": ["string"],
  "tests_recommended": ["string"],
  "clinical_summary": "string",
  "lab_results": {
    "BloodPressure": {"systolic": number, "diastolic": number} | null,
    "HbA1c": number | null,
    "SerumCreatinine": number | null,
    "eGFR": number | null,
    "Haemoglobin": number | null
  }
}

OCR TEXT:
${rawText.slice(0, 30000)}`;

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const text = result.response?.text?.() || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return null;
  }
}

async function processUploadedDocument(filePath, apiKeyOverride, modelOverride) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const genAI = getGemini(apiKeyOverride);
    if (!genAI) {
      return {
        success: false,
        error: "Gemini is not configured",
        message: "Set GEMINI_API_KEY or pass apiKey in request body.",
      };
    }

    const mimeType = detectMimeType(filePath);
    const ext = path.extname(filePath).toLowerCase();

    // Allow plain text uploads mainly for testing.
    if (ext === ".txt") {
      const rawText = fs.readFileSync(filePath, "utf8");
      if (!rawText || !rawText.trim()) {
        return { success: false, error: "Uploaded text file was empty" };
      }
      const llmOutput = await llmStructure(rawText, apiKeyOverride, modelOverride);
      const structured = llmOutput || heuristicExtract(rawText);
      return {
        success: true,
        source_file: filePath,
        raw_text: rawText.slice(0, 20000),
        structured,
        parser: llmOutput ? "gemini_text_json_extractor" : "heuristic_fallback",
      };
    }

    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString("base64");

    const model = genAI.getGenerativeModel({
      model: modelOverride || "gemini-3-flash-preview",
      systemInstruction:
        "You extract clinical information from medical documents. Return strict JSON only; no markdown, no prose.",
    });

    const prompt = `You are given a patient's uploaded clinical document (may include handwriting).
Tasks:
1) Transcribe the document to raw_text (best-effort, include uncertain words marked with [?]).
2) Extract structured clinical data into the JSON schema below.
3) If handwriting/values are unclear, populate extraction_warnings with short reasons and leave fields null rather than guessing.

Return ONE JSON object only matching this schema (keys must match exactly):
${JSON.stringify(buildExpectedSchema(), null, 2)}
`;

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                data: base64,
                mimeType,
              },
            },
          ],
        },
      ],
    });

    const text = result.response?.text?.() || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        success: false,
        error: "Gemini did not return JSON",
        message: text.slice(0, 2000),
      };
    }

    let structured = null;
    try {
      structured = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return { success: false, error: "Failed to parse Gemini JSON", message: e.message };
    }

    const rawText = typeof structured?.raw_text === "string" ? structured.raw_text : "";
    if (!rawText.trim()) {
      // Still allow success if structured fields exist, but mark warning for downstream.
      structured.extraction_warnings = Array.isArray(structured.extraction_warnings)
        ? [...structured.extraction_warnings, "raw_text was empty; handwriting may be unreadable"]
        : ["raw_text was empty; handwriting may be unreadable"];
    }

    return {
      success: true,
      source_file: filePath,
      raw_text: rawText.slice(0, 20000),
      structured,
      parser: "gemini_vision_json_extractor",
    };
  } catch (error) {
    return {
      success: false,
      error: "OCR agent failed",
      message: error.message,
    };
  }
}

module.exports = { processUploadedDocument };
