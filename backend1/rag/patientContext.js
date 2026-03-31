const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

let MongoClient = null;
try {
  ({ MongoClient } = require('mongodb'));
} catch {
  MongoClient = null;
}

const DATASET_DIR = process.env.DATASET_DIR ? path.resolve(process.env.DATASET_DIR) : null;

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function deriveAlertsFromLabs(labs = []) {
  return labs
    .filter((l) => {
      const status = String(l.status || '').toLowerCase();
      return status.includes('high') || status.includes('critical') || status.includes('abnormal');
    })
    .slice(0, 8)
    .map((l) => ({
      severity: String(l.status || '').toLowerCase().includes('critical') ? 'high' : 'medium',
      message: `${l.test}: ${l.status} (${l.value}${l.unit || ''})`,
      date: l.date || null,
    }));
}

function normalizeBundle(patient, visits, medications, labs, alerts) {
  if (!patient) return null;
  return {
    patient: {
      patient_id: patient.patient_id || patient.id,
      name: patient.name,
      age: patient.age,
      gender: patient.gender,
      diagnosis: patient.diagnosis || patient.primaryDiagnosis || [],
      allergies: patient.allergies || [],
      lastVisit:
        (visits || []).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]?.date || null,
    },
    visits: (visits || []).map((v) => ({
      encounter_id: v.encounter_id || null,
      source_document_id: v.source_document_id || null,
      visit_id: v.visit_id || null,
      date: v.date || null,
      doctor: v.doctor || null,
      department: v.department || null,
      visit_type: v.visit_type || v.visitType || null,
      doctor_notes: v.doctor_notes || v.clinicalNote || v.plan || '',
      symptoms: Array.isArray(v.symptoms)
        ? v.symptoms
        : v.chiefComplaint
        ? String(v.chiefComplaint).split(',').map((s) => s.trim())
        : [],
      bp_systolic: v.bp_systolic ?? v.bp?.systolic ?? null,
      bp_diastolic: v.bp_diastolic ?? v.bp?.diastolic ?? null,
      pulse_bpm: v.pulse_bpm ?? v.pulse ?? null,
      temperature_c: v.temperature_c ?? v.temperature ?? null,
      spo2_pct: v.spo2_pct ?? v.spo2 ?? null,
      weight_kg: v.weight_kg ?? v.weight ?? null,
    })),
    medications: (medications || []).map((m) => ({
      encounter_id: m.encounter_id || null,
      source_document_id: m.source_document_id || null,
      med_id: m.med_id || null,
      drug: m.drug || m.name,
      dose: m.dose || '',
      frequency: m.frequency || '',
      route: m.route || '',
      start_date: m.start_date || m.since || null,
      end_date: m.end_date || null,
      prescribed_by: m.prescribed_by || null,
      active: m.active ?? true,
    })),
    labs: labs || [],
    documents: [],
    alerts: alerts && alerts.length ? alerts : deriveAlertsFromLabs(labs || []),
  };
}

async function getFromMongo(patientId) {
  if (!MongoClient || !process.env.MONGO_URI) return null;
  const dbName = process.env.MONGO_DB_NAME || 'medai';
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db(dbName);
    const normalizedId = String(patientId || '').trim().toUpperCase();
    const idRegex = new RegExp(`^${normalizedId}$`, 'i');
    const [patient, visits, medications, labs, documents] = await Promise.all([
      db.collection('patients').findOne({
        $or: [{ patient_id: normalizedId }, { patient_id: idRegex }, { id: normalizedId }, { id: idRegex }],
      }),
      db.collection('visits').find({ patient_id: { $regex: idRegex } }).toArray(),
      db.collection('medications').find({ patient_id: { $regex: idRegex } }).toArray(),
      db.collection('labs').find({ patient_id: { $regex: idRegex } }).toArray(),
      db
        .collection('documents')
        .find(
          { patient_id: { $regex: idRegex } },
          { projection: { patient_id: 1, uploaded_at: 1, type: 1, source: 1, extractor: 1, raw_text: 1, file: 1 } }
        )
        .sort({ uploaded_at: -1 })
        .limit(6)
        .toArray(),
    ]);
    if (!patient) return null;
    const bundle = normalizeBundle(patient, visits, medications, labs, []);
    bundle.documents = (documents || []).map((d) => ({
      document_id: d._id || null,
      uploaded_at: d.uploaded_at || null,
      type: d.type || 'unknown',
      source: d.source || null,
      extractor: d.extractor || null,
      file: d.file || null,
      raw_text: d.raw_text || '',
    }));
    return bundle;
  } finally {
    await client.close();
  }
}

function getFromDataset(patientId) {
  if (!DATASET_DIR || !fs.existsSync(DATASET_DIR)) return null;
  const normalizedId = String(patientId || '').trim().toUpperCase();
  const patients = readJson(path.join(DATASET_DIR, 'patients.json'));
  const visits = readJson(path.join(DATASET_DIR, 'visits.json'));
  const medications = readJson(path.join(DATASET_DIR, 'medications.json'));
  const labs = readJson(path.join(DATASET_DIR, 'labs.json'));
  const patient = patients.find((p) => String(p.patient_id || '').trim().toUpperCase() === normalizedId);
  if (!patient) return null;
  return normalizeBundle(
    patient,
    visits.filter((v) => String(v.patient_id || '').trim().toUpperCase() === normalizedId),
    medications.filter((m) => String(m.patient_id || '').trim().toUpperCase() === normalizedId),
    labs.filter((l) => String(l.patient_id || '').trim().toUpperCase() === normalizedId),
    []
  );
}

function normalizeName(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const n = s.length;
  const m = t.length;
  if (!n) return m;
  if (!m) return n;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i += 1) dp[i][0] = i;
  for (let j = 0; j <= m; j += 1) dp[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[n][m];
}

async function getAllPatientsLiteFromMongo() {
  if (!MongoClient || !process.env.MONGO_URI) return null;
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    // Prefer explicit DB name when provided, otherwise use the DB from MONGO_URI.
    const dbName = String(process.env.MONGO_DB_NAME || '').trim();
    const db = dbName ? client.db(dbName) : client.db();
    const rows = await db
      .collection('patients')
      .find(
        {},
        {
          projection: {
            _id: 1,
            patient_id: 1,
            id: 1,
            name: 1,
            age: 1,
            gender: 1,
            diagnosis: 1,
            allergies: 1,
            email: 1,
            phone: 1,
            blood_group: 1,
            bmi: 1,
            city: 1,
            smoking: 1,
            alcohol: 1,
            status: 1,
            lastVisit: 1,
          },
        }
      )
      .toArray();
    return rows.map((r) => ({
      _id: r._id,
      patient_id: r.patient_id || r.id,
      name: r.name,
      age: r.age ?? null,
      gender: r.gender ?? null,
      diagnosis: r.diagnosis || [],
      allergies: r.allergies || [],
      email: r.email || null,
      phone: r.phone || null,
      blood_group: r.blood_group || null,
      bmi: r.bmi ?? null,
      city: r.city || null,
      smoking: r.smoking || null,
      alcohol: r.alcohol || null,
      status: r.status || null,
      lastVisit: r.lastVisit || null,
    }));
  } finally {
    await client.close();
  }
}

function getAllPatientsLiteFromDataset() {
  if (!DATASET_DIR || !fs.existsSync(DATASET_DIR)) return [];
  const patients = readJson(path.join(DATASET_DIR, 'patients.json'));
  return patients.map((p) => ({
    patient_id: p.patient_id,
    name: p.name,
    diagnosis: p.diagnosis || [],
  }));
}

async function getAllPatientsLite() {
  const mongo = await getAllPatientsLiteFromMongo().catch(() => null);
  if (mongo && mongo.length) return mongo;
  return getAllPatientsLiteFromDataset();
}

function extractLikelyPatientName(query) {
  const text = String(query || '').trim();
  const patterns = [
    /(?:of|for|about)\s+([a-zA-Z][a-zA-Z\s]{2,50})/i,
    /(?:does|is|was)\s+([a-zA-Z][a-zA-Z\s]{1,50})/i,
    /(?:taken by|by)\s+([a-zA-Z][a-zA-Z\s]{1,50})/i,
    /patient\s+([a-zA-Z][a-zA-Z\s]{2,50})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (!m?.[1]) continue;
    const cleaned = m[1]
      .replace(/\b(takes?|take|taking|medications?|medicine|history|details?|issues?|problem|problems|disease|diagnosis|all)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) return cleaned;
  }
  // Fallback: pick a trailing name-like token only for person-oriented questions.
  const personIntent = /\b(about|for|by|does|tell me|medicine|medications|history|issues|problem|disease|diagnosis)\b/i.test(text);
  if (personIntent) {
    const fallback = text
      .replace(/[^a-zA-Z\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((w) => !/^(what|which|who|tell|me|about|medicine|medications|does|do|for|of|by|taken|take|history|all|the|is|are|please)$/i.test(w));
    if (fallback.length) return fallback[fallback.length - 1];
  }
  return null;
}

async function resolvePatientIdByName(name) {
  const target = normalizeName(name)
    .replace(
      /\b(patient|details|detail|history|medications|medicine|disease|diagnosis|summary|consultation|brief|for|about|of|give|me|the|recent|what|is|and|tell|please)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (!target) return null;
  const all = await getAllPatientsLite();
  if (!all.length) return null;

  const exact = all.find((p) => normalizeName(p.name) === target);
  if (exact) return exact;

  const contains = all.find((p) => normalizeName(p.name).includes(target) || target.includes(normalizeName(p.name)));
  if (contains) return contains;

  // Token-level fuzzy match for typos like "vikran" -> "vikram".
  const targetTokens = target.split(' ').filter(Boolean);
  const ranked = all
    .map((p) => {
      const nameNorm = normalizeName(p.name);
      const nameTokens = nameNorm.split(' ').filter(Boolean);
      let best = Number.POSITIVE_INFINITY;
      for (const t of targetTokens) {
        for (const n of nameTokens) {
          const dist = levenshtein(t, n);
          if (dist < best) best = dist;
        }
      }
      return { p, best, nameNorm };
    })
    .sort((a, b) => a.best - b.best);

  const best = ranked[0];
  if (best) {
    const tokenLen = Math.max(...targetTokens.map((t) => t.length), 0);
    const allowed = tokenLen >= 7 ? 2 : tokenLen >= 5 ? 1 : 0;
    if (best.best <= allowed) return best.p;
  }

  return null;
}

async function getPatientContext(patientId) {
  const fromMongo = await getFromMongo(patientId).catch(() => null);
  if (fromMongo) return { source: 'mongo', ...fromMongo };
  const fromDataset = getFromDataset(patientId);
  if (fromDataset) return { source: 'dataset', ...fromDataset };
  return null;
}

module.exports = {
  getPatientContext,
  getAllPatientsLite,
  getAllPatientsLiteFromMongo,
  extractLikelyPatientName,
  resolvePatientIdByName,
};
