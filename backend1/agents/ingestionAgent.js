require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { indexPatient, indexPatientBundle } = require("../rag/vectorStore");
const { getPatientContext } = require("../rag/patientContext");
const { getDb } = require("../db/mongo");

const DATA_DIR = path.join(__dirname, "../data");

function patientFile(patientId) {
  return path.join(DATA_DIR, `patient_${patientId}.json`);
}

function loadPatient(patientId) {
  const file = patientFile(patientId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function savePatient(patientId, data) {
  fs.writeFileSync(patientFile(patientId), JSON.stringify(data, null, 2));
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqStrings(values) {
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

function appendLab(patient, testName, entry) {
  if (!patient.labResults[testName]) patient.labResults[testName] = [];
  patient.labResults[testName].push(entry);
}

function normalizeRecord(patientId, existing) {
  return existing || {
    id: String(patientId),
    name: "Unknown",
    age: null,
    gender: null,
    bloodGroup: null,
    primaryDiagnosis: [],
    secondaryDiagnosis: [],
    allergies: [],
    medications: [],
    labResults: {},
    visits: [],
    clinicalFlags: [],
    overdueTests: [],
  };
}

function coerceString(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function normalizeMedicationItems(value) {
  const items = toArray(value);
  return items
    .map((m) => {
      if (!m) return null;
      if (typeof m === "string") return { name: m, dose: null, frequency: null, route: null };
      return {
        name: coerceString(m.name || m.drug),
        dose: coerceString(m.dose) || null,
        frequency: coerceString(m.frequency) || null,
        route: coerceString(m.route) || null,
      };
    })
    .filter((m) => m && m.name);
}

function normalizeLabRows(value) {
  // Supports both old object-based lab_results and new array-based lab_results.
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((r) => ({
        test: coerceString(r.test),
        value: r.value ?? null,
        unit: coerceString(r.unit) || null,
        date: coerceString(r.date) || null,
        status: coerceString(r.status) || null,
        referenceRange: coerceString(r.referenceRange) || null,
      }))
      .filter((r) => r.test);
  }
  if (typeof value === "object") {
    const rows = [];
    if (typeof value.HbA1c === "number") rows.push({ test: "HbA1c", value: value.HbA1c });
    if (typeof value.SerumCreatinine === "number") rows.push({ test: "SerumCreatinine", value: value.SerumCreatinine });
    if (typeof value.eGFR === "number") rows.push({ test: "eGFR", value: value.eGFR });
    if (typeof value.Haemoglobin === "number") rows.push({ test: "Haemoglobin", value: value.Haemoglobin });
    if (value.BloodPressure && typeof value.BloodPressure.systolic === "number" && typeof value.BloodPressure.diastolic === "number") {
      rows.push({ test: "BloodPressure", value: `${value.BloodPressure.systolic}/${value.BloodPressure.diastolic}`, unit: "mmHg" });
    }
    return rows;
  }
  return [];
}

async function ingestToMongo(patientId, structuredOCRData) {
  const db = await getDb();
  const now = new Date();
  const date = (coerceString(structuredOCRData.date) || now.toISOString().slice(0, 10)).slice(0, 10);
  const patientKey = String(patientId).toUpperCase();

  const diagnosis = uniqStrings(toArray(structuredOCRData.diagnosis));
  const allergies = uniqStrings(toArray(structuredOCRData.allergies));
  const symptoms = uniqStrings(toArray(structuredOCRData.symptoms));
  const tests = uniqStrings(toArray(structuredOCRData.tests_recommended));
  const meds = normalizeMedicationItems(structuredOCRData.medications);
  const labs = normalizeLabRows(structuredOCRData.lab_results);

  // 1) Persist original extraction as a document record (provenance).
  const uploadMeta = structuredOCRData._upload || structuredOCRData._document || structuredOCRData.document_meta || null;
  const docRow = {
    patient_id: patientKey,
    uploaded_at: now.toISOString(),
    source: "PATIENT_PORTAL_UPLOAD",
    extractor: "gemini",
    type: coerceString(structuredOCRData.document_type || structuredOCRData.docType) || "unknown",
    file: uploadMeta
      ? {
          original_filename: coerceString(uploadMeta.original_filename || uploadMeta.originalname),
          mimeType: coerceString(uploadMeta.mimeType || uploadMeta.mimetype),
          size: Number(uploadMeta.size) || null,
        }
      : null,
    raw_text: coerceString(structuredOCRData.raw_text || ""),
    structured: structuredOCRData,
  };
  const docInsert = await db.collection("documents").insertOne(docRow);
  const sourceDocumentId = docInsert.insertedId;

  // 2) Create an encounter linked to this document.
  const encounterRow = {
    patient_id: patientKey,
    date,
    type: "DOCUMENT_UPLOAD",
    source: "OCR_INGESTION",
    source_document_id: sourceDocumentId,
    created_at: now.toISOString(),
  };
  const encounterInsert = await db.collection("encounters").insertOne(encounterRow);
  const encounterId = encounterInsert.insertedId;

  // 3) Upsert patient profile.
  await db.collection("patients").updateOne(
    { patient_id: patientKey },
    {
      $setOnInsert: {
        patient_id: patientKey,
        created_at: now.toISOString(),
      },
      $set: {
        name: structuredOCRData.patient_name || undefined,
        allergies,
        diagnosis,
        lastVisit: date,
        updated_at: now.toISOString(),
      },
    },
    { upsert: true }
  );

  // 4) Insert a visit.
  await db.collection("visits").insertOne({
    patient_id: patientKey,
    encounter_id: encounterId,
    source_document_id: sourceDocumentId,
    date,
    doctor: "OCR Import",
    department: "Medical Records",
    visit_type: "Document Upload",
    symptoms,
    doctor_notes: coerceString(structuredOCRData.clinical_summary || ""),
    plan: tests.join(", "),
    source: "OCR_INGESTION",
    created_at: now.toISOString(),
  });

  // 5) Insert meds (simple append-only; dedupe can be added later).
  if (meds.length) {
    await db.collection("medications").insertMany(
      meds.map((m) => ({
        patient_id: patientKey,
        encounter_id: encounterId,
        source_document_id: sourceDocumentId,
        drug: m.name,
        dose: m.dose || "",
        frequency: m.frequency || "",
        route: m.route || "",
        start_date: date,
        active: true,
        source: "OCR_INGESTION",
        created_at: now.toISOString(),
      }))
    );
  }

  // 6) Insert labs.
  if (labs.length) {
    await db.collection("labs").insertMany(
      labs.map((l) => ({
        patient_id: patientKey,
        encounter_id: encounterId,
        source_document_id: sourceDocumentId,
        test: l.test,
        value: l.value,
        unit: l.unit || "",
        date: l.date || date,
        status: l.status || "unknown",
        normal_range: l.referenceRange || "",
        source: "OCR_INGESTION",
        created_at: now.toISOString(),
      }))
    );
  }

  // 7) Re-index RAG from Mongo bundle (best-effort).
  const bundle = await getPatientContext(patientKey).catch(() => null);
  if (bundle) {
    await indexPatientBundle(bundle);
  }

  return {
    success: true,
    patient_id: patientKey,
    message: "Patient data ingested successfully (MongoDB)",
    medications_count: meds.length,
    labs_count: labs.length,
    diagnoses_count: diagnosis.length,
    documents_written: 1,
    source_document_id: String(sourceDocumentId),
    encounter_id: String(encounterId),
    db: "mongo",
  };
}

async function runIngestionAgent(patientId, structuredOCRData) {
  try {
    if (!patientId || !structuredOCRData) {
      return { success: false, error: "patientId and structuredOCRData are required" };
    }

    // Preferred path: MongoDB-backed ingestion (matches intended workflow).
    if (process.env.MONGO_URI) {
      return await ingestToMongo(patientId, structuredOCRData);
    }

    const patient = normalizeRecord(patientId, loadPatient(patientId));
    const now = new Date().toISOString();

    if (structuredOCRData.patient_name) {
      patient.name = structuredOCRData.patient_name;
    }

    patient.primaryDiagnosis = uniqStrings([
      ...toArray(patient.primaryDiagnosis),
      ...toArray(structuredOCRData.diagnosis),
    ]);

    patient.allergies = uniqStrings([
      ...toArray(patient.allergies),
      ...toArray(structuredOCRData.allergies),
    ]);

    const oldMeds = toArray(patient.medications).map((m) => (typeof m === "string" ? m : m.name)).filter(Boolean);
    const newMeds = normalizeMedicationItems(structuredOCRData.medications).map((m) => m.name);
    patient.medications = uniqStrings([...oldMeds, ...newMeds]).map((name) => ({ name }));

    const tests = toArray(structuredOCRData.tests_recommended);
    const existingTests = toArray(patient.overdueTests).map((t) => (typeof t === "string" ? t : t.test));
    patient.overdueTests = uniqStrings([...existingTests, ...tests]).map((test) => ({ test }));

    const symptoms = toArray(structuredOCRData.symptoms);
    for (const symptom of symptoms) {
      patient.clinicalFlags.push({
        type: "HIGH",
        flag: `Reported symptom: ${symptom}`,
        evidence: "Imported from OCR document",
        recommendation: "Physician review advised",
      });
    }

    const labRows = normalizeLabRows(structuredOCRData.lab_results);
    for (const row of labRows) {
      if (row.test === "BloodPressure" && typeof row.value === "string" && row.value.includes("/")) {
        const m = row.value.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
        if (m) {
          appendLab(patient, "BloodPressure", {
            date: now.slice(0, 10),
            systolic: Number(m[1]),
            diastolic: Number(m[2]),
            source: "OCR_INGESTION",
          });
        }
      } else {
        appendLab(patient, row.test, {
          date: row.date || now.slice(0, 10),
          value: row.value,
          unit: row.unit || undefined,
          status: row.status || undefined,
          referenceRange: row.referenceRange || undefined,
          source: "OCR_INGESTION",
        });
      }
    }

    patient.visits.push({
      date: now.slice(0, 10),
      doctor: "OCR Import",
      department: "Medical Records",
      chiefComplaint: symptoms.join(", ") || "Document ingestion",
      clinicalNote: structuredOCRData.clinical_summary || "",
      plan: tests.join(", "),
      source: "OCR_INGESTION",
    });

    savePatient(patientId, patient);
    await indexPatient(patient);

    return {
      success: true,
      patient_id: String(patientId),
      message: "Patient data ingested successfully (file fallback)",
      medications_count: patient.medications.length,
      visits_count: patient.visits.length,
      diagnoses_count: patient.primaryDiagnosis.length,
      db: "file",
    };
  } catch (error) {
    return {
      success: false,
      error: "Ingestion agent failed",
      message: error.message,
    };
  }
}

module.exports = { runIngestionAgent };
