const fs = require("fs");
const path = require("path");

// ─── Load raw JSON files ─────────────────────────────────────────────────────
function loadJSON(filename) {
  const filePath = path.join(__dirname, "../data", filename);
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// ─── Build full record for a single patient ──────────────────────────────────
function getPatientRecord(patientId) {
  const patients = loadJSON("patients.json");
  const labs = loadJSON("labs.json");
  const medications = loadJSON("medications.json");
  const visits = loadJSON("visits.json");

  const patient = patients.find(
    (p) => p.patient_id.toUpperCase() === patientId.toUpperCase()
  );

  if (!patient) return null;

  const id = patient.patient_id;

  return {
    patient,
    labs: labs
      .filter((l) => l.patient_id === id)
      .sort((a, b) => new Date(b.date) - new Date(a.date)),
    medications: medications
      .filter((m) => m.patient_id === id)
      .sort((a, b) => b.active - a.active),
    visits: visits
      .filter((v) => v.patient_id === id)
      .sort((a, b) => new Date(b.date) - new Date(a.date)),
  };
}

// ─── Build records for multiple patients ────────────────────────────────────
function getMultiplePatientRecords(patientIds) {
  return patientIds
    .map((id) => getPatientRecord(id))
    .filter((record) => record !== null);
}

// ─── Get all patients (list or full records) ─────────────────────────────────
function getAllPatients(fullRecords = false) {
  const patients = loadJSON("patients.json");
  if (!fullRecords) return patients;
  return patients.map((p) => getPatientRecord(p.patient_id));
}

// ─── Extract patient IDs mentioned in a query ────────────────────────────────
function extractPatientIds(query) {
  const patients = loadJSON("patients.json");

  const foundIds = new Set();

  // Match P001, P002 style IDs
  const idPattern = /P\d{3,}/gi;
  const idMatches = query.match(idPattern);
  if (idMatches) idMatches.forEach((id) => foundIds.add(id.toUpperCase()));

  // Match patient names (case-insensitive partial match)
  for (const patient of patients) {
    const nameParts = patient.name.toLowerCase().split(" ");
    const queryLower = query.toLowerCase();
    if (nameParts.some((part) => part.length > 3 && queryLower.includes(part))) {
      foundIds.add(patient.patient_id);
    }
  }

  return [...foundIds];
}

// ─── Format patient data as context string for the LLM ──────────────────────
function formatPatientContext(records) {
  if (!Array.isArray(records)) records = [records];

  return records
    .map((record) => {
      const { patient, labs, medications, visits } = record;

      const activeMeds = medications.filter((m) => m.active);
      const inactiveMeds = medications.filter((m) => !m.active);
      const abnormalLabs = labs.filter(
        (l) => l.status === "High" || l.status === "Low"
      );

      return `
============================
PATIENT: ${patient.name} (${patient.patient_id})
============================
Demographics: Age ${patient.age}, ${patient.gender}, Blood Group: ${patient.blood_group}, City: ${patient.city}
BMI: ${patient.bmi} | Smoking: ${patient.smoking} | Alcohol: ${patient.alcohol}
Diagnoses: ${patient.diagnosis.join(", ")}
Allergies: ${patient.allergies.length ? patient.allergies.join(", ") : "None"}

--- ACTIVE MEDICATIONS (${activeMeds.length}) ---
${activeMeds.map((m) => `• ${m.drug} ${m.dose} – ${m.frequency} [${m.route}] by ${m.prescribed_by} since ${m.start_date}`).join("\n") || "None"}

--- INACTIVE MEDICATIONS (${inactiveMeds.length}) ---
${inactiveMeds.map((m) => `• ${m.drug} ${m.dose} – stopped ${m.end_date}`).join("\n") || "None"}

--- LAB RESULTS (${labs.length} total, ${abnormalLabs.length} abnormal) ---
${labs.map((l) => `• [${l.date}] ${l.test}: ${l.value} ${l.unit} – ${l.status} (Normal: ${l.normal_range}) @ ${l.lab_name}`).join("\n") || "None"}

--- VISIT HISTORY (${visits.length} visits) ---
${visits.map((v) => `• [${v.date}] ${v.doctor} (${v.department}) | ${v.visit_type} | BP: ${v.bp_systolic}/${v.bp_diastolic} mmHg, HR: ${v.pulse_bpm} bpm, Weight: ${v.weight_kg}kg\n  Symptoms: ${v.symptoms.join(", ")}\n  Notes: ${v.doctor_notes}`).join("\n\n") || "None"}
`.trim();
    })
    .join("\n\n");
}

// ─── Get summary stats across all patients ──────────────────────────────────
function getPopulationSummary() {
  const allRecords = getAllPatients(true);
  const abnormalPatients = allRecords.filter((r) =>
    r.labs.some((l) => l.status === "High" || l.status === "Low")
  );

  return {
    totalPatients: allRecords.length,
    patientsWithAbnormalLabs: abnormalPatients.length,
    patientList: allRecords.map((r) => ({
      id: r.patient.patient_id,
      name: r.patient.name,
      age: r.patient.age,
      diagnoses: r.patient.diagnosis,
      activeMedCount: r.medications.filter((m) => m.active).length,
      recentVisit: r.visits[0]?.date || "None",
    })),
  };
}

module.exports = {
  getPatientRecord,
  getMultiplePatientRecords,
  getAllPatients,
  extractPatientIds,
  formatPatientContext,
  getPopulationSummary,
};