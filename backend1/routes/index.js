const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
let MongoClient = null;
try {
  ({ MongoClient } = require('mongodb'));
} catch {
  MongoClient = null;
}

const tools = require('../tools/patientTools');
const { runAnalysisAgent } = require('../agents/analysisAgent');
const { runSecondOpinionAgent } = require('../agents/secondOpinionAgent');
const { runTriageAgent } = require('../agents/triageAgent');
const { runReceptionist } = require('../agents/receptionistAgent');
const { runNutritionAgent } = require('../agents/nutritionAgent');
const { runIngestionAgent } = require('../agents/ingestionAgent');
const { runTransferAgent } = require('../agents/transferAgent');
const { runRagPatientSummary, runRagDoctorQuery } = require('../agents/ragDoctorAgent');
const { getAllPatientsLiteFromMongo } = require('../rag/patientContext');
const blockchain = require('../blockchain/logger');
const USERS_FILE = path.join(__dirname, '../data/users.json');
const users = require('../data/users.json');

const UPLOAD_DIR = process.env.VERCEL
  ? '/tmp'
  : path.join(__dirname, '../uploads/');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });
const uploadAny = multer({ dest: UPLOAD_DIR });
const DATA_DIR = path.join(__dirname, '../data');
const DRUG_INTERACTIONS_FILE = path.join(DATA_DIR, 'drug_interactions.json');
const DATASET_DIR = process.env.DATASET_DIR ? path.resolve(process.env.DATASET_DIR) : null;

function readJsonIfExists(baseDir, fileName) {
  const fullPath = path.join(baseDir, fileName);
  if (!fs.existsSync(fullPath)) return null;
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function datasetFilesAvailable() {
  if (!DATASET_DIR || !fs.existsSync(DATASET_DIR)) return false;
  const required = ['patients.json', 'visits.json', 'medications.json', 'labs.json'];
  return required.every((name) => fs.existsSync(path.join(DATASET_DIR, name)));
}

function normalizeDatasetSeverity(status = '') {
  const value = String(status).toLowerCase();
  if (value.includes('critical') || value.includes('high')) return 'high';
  if (value.includes('abnormal') || value.includes('borderline') || value.includes('monitor')) return 'medium';
  return 'low';
}

function statusFromSeverityBucket(maxSeverity) {
  if (maxSeverity === 'high') return 'critical';
  if (maxSeverity === 'medium') return 'monitoring';
  return 'stable';
}

function flattenLabResults(patient) {
  const labs = patient?.labResults || {};
  return Object.entries(labs).flatMap(([testName, rows]) =>
    (rows || []).map((row) => ({
      test: testName,
      value: row.value ?? row.systolic ?? null,
      unit: row.unit || (row.systolic ? 'mmHg' : ''),
      date: row.date,
      status: row.status || 'unknown',
      raw: row,
    }))
  );
}

function normalizeSeverity(type = '') {
  const upper = String(type).toUpperCase();
  if (upper === 'CRITICAL' || upper === 'HIGH') return 'high';
  if (upper === 'MEDIUM') return 'medium';
  return 'low';
}

function derivePatientStatus(patient) {
  const flags = patient?.clinicalFlags || [];
  if (flags.some((f) => String(f.type).toUpperCase() === 'CRITICAL')) return 'critical';
  if (flags.some((f) => String(f.type).toUpperCase() === 'HIGH')) return 'monitoring';
  return 'stable';
}

function listPatientsFromData() {
  if (datasetFilesAvailable()) {
    const patients = readJsonIfExists(DATASET_DIR, 'patients.json') || [];
    const visits = readJsonIfExists(DATASET_DIR, 'visits.json') || [];
    const labs = readJsonIfExists(DATASET_DIR, 'labs.json') || [];
    const visitsByPatient = visits.reduce((acc, v) => {
      if (!acc[v.patient_id]) acc[v.patient_id] = [];
      acc[v.patient_id].push(v);
      return acc;
    }, {});
    const labSeverityByPatient = labs.reduce((acc, l) => {
      const sev = normalizeDatasetSeverity(l.status);
      const current = acc[l.patient_id];
      if (!current || (current === 'medium' && sev === 'high') || (current === 'low' && sev !== 'low')) {
        acc[l.patient_id] = sev;
      }
      return acc;
    }, {});

    return patients.map((p) => {
      const pVisits = (visitsByPatient[p.patient_id] || []).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const maxSeverity = labSeverityByPatient[p.patient_id] || 'low';
      return {
        patient_id: p.patient_id,
        name: p.name,
        email: p.email || `${String(p.name || 'patient').toLowerCase().replace(/\s+/g, '.')}@patient.local`,
        age: p.age,
        gender: p.gender,
        diagnosis: p.diagnosis || [],
        allergies: p.allergies || [],
        status: statusFromSeverityBucket(maxSeverity),
        lastVisit: pVisits[0]?.date || null,
      };
    });
  }

  const files = fs.readdirSync(DATA_DIR).filter((name) => /^patient_.*\.json$/i.test(name));
  return files.map((file) => {
    const p = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    const diagnoses = [...(p.primaryDiagnosis || []), ...(p.secondaryDiagnosis || [])];
    return {
      patient_id: p.id,
      name: p.name,
      email: p.email || `${String(p.name || 'patient').toLowerCase().replace(/\s+/g, '.')}@patient.local`,
      age: p.age,
      gender: p.gender,
      diagnosis: diagnoses,
      allergies: p.allergies || [],
      status: derivePatientStatus(p),
      lastVisit: p.visits?.length ? p.visits[p.visits.length - 1].date : null,
    };
  });
}

function toNormalRange(range) {
  if (!range || typeof range !== 'string') return { min: 0, max: 0 };
  const gt = range.match(/^>(\\d+(?:\\.\\d+)?)$/);
  if (gt) return { min: Number(gt[1]), max: Number(gt[1]) };
  const lt = range.match(/^<(\\d+(?:\\.\\d+)?)$/);
  if (lt) return { min: 0, max: Number(lt[1]) };
  const dash = range.match(/(\\d+(?:\\.\\d+)?)\\s*[-–]\\s*(\\d+(?:\\.\\d+)?)/);
  if (dash) return { min: Number(dash[1]), max: Number(dash[2]) };
  return { min: 0, max: 0 };
}

function normalizeMongoLabSeverity(status = '') {
  const value = String(status || '').toLowerCase();
  if (value.includes('critical') || value.includes('high')) return 'high';
  if (value.includes('abnormal') || value.includes('borderline') || value.includes('monitor') || value.includes('low')) return 'medium';
  return 'low';
}

async function dashboardDataFromMongo() {
  if (!MongoClient || !process.env.MONGO_URI) {
    throw new Error('MongoDB is not configured');
  }

  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const dbName = String(process.env.MONGO_DB_NAME || '').trim();
    const db = dbName ? client.db(dbName) : client.db();

    const [rawPatients, rawVisits, rawMeds, rawLabs, rawAlerts] = await Promise.all([
      db
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
        .toArray(),
      db.collection('visits').find({}).toArray(),
      db.collection('medications').find({}).toArray(),
      db.collection('labs').find({}).toArray(),
      db.collection('alerts').find({}).toArray(),
    ]);

    const visits = rawVisits.map((v) => ({
      patient_id: v.patient_id || null,
      date: v.date || null,
      doctor: v.doctor || '',
      department: v.department || '',
      visit_type: v.visit_type || v.visitType || '',
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
    }));

    const medications = rawMeds.map((m) => ({
      patient_id: m.patient_id || null,
      drug: m.drug || m.name || '',
      dose: m.dose || m.dosage || '',
      frequency: m.frequency || '',
      route: m.route || '',
      start_date: m.start_date || m.since || null,
      end_date: m.end_date || null,
      active: m.active ?? true,
    }));

    const labResults = rawLabs.map((l) => ({
      patient_id: l.patient_id || null,
      test: l.test || l.test_name || '',
      value: l.value ?? null,
      unit: l.unit || '',
      date: l.date || null,
      status: l.status || 'unknown',
      normalRange: toNormalRange(l.normal_range || l.referenceRange || ''),
    }));

    const alertsFromCollection = rawAlerts.map((a) => ({
      id: String(a._id || `${a.patient_id}-${a.message || a.type || 'alert'}-${a.date || ''}`),
      patient_id: a.patient_id || null,
      type: a.type || 'alert',
      severity: normalizeSeverity(a.severity || a.type),
      message: a.message || a.title || a.type || 'Clinical alert',
      timestamp: a.date || a.timestamp || new Date().toISOString(),
    }));

    const derivedAlertsFromLabs = labResults
      .filter((l) => normalizeMongoLabSeverity(l.status) !== 'low')
      .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
      .map((l) => ({
        id: `${l.patient_id}-${l.test}-${l.date}`,
        patient_id: l.patient_id,
        type: 'lab',
        severity: normalizeMongoLabSeverity(l.status),
        message: `${l.test}: ${l.status} (${l.value ?? ''}${l.unit || ''})`,
        timestamp: l.date || new Date().toISOString(),
      }));

    const alerts = alertsFromCollection.length > 0 ? alertsFromCollection : derivedAlertsFromLabs;

    const latestVisitByPatient = visits.reduce((acc, v) => {
      if (!v.patient_id) return acc;
      const current = acc[v.patient_id];
      const nextTs = new Date(v.date || 0).getTime();
      const curTs = new Date(current || 0).getTime();
      if (!current || nextTs > curTs) acc[v.patient_id] = v.date;
      return acc;
    }, {});

    const maxSeverityByPatient = alerts.reduce((acc, a) => {
      if (!a.patient_id) return acc;
      const cur = acc[a.patient_id] || 'low';
      if (a.severity === 'high') acc[a.patient_id] = 'high';
      else if (a.severity === 'medium' && cur === 'low') acc[a.patient_id] = 'medium';
      return acc;
    }, {});

    const patients = rawPatients.map((p) => {
      const patientId = p.patient_id || p.id;
      const derivedStatus = maxSeverityByPatient[patientId] === 'high'
        ? 'critical'
        : maxSeverityByPatient[patientId] === 'medium'
        ? 'monitoring'
        : 'stable';

      return {
        _id: p._id || null,
        patient_id: patientId,
        name: p.name,
        email: p.email || `${String(p.name || 'patient').toLowerCase().replace(/\s+/g, '.')}@patient.local`,
        age: p.age ?? null,
        gender: p.gender ?? 'Unknown',
        diagnosis: p.diagnosis || [],
        allergies: p.allergies || [],
        phone: p.phone || null,
        blood_group: p.blood_group || null,
        bmi: p.bmi ?? null,
        city: p.city || null,
        smoking: p.smoking || null,
        alcohol: p.alcohol || null,
        status: p.status || derivedStatus,
        lastVisit: p.lastVisit || latestVisitByPatient[patientId] || null,
      };
    });

    return { patients, visits, medications, labResults, alerts, drugInteractions: [] };
  } finally {
    await client.close();
  }
}

function dashboardDataFromFiles() {
  if (datasetFilesAvailable()) {
    const rawPatients = readJsonIfExists(DATASET_DIR, 'patients.json') || [];
    const rawVisits = readJsonIfExists(DATASET_DIR, 'visits.json') || [];
    const rawMeds = readJsonIfExists(DATASET_DIR, 'medications.json') || [];
    const rawLabs = readJsonIfExists(DATASET_DIR, 'labs.json') || [];
    const rawDrugInteractions =
      readJsonIfExists(DATASET_DIR, 'drug_interactions.json') ||
      readJsonIfExists(DATA_DIR, 'drug_interactions.json') ||
      [];

    const visitsByPatient = rawVisits.reduce((acc, v) => {
      if (!acc[v.patient_id]) acc[v.patient_id] = [];
      acc[v.patient_id].push(v);
      return acc;
    }, {});
    const severityByPatient = rawLabs.reduce((acc, l) => {
      const sev = normalizeDatasetSeverity(l.status);
      const current = acc[l.patient_id];
      if (!current || (current === 'medium' && sev === 'high') || (current === 'low' && sev !== 'low')) {
        acc[l.patient_id] = sev;
      }
      return acc;
    }, {});

    const patients = rawPatients.map((p) => {
      const pVisits = (visitsByPatient[p.patient_id] || []).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const maxSeverity = severityByPatient[p.patient_id] || 'low';
      return {
        patient_id: p.patient_id,
        name: p.name,
        email: p.email || `${String(p.name || 'patient').toLowerCase().replace(/\s+/g, '.')}@patient.local`,
        age: p.age,
        gender: p.gender,
        diagnosis: p.diagnosis || [],
        allergies: p.allergies || [],
        status: statusFromSeverityBucket(maxSeverity),
        lastVisit: pVisits[0]?.date || null,
      };
    });

    const visits = rawVisits.map((v) => ({
      patient_id: v.patient_id,
      date: v.date,
      doctor: v.doctor || '',
      department: v.department || '',
      visit_type: v.visit_type || '',
      doctor_notes: v.doctor_notes || '',
      symptoms: Array.isArray(v.symptoms) ? v.symptoms : [],
      bp_systolic: v.bp_systolic ?? null,
      bp_diastolic: v.bp_diastolic ?? null,
      pulse_bpm: v.pulse_bpm ?? null,
      temperature_c: v.temperature_c ?? null,
      spo2_pct: v.spo2_pct ?? null,
      weight_kg: v.weight_kg ?? null,
    }));

    const medications = rawMeds.map((m) => ({
      patient_id: m.patient_id,
      drug: m.drug,
      dose: m.dose,
      frequency: m.frequency,
      start_date: m.start_date || null,
    }));

    const labResults = rawLabs.map((l) => ({
      patient_id: l.patient_id,
      test: l.test,
      value: l.value,
      unit: l.unit || '',
      date: l.date,
      normalRange: toNormalRange(l.normal_range),
    }));

    // Keep payload compact: latest 2 abnormal items per patient as alert feed.
    const abnormalByPatient = rawLabs
      .filter((l) => normalizeDatasetSeverity(l.status) !== 'low')
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .reduce((acc, lab) => {
        if (!acc[lab.patient_id]) acc[lab.patient_id] = [];
        if (acc[lab.patient_id].length < 2) acc[lab.patient_id].push(lab);
        return acc;
      }, {});

    const alerts = Object.values(abnormalByPatient)
      .flat()
      .map((l) => ({
        id: l.lab_id || `${l.patient_id}-${l.test}-${l.date}`,
        patient_id: l.patient_id,
        type: 'lab',
        severity: normalizeDatasetSeverity(l.status),
        message: `${l.test}: ${l.status} (${l.value}${l.unit || ''})`,
        timestamp: l.date || new Date().toISOString(),
      }));

    const drugInteractions = (rawDrugInteractions || []).map((d) => ({
      drug_a: d.drug1 || d.drug_a,
      drug_b: d.drug2 || d.drug_b,
      severity: d.severity === 'CRITICAL' || d.severity === 'HIGH' ? 'High' : d.severity === 'MEDIUM' ? 'Moderate' : (d.severity || 'Low'),
      risk: d.risk || d.effect || '',
    }));

    return { patients, visits, medications, labResults, alerts, drugInteractions };
  }

  const files = fs.readdirSync(DATA_DIR).filter((name) => /^patient_.*\\.json$/i.test(name));
  const patientSheets = files.map((file) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')));

  const patients = patientSheets.map((p) => ({
    patient_id: p.id,
    name: p.name,
    email: p.email || `${String(p.name || 'patient').toLowerCase().replace(/\\s+/g, '.')}@patient.local`,
    age: p.age,
    gender: p.gender,
    diagnosis: [...(p.primaryDiagnosis || []), ...(p.secondaryDiagnosis || [])],
    allergies: p.allergies || [],
    status: derivePatientStatus(p),
    lastVisit: p.visits?.length ? p.visits[p.visits.length - 1].date : null,
  }));

  const visits = patientSheets.flatMap((p) =>
    (p.visits || []).map((v) => ({
      patient_id: p.id,
      date: v.date,
      doctor: v.doctor || '',
      department: v.department || '',
      visit_type: v.visitType || '',
      doctor_notes: v.clinicalNote || v.plan || '',
      symptoms: v.chiefComplaint ? String(v.chiefComplaint).split(',').map((s) => s.trim()) : [],
      bp_systolic: v.bp?.systolic ?? null,
      bp_diastolic: v.bp?.diastolic ?? null,
      pulse_bpm: v.pulse ?? null,
      temperature_c: v.temperature ?? null,
      spo2_pct: v.spo2 ?? null,
      weight_kg: v.weight ?? null,
    }))
  );

  const medications = patientSheets.flatMap((p) =>
    (p.medications || []).map((m) => ({
      patient_id: p.id,
      drug: m.name,
      dose: m.dose,
      frequency: m.frequency,
      start_date: m.since || null,
    }))
  );

  const labResults = patientSheets.flatMap((p) =>
    Object.entries(p.labResults || {}).flatMap(([test, values]) =>
      (values || []).map((row) => ({
        patient_id: p.id,
        test,
        value: row.value ?? row.systolic ?? 0,
        unit: row.unit || (row.systolic ? 'mmHg' : ''),
        date: row.date,
        normalRange: toNormalRange(row.referenceRange),
      }))
    )
  );

  const alerts = patientSheets.flatMap((p) =>
    (p.clinicalFlags || []).map((f, idx) => ({
      id: `${p.id}-A${idx + 1}`,
      patient_id: p.id,
      type: 'pattern',
      severity: normalizeSeverity(f.type),
      message: f.flag,
      timestamp: p.visits?.length ? p.visits[p.visits.length - 1].date : new Date().toISOString(),
    }))
  );

  let drugInteractions = [];
  if (fs.existsSync(DRUG_INTERACTIONS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(DRUG_INTERACTIONS_FILE, 'utf8'));
    drugInteractions = (raw || []).map((d) => ({
      drug_a: d.drug1,
      drug_b: d.drug2,
      severity: d.severity === 'CRITICAL' || d.severity === 'HIGH' ? 'High' : d.severity === 'MEDIUM' ? 'Moderate' : 'Low',
      risk: d.risk || d.effect || '',
    }));
  }

  return { patients, visits, medications, labResults, alerts, drugInteractions };
}

async function getPatientCaseFromMongo(patientId) {
  if (!MongoClient || !process.env.MONGO_URI) return null;

  const normalizedId = String(patientId || '').trim().toUpperCase();
  if (!normalizedId) return null;

  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const dbName = String(process.env.MONGO_DB_NAME || '').trim();
    const db = dbName ? client.db(dbName) : client.db();
    const idRegex = new RegExp(`^${normalizedId}$`, 'i');

    const [rawPatient, rawVisits, rawMeds, rawLabs, rawAlerts] = await Promise.all([
      db.collection('patients').findOne({
        $or: [{ patient_id: normalizedId }, { patient_id: idRegex }, { id: normalizedId }, { id: idRegex }],
      }),
      db.collection('visits').find({ patient_id: { $regex: idRegex } }).toArray(),
      db.collection('medications').find({ patient_id: { $regex: idRegex } }).toArray(),
      db.collection('labs').find({ patient_id: { $regex: idRegex } }).toArray(),
      db.collection('alerts').find({ patient_id: { $regex: idRegex } }).toArray(),
    ]);

    if (!rawPatient) return null;

    const diagnosis = Array.isArray(rawPatient.diagnosis)
      ? rawPatient.diagnosis
      : rawPatient.diagnosis
      ? [String(rawPatient.diagnosis)]
      : [];

    const visits = rawVisits
      .map((v) => ({
        date: v.date || null,
        doctor: v.doctor || 'On File',
        department: v.department || 'General Medicine',
        chiefComplaint: Array.isArray(v.symptoms) ? v.symptoms.join(', ') : v.chiefComplaint || '',
        clinicalNote: v.doctor_notes || v.clinicalNote || '',
        plan: v.plan || v.doctor_notes || '',
        symptoms: Array.isArray(v.symptoms)
          ? v.symptoms
          : v.chiefComplaint
          ? String(v.chiefComplaint).split(',').map((s) => s.trim())
          : [],
      }))
      .sort((a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime());

    const medications = rawMeds.map((m) => ({
      name: m.drug || m.name || '',
      dose: m.dose || m.dosage || '',
      frequency: m.frequency || '',
      route: m.route || '',
      since: m.start_date || m.since || null,
      active: m.active ?? true,
    }));

    const labResults = {};
    for (const l of rawLabs.sort((a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime())) {
      const testName = l.test || l.test_name || 'Unknown Test';
      if (!labResults[testName]) labResults[testName] = [];
      labResults[testName].push({
        date: l.date || null,
        value: l.value ?? null,
        unit: l.unit || '',
        status: l.status || 'Normal',
        referenceRange: l.normal_range || l.referenceRange || '',
      });
    }

    const clinicalFlags = [
      ...rawAlerts.map((a) => ({
        type: String(a.severity || a.type || 'LOW').toUpperCase(),
        flag: a.message || a.title || a.type || 'Clinical alert',
        date: a.date || a.timestamp || null,
      })),
      ...rawLabs
        .filter((l) => normalizeMongoLabSeverity(l.status) !== 'low')
        .map((l) => ({
          type: normalizeMongoLabSeverity(l.status) === 'high' ? 'HIGH' : 'MEDIUM',
          flag: `${l.test || l.test_name}: ${l.status} (${l.value ?? ''}${l.unit || ''})`,
          date: l.date || null,
        })),
    ];

    return {
      id: rawPatient.patient_id || rawPatient.id || normalizedId,
      name: rawPatient.name || normalizedId,
      age: rawPatient.age ?? null,
      gender: rawPatient.gender || 'Unknown',
      blood_group: rawPatient.blood_group || null,
      primaryDiagnosis: diagnosis.slice(0, 2),
      secondaryDiagnosis: diagnosis.slice(2),
      diagnoses: diagnosis,
      medications,
      labResults,
      clinicalFlags,
      visits,
      allergies: rawPatient.allergies || [],
      overdueTests: [],
      lastVisit: visits.length ? visits[visits.length - 1].date : null,
      status: rawPatient.status || 'stable',
    };
  } finally {
    await client.close();
  }
}

function buildBriefFromCase(patient, patientId) {
  const safeVisits = Array.isArray(patient?.visits) ? patient.visits : [];
  const safeFlags = Array.isArray(patient?.clinicalFlags) ? patient.clinicalFlags : [];
  const safeLabs = patient?.labResults || {};
  const safeMeds = Array.isArray(patient?.medications) ? patient.medications : [];
  const lastVisit = safeVisits.length ? safeVisits[safeVisits.length - 1] : null;
  const recentLabs = {};
  Object.entries(safeLabs).forEach(([test, values]) => {
    recentLabs[test] = (values || []).slice(-3);
  });
  return {
    patientId,
    patientName: patient?.name || patientId,
    age: patient?.age ?? null,
    primaryDiagnosis: patient?.primaryDiagnosis || [],
    chiefComplaintHistory: safeVisits.map((v) => ({
      date: v.date,
      complaint: v.chiefComplaint,
      doctor: v.doctor,
    })),
    currentMedications: safeMeds,
    last3LabResults: recentLabs,
    redFlags: safeFlags.filter((f) => ['CRITICAL', 'HIGH'].includes(String(f.type || '').toUpperCase())),
    lastVisitSummary: lastVisit,
    allergies: patient?.allergies || [],
    overdueTests: patient?.overdueTests || [],
    generatedAt: new Date().toISOString(),
  };
}

function nextUserId(role, list) {
  const prefix = role === 'doctor' ? 'D' : 'P';
  const maxNum = list.reduce((max, item) => {
    const id = String(item.id || '');
    const num = Number(id.replace(/^[A-Z]/, ''));
    return Number.isFinite(num) ? Math.max(max, num) : max;
  }, 0);
  return `${prefix}${String(maxNum + 1).padStart(3, '0')}`;
}

router.post('/auth/login', (req, res) => {
  const { email, password, role } = req.body;
  const list = role === 'doctor' ? users.doctors : users.patients;
  const user = list.find((u) => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const { password: _, ...safeUser } = user;
  return res.json({ user: safeUser, role });
});

router.post('/auth/register', (req, res) => {
  const { role, email, password, name } = req.body || {};
  if (!role || !email || !password || !name) {
    return res.status(400).json({ error: 'role, name, email and password are required' });
  }
  if (!['doctor', 'patient'].includes(role)) {
    return res.status(400).json({ error: 'role must be doctor or patient' });
  }

  const key = role === 'doctor' ? 'doctors' : 'patients';
  const list = users[key];
  const existing = list.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const id = nextUserId(role, list);
  const user = { id, name, email, password };
  list.push(user);
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');

  const { password: _, ...safeUser } = user;
  return res.status(201).json({ user: safeUser, role });
});

router.get('/patients', async (req, res) => {
  try {
    if (!process.env.MONGO_URI) {
      return res.status(500).json({ error: 'MONGO_URI is not configured' });
    }

    const mongoPatients = await getAllPatientsLiteFromMongo();
    const normalized = (Array.isArray(mongoPatients) ? mongoPatients : []).map((p) => ({
      _id: p._id || null,
      patient_id: p.patient_id,
      name: p.name,
      age: p.age ?? null,
      gender: p.gender ?? 'Unknown',
      email: p.email || `${String(p.name || 'patient').toLowerCase().replace(/\s+/g, '.')}@patient.local`,
      phone: p.phone || null,
      blood_group: p.blood_group || null,
      bmi: p.bmi ?? null,
      city: p.city || null,
      smoking: p.smoking || null,
      alcohol: p.alcohol || null,
      diagnosis: p.diagnosis || [],
      allergies: p.allergies || [],
      status: p.status || 'stable',
      lastVisit: p.lastVisit || null,
    }));
    return res.json(normalized);
  } catch (e) {
    return res.status(500).json({ error: `Failed to load patients: ${e.message}` });
  }
});

router.get('/dashboard/data', async (req, res) => {
  try {
    if (!process.env.MONGO_URI) {
      return res.status(500).json({ error: 'MONGO_URI is not configured' });
    }
    const data = await dashboardDataFromMongo();
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: `Failed to build dashboard data: ${e.message}` });
  }
});

router.get('/patient/:id', async (req, res) => {
  try {
    const mongoPatient = await getPatientCaseFromMongo(req.params.id).catch(() => null);
    const patient = mongoPatient || tools.get_patient_case_sheet(req.params.id);
    if (!patient || patient.error) return res.status(404).json(patient || { error: 'Patient not found' });
    blockchain.addBlock('VIEW_PATIENT_RECORD', req.headers['x-actor-id'] || 'UNKNOWN', req.params.id, 'Patient record accessed');
    return res.json(patient);
  } catch (e) {
    return res.status(500).json({ error: `Failed to load patient: ${e.message}` });
  }
});

router.get('/patient/:id/brief', async (req, res) => {
  try {
    const mongoPatient = await getPatientCaseFromMongo(req.params.id).catch(() => null);
    const brief = mongoPatient
      ? buildBriefFromCase(mongoPatient, req.params.id)
      : tools.generate_consultation_brief(req.params.id);
    if (!brief || brief.error) return res.status(404).json(brief || { error: 'Patient not found' });
    blockchain.addBlock('GENERATE_BRIEF', req.headers['x-actor-id'] || 'SYSTEM', req.params.id, '60-second consultation brief generated');
    return res.json(brief);
  } catch (e) {
    return res.status(500).json({ error: `Failed to generate brief: ${e.message}` });
  }
});

router.get('/patient/:id/labs/:testName', async (req, res) => {
  try {
    const mongoPatient = await getPatientCaseFromMongo(req.params.id).catch(() => null);
    if (mongoPatient && mongoPatient.labResults) {
      const testName = req.params.testName;
      const aliasMap = {
        SerumCreatinine: 'Creatinine',
        BloodPressure: 'Blood Pressure',
        Cholesterol: 'Total Cholesterol',
        Haemoglobin: 'Hemoglobin',
      };
      const normalizedTestName = mongoPatient.labResults[testName]
        ? testName
        : aliasMap[testName] || testName;
      const allRows = mongoPatient.labResults[normalizedTestName] || [];
      const from = req.query?.from ? new Date(req.query.from) : null;
      const to = req.query?.to ? new Date(req.query.to) : null;
      const data = allRows.filter((r) => {
        const d = new Date(r.date || 0);
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      });
      const values = data.map((r) => Number(r.value)).filter((v) => Number.isFinite(v));
      const trend =
        values.length > 1
          ? values[values.length - 1] > values[0]
            ? 'WORSENING'
            : values[values.length - 1] < values[0]
            ? 'IMPROVING'
            : 'STABLE'
          : 'INSUFFICIENT_DATA';
      const result = { test_name: normalizedTestName, data, trend, count: data.length };
      blockchain.addBlock('QUERY_LAB_TREND', req.headers['x-actor-id'] || 'UNKNOWN', req.params.id, `Lab trend queried: ${req.params.testName}`);
      return res.json(result);
    }

    const result = tools.extract_lab_trends(req.params.id, req.params.testName, req.query);
    blockchain.addBlock('QUERY_LAB_TREND', req.headers['x-actor-id'] || 'UNKNOWN', req.params.id, `Lab trend queried: ${req.params.testName}`);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: `Failed to load lab trend: ${e.message}` });
  }
});

router.get('/patient/:id/flags', async (req, res) => {
  try {
    const mongoPatient = await getPatientCaseFromMongo(req.params.id).catch(() => null);
    if (mongoPatient) {
      const typeFilter = String(req.query?.type || '').toUpperCase();
      const flags = (mongoPatient.clinicalFlags || []).filter((f) =>
        !typeFilter ? true : String(f.type || '').toUpperCase().includes(typeFilter)
      );
      return res.json(flags);
    }
    const flags = tools.flag_clinical_pattern(req.params.id, req.query.type);
    return res.json(flags);
  } catch (e) {
    return res.status(500).json({ error: `Failed to load flags: ${e.message}` });
  }
});

router.get('/patient/:id/overdue-tests', async (req, res) => {
  try {
    const mongoPatient = await getPatientCaseFromMongo(req.params.id).catch(() => null);
    const tests = mongoPatient ? mongoPatient.overdueTests || [] : tools.recommend_lab_tests(req.params.id);
    blockchain.addBlock('LAB_RECOMMENDATION', 'SYSTEM', req.params.id, 'Overdue lab tests surfaced');
    return res.json(tests);
  } catch (e) {
    return res.status(500).json({ error: `Failed to load overdue tests: ${e.message}` });
  }
});

router.get('/patient/:id/documents', async (req, res) => {
  try {
    if (!process.env.MONGO_URI || !MongoClient) {
      return res.status(500).json({ error: 'MongoDB is not configured' });
    }

    const patientId = String(req.params.id || '').trim().toUpperCase();
    if (!patientId) return res.status(400).json({ error: 'patientId required' });

    const limitRaw = Number(req.query?.limit ?? 6);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 20) : 6;

    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const dbName = String(process.env.MONGO_DB_NAME || '').trim();
      const db = dbName ? client.db(dbName) : client.db();

      const idRegex = new RegExp(`^${patientId}$`, 'i');
      const docs = await db
        .collection('documents')
        .find(
          { patient_id: { $regex: idRegex } },
          {
            projection: {
              patient_id: 1,
              uploaded_at: 1,
              type: 1,
              source: 1,
              extractor: 1,
              file: 1,
              raw_text: 1,
              structured: 1,
            },
          }
        )
        .sort({ uploaded_at: -1 })
        .limit(limit)
        .toArray();

      return res.json(
        (docs || []).map((d) => ({
          document_id: d._id,
          patient_id: d.patient_id,
          uploaded_at: d.uploaded_at || null,
          type: d.type || 'unknown',
          source: d.source || null,
          extractor: d.extractor || null,
          file: d.file || null,
          raw_text: d.raw_text || '',
          extraction_warnings: d.structured?.extraction_warnings || [],
        }))
      );
    } finally {
      await client.close();
    }
  } catch (e) {
    return res.status(500).json({ error: `Failed to load documents: ${e.message}` });
  }
});

// Frontend compatibility: /records/* aliases
router.get('/records/:id', (req, res) => {
  const patient = tools.get_patient_case_sheet(req.params.id);
  if (patient.error) return res.status(404).json(patient);

  return res.json({
    patient_id: patient.id,
    name: patient.name,
    age: patient.age,
    gender: patient.gender,
    diagnoses: [...(patient.primaryDiagnosis || []), ...(patient.secondaryDiagnosis || [])],
    allergies: patient.allergies || [],
    prescriptions: (patient.medications || []).map((m) => ({
      drug: m.name,
      dose: m.dose,
      frequency: m.frequency,
      start_date: m.since || null,
    })),
    visits: patient.visits || [],
  });
});

router.get('/records/:id/brief', (req, res) => {
  const brief = tools.generate_consultation_brief(req.params.id);
  if (brief.error) return res.status(404).json(brief);
  return res.json(brief);
});

router.get('/records/:id/labs', (req, res) => {
  const patient = tools.get_patient_case_sheet(req.params.id);
  if (patient.error) return res.status(404).json(patient);
  return res.json(flattenLabResults(patient));
});

router.get('/records/:id/flags', (req, res) => {
  const flags = tools.flag_clinical_pattern(req.params.id, req.query.type);
  if (flags.error) return res.status(404).json(flags);
  const payload = (Array.isArray(flags) ? flags : []).map((f, idx) => ({
    id: `${req.params.id}-F${idx + 1}`,
    severity: normalizeSeverity(f.type),
    message: f.flag,
    evidence: f.evidence,
    recommendation: f.recommendation,
  }));
  return res.json(payload);
});

router.get('/records/:id/overdue-tests', (req, res) => {
  const tests = tools.recommend_lab_tests(req.params.id);
  if (tests.error) return res.status(404).json(tests);
  return res.json(
    (tests || []).map((t) => ({
      test: t.test,
      priority: t.overdueDays > 20 ? 'high' : t.overdueDays > 7 ? 'medium' : 'low',
      reason: t.reason || 'Follow-up suggested',
      overdueDays: t.overdueDays ?? null,
      labUrl: t.labUrl || null,
    }))
  );
});

router.post('/records/search', (req, res) => {
  const { query, patientId } = req.body || {};
  if (!patientId) return res.status(400).json({ error: 'patientId required' });
  const result = tools.search_patient_history(patientId, query || '');
  if (result.error) return res.status(404).json(result);
  const normalized = (result.results || []).map((r) => ({
    type: r.department || 'Record',
    value: `${r.date}: ${r.snippet}`,
  }));
  return res.json(normalized);
});

router.post('/patient/:id/search', (req, res) => {
  const { query } = req.body;
  const result = tools.search_patient_history(req.params.id, query);
  blockchain.addBlock('HISTORY_SEARCH', req.headers['x-actor-id'] || 'UNKNOWN', req.params.id, `History searched: "${query}"`);
  return res.json(result);
});

router.post('/drugs/check', (req, res) => {
  const { medications } = req.body;
  if (!Array.isArray(medications) || medications.length === 0) {
    return res.status(400).json({ error: 'medications array required' });
  }
  const result = tools.check_drug_interactions(medications);
  blockchain.addBlock('CHECK_DRUG_INTERACTION', req.headers['x-actor-id'] || 'SYSTEM', req.body.patientId || 'UNKNOWN', `Drug interactions checked: ${medications.join(', ')}`);
  return res.json(result);
});

router.get('/pharmacy/:medicineName', (req, res) => {
  const links = tools.get_pharmacy_link(req.params.medicineName);
  blockchain.addBlock('PHARMACY_LINK_ACCESS', req.headers['x-actor-id'] || 'UNKNOWN', null, `Pharmacy links accessed: ${req.params.medicineName}`);
  return res.json(links);
});

router.post('/agent/query', async (req, res) => {
  const { patientId, query, prompt, apiKey, model, allPatients } = req.body;
  const normalizedQuery = query || prompt;
  if (!normalizedQuery) return res.status(400).json({ error: 'query/prompt required' });
  const effectivePatientId = allPatients ? 'all-patients' : patientId;

  blockchain.addBlock('NL_QUERY', req.headers['x-actor-id'] || 'UNKNOWN', effectivePatientId || 'UNKNOWN', `NL Query: "${normalizedQuery.substring(0, 80)}"`);

  const traces = [];
  try {
    const ragResult = await runRagDoctorQuery(effectivePatientId, normalizedQuery, apiKey, model);
    if (!ragResult.error && ragResult.answer) {
      return res.json({
        response: ragResult.answer,
        answer: ragResult.answer,
        source: ragResult.source,
        rag_hits: ragResult.rag_hits,
        traces,
      });
    }
    if (ragResult.error) {
      return res.json({
        response: ragResult.error,
        error: ragResult.error,
        source: 'rag',
        traces,
      });
    }
    if (!patientId) {
      return res.json({
        response: 'Patient not found. Please select a patient or mention full patient name in query.',
        source: 'rag',
        traces,
      });
    }
    const result = await runAnalysisAgent(normalizedQuery, patientId, apiKey, model, (trace) => traces.push(trace));
    return res.json({ ...result, traces, fallback: 'analysis-agent' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/agent/rag-summary', async (req, res) => {
  const { patientId, apiKey, model } = req.body || {};
  if (!patientId) return res.status(400).json({ error: 'patientId required' });

  const buildFallbackSummaryPoints = (patientCase, brief, reason = '') => {
    const diagnoses = [
      ...((patientCase?.primaryDiagnosis || [])),
      ...((patientCase?.secondaryDiagnosis || [])),
    ].filter(Boolean);
    const meds = (patientCase?.medications || []).slice(0, 6);
    const flags = (patientCase?.clinicalFlags || brief?.redFlags || []).slice(0, 4);
    const visits = patientCase?.visits || [];
    const lastVisit = visits.length ? visits[visits.length - 1] : brief?.lastVisitSummary || null;
    const overdue = (patientCase?.overdueTests || brief?.overdueTests || []).slice(0, 3);

    const points = [];
    points.push(
      `${patientCase?.age ?? brief?.age ?? 'Unknown-age'}-year-old ${String(patientCase?.gender || 'patient').toLowerCase()} with ${diagnoses.join(', ') || 'ongoing chronic conditions'}.`
    );
    points.push(
      `Current medications: ${meds.length ? meds.map((m) => `${m.name || m.drug} ${m.dose || ''}`.trim()).join(', ') : 'No active medication list available'}.`
    );
    points.push(
      `Active alerts/issues: ${flags.length ? flags.map((f) => f.flag || f.message || 'clinical flag').join('; ') : 'No major critical flags recorded'}.`
    );
    points.push(
      `Last visit: ${lastVisit?.date || 'date unavailable'}${lastVisit?.clinicalNote ? ` - ${lastVisit.clinicalNote}` : ''}`
    );
    points.push(
      `Symptoms tracked: ${lastVisit?.symptoms?.length ? lastVisit.symptoms.join(', ') : (lastVisit?.chiefComplaint || 'not clearly documented')}.`
    );
    points.push(
      `Recommended next steps: ${overdue.length ? overdue.map((t) => `${t.test || t.name || 'follow-up test'}${t.reason ? ` (${t.reason})` : ''}`).join(', ') : 'continue treatment and monitor trends closely'}.`
    );
    if (reason) {
      points.push(`RAG fallback note: ${reason}.`);
    }
    return points;
  };

  const loadFallbackData = async () => {
    const mongoCase = await getPatientCaseFromMongo(patientId).catch(() => null);
    if (mongoCase) {
      return {
        patientCase: mongoCase,
        brief: buildBriefFromCase(mongoCase, patientId),
      };
    }
    const toolCase = tools.get_patient_case_sheet(patientId);
    if (toolCase && !toolCase.error) {
      return {
        patientCase: toolCase,
        brief: tools.generate_consultation_brief(patientId),
      };
    }
    return { patientCase: null, brief: null };
  };

  try {
    const result = await runRagPatientSummary(patientId, apiKey, model);
    if (result.error) {
      const { patientCase, brief } = await loadFallbackData();
      if (!patientCase && !brief) return res.status(404).json(result);
      return res.json({
        patientId,
        source: 'fallback',
        fallback: true,
        summary_points: buildFallbackSummaryPoints(patientCase, brief, result.error),
        raw: '',
        rag_hits: [],
      });
    }
    if (!Array.isArray(result.summary_points) || result.summary_points.length === 0) {
      const { patientCase, brief } = await loadFallbackData();
      return res.json({
        ...result,
        source: 'fallback',
        fallback: true,
        summary_points: buildFallbackSummaryPoints(patientCase, brief, 'RAG returned empty summary'),
      });
    }
    return res.json(result);
  } catch (e) {
    const { patientCase, brief } = await loadFallbackData();
    if (!patientCase && !brief) return res.status(500).json({ error: e.message });
    return res.json({
      patientId,
      source: 'fallback',
      fallback: true,
      summary_points: buildFallbackSummaryPoints(patientCase, brief, e.message),
      raw: '',
      rag_hits: [],
    });
  }
});

router.post('/agent/rag-query', async (req, res) => {
  const { patientId, query, apiKey, model } = req.body || {};
  if (!patientId || !query) return res.status(400).json({ error: 'patientId and query required' });
  try {
    const result = await runRagDoctorQuery(patientId, query, apiKey, model);
    if (result.error) return res.status(404).json(result);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/agent/second-opinion', async (req, res) => {
  const { patientId, proposedDiagnosis, apiKey, model } = req.body;
  if (!patientId || !proposedDiagnosis) return res.status(400).json({ error: 'patientId and proposedDiagnosis required' });

  blockchain.addBlock('SECOND_OPINION_REQUEST', req.headers['x-actor-id'] || 'UNKNOWN', patientId, `Second opinion: "${proposedDiagnosis}"`);

  try {
    const result = await runSecondOpinionAgent(patientId, proposedDiagnosis, apiKey, model);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/agent/triage', async (req, res) => {
  const { patientId, apiKey } = req.body;
  if (!patientId) return res.status(400).json({ error: 'patientId required' });

  blockchain.addBlock('TRIAGE_INITIATED', 'SYSTEM', patientId, 'Triage agent invoked');

  try {
    const result = await runTriageAgent(patientId, apiKey);
    if (result.needs_consultation) {
      blockchain.addBlock('TICKET_RAISED', 'SYSTEM', patientId, `Consultation ticket raised - ${result.priority} priority`);
    }
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/agent/receptionist', async (req, res) => {
  const { message, history, apiKey } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  try {
    const response = await runReceptionist(message, history || [], apiKey);
    return res.json({ response });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/agent/nutrition', async (req, res) => {
  const { foodDescription, patientId, apiKey } = req.body;

  let conditions = [];
  if (patientId) {
    const patient = tools.get_patient_case_sheet(patientId);
    if (!patient.error) conditions = [...(patient.primaryDiagnosis || []), ...(patient.secondaryDiagnosis || [])];
  }
  const description =
    foodDescription ||
    (conditions.length
      ? `Give nutrition advice for conditions: ${conditions.join(', ')}`
      : 'Give a balanced diet recommendation for a general adult patient.');

  try {
    const result = await runNutritionAgent(description, conditions, apiKey);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/agent/ocr', uploadAny.any(), async (req, res) => {
  const uploaded = (req.files || []).find((f) => f.fieldname === 'document' || f.fieldname === 'file');
  if (!uploaded) return res.status(400).json({ error: 'No file uploaded' });

  blockchain.addBlock('DOCUMENT_UPLOAD', req.headers['x-actor-id'] || 'PATIENT', req.body.patientId || 'UNKNOWN', `Document uploaded: ${uploaded.originalname}`);

  try {
    const { processUploadedDocument } = require('../agents/ocrAgent');
    const result = await processUploadedDocument(uploaded.path, req.body.apiKey, req.body.model);
    blockchain.addBlock('OCR_PROCESSING', 'SYSTEM', req.body.patientId || 'UNKNOWN', `OCR processing complete - ${result.success ? 'success' : 'failed'}`);

    if (result.success && req.body.patientId && req.body.autoIngest === 'true') {
      const structuredWithMeta = {
        ...(result.structured || {}),
        _upload: {
          original_filename: uploaded.originalname,
          mimetype: uploaded.mimetype,
          size: uploaded.size,
        },
      };
      const ingestion = await runIngestionAgent(req.body.patientId, structuredWithMeta);
      result.ingestion = ingestion;
      blockchain.addBlock('INGESTION_PROCESSING', 'SYSTEM', req.body.patientId, `Ingestion complete - ${ingestion.success ? 'success' : 'failed'}`);
    }

    fs.unlink(uploaded.path, () => {});
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/agent/ingest', async (req, res) => {
  const { patientId, structuredOCRData } = req.body;
  if (!patientId || !structuredOCRData) {
    return res.status(400).json({ error: 'patientId and structuredOCRData required' });
  }

  try {
    const result = await runIngestionAgent(patientId, structuredOCRData);
    blockchain.addBlock('INGESTION_PROCESSING', req.headers['x-actor-id'] || 'SYSTEM', patientId, `Manual ingestion - ${result.success ? 'success' : 'failed'}`);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/agent/intake', upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { patientId, query, fromDoctor, toSpecialty, reason, apiKey, model } = req.body;
  if (!patientId) return res.status(400).json({ error: 'patientId required' });

  try {
    const { runOrchestratorAgent } = require('../agents/orchestratorAgent');
    const result = await runOrchestratorAgent({
      patientId,
      filePath: req.file.path,
      query,
      fromDoctor,
      toSpecialty,
      reason,
      apiKey,
      model,
    });

    blockchain.addBlock('ORCHESTRATOR_RUN', req.headers['x-actor-id'] || 'SYSTEM', patientId, `Intake pipeline run - ${result.success ? 'success' : 'failed'}`);
    fs.unlink(req.file.path, () => {});
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/agent/transfer', async (req, res) => {
  const { patientId, fromDoctor, toSpecialty, reason, includeAnalysis, analysisQuery, apiKey, model } = req.body;
  if (!patientId || !fromDoctor || !toSpecialty) {
    return res.status(400).json({ error: 'patientId, fromDoctor, toSpecialty required' });
  }

  try {
    const result = await runTransferAgent({
      patientId,
      fromDoctor,
      toSpecialty,
      reason,
      includeAnalysis: includeAnalysis !== false,
      analysisQuery,
      apiKey,
      model,
    });

    blockchain.addBlock('TRANSFER_PACKET_GENERATED', fromDoctor, patientId, `Transfer packet generated for ${toSpecialty}`);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/referral', async (req, res) => {
  const { patientId, fromDoctor, toSpecialty, reason, apiKey, model } = req.body;
  if (!patientId || !fromDoctor || !toSpecialty) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const transfer = await runTransferAgent({
      patientId,
      fromDoctor,
      toSpecialty,
      reason,
      includeAnalysis: true,
      apiKey,
      model,
    });

    blockchain.addBlock('SPECIALIST_REFERRAL', fromDoctor, patientId, `Referred to ${toSpecialty} - ${reason || 'No reason provided'}`);
    return res.json(transfer);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/blockchain/chain', (req, res) => res.json(blockchain.getChain()));
router.get('/blockchain/verify', (req, res) => res.json(blockchain.verifyChain()));
router.get('/blockchain/export', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=audit_trail.csv');
  res.send(blockchain.exportCSV());
});

router.post('/emergency', (req, res) => {
  const { patientId, actorId } = req.body;
  blockchain.addBlock('EMERGENCY_ESCALATION', actorId || 'PATIENT', patientId || 'UNKNOWN', 'EMERGENCY button pressed - immediate escalation');
  return res.json({ status: 'EMERGENCY_LOGGED', hospital_phone: '+91 7695 9595 76', ambulance: '108' });
});

module.exports = router;
