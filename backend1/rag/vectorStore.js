const { LocalIndex } = require('vectra');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const INDEX_PATH = isServerless
  ? path.join(os.tmpdir(), 'vectra_index')
  : path.join(__dirname, '../data/vectra_index');
let index = null;
const indexedPatientIds = new Set();

async function getEmbedding(text) {
  // Simple keyword-based similarity for hackathon (no embedding API needed)
  // Returns a fake vector based on word frequency
  const words = text.toLowerCase().split(/\s+/);
  const vector = new Array(128).fill(0);
  words.forEach(word => {
    let hash = 0;
    for (let c of word) hash = (hash * 31 + c.charCodeAt(0)) % 128;
    vector[hash] += 1;
  });
  const mag = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map(v => v / mag);
}

async function initIndex() {
  if (index) return index;
  try {
    if (!fs.existsSync(INDEX_PATH)) {
      fs.mkdirSync(INDEX_PATH, { recursive: true });
    }
    index = new LocalIndex(INDEX_PATH);
    if (!await index.isIndexCreated()) {
      await index.createIndex();
    }
  } catch (e) {
    console.warn('Vector index init warning:', e.message);
    index = null;
  }
  return index;
}

async function indexPatient(patient) {
  if (!index) await initIndex();
  // Index each visit note
  for (const visit of patient.visits) {
    const text = `Patient ${patient.name} visit on ${visit.date} by ${visit.doctor}. 
      Chief complaint: ${visit.chiefComplaint}. 
      Note: ${visit.clinicalNote}. 
      Plan: ${visit.plan}`;
    const vector = await getEmbedding(text);
    await index.insertItem({
      vector,
      metadata: {
        patientId: patient.id,
        date: visit.date,
        doctor: visit.doctor,
        department: visit.department,
        text
      }
    });
  }
  // Index allergies
  if (patient.allergies.length > 0) {
    const allergyText = `Patient ${patient.name} allergies: ${patient.allergies.join(', ')}`;
    const vector = await getEmbedding(allergyText);
    await index.insertItem({
      vector,
      metadata: { patientId: patient.id, date: 'ALLERGY_RECORD', doctor: 'System', text: allergyText }
    });
  }
}

function buildDocsFromBundle(bundle) {
  const docs = [];
  const patient = bundle?.patient;
  if (!patient) return docs;

  docs.push({
    section: 'patient_profile',
    date: patient.lastVisit || 'PROFILE',
    text: `Patient ${patient.name} (${patient.patient_id}) age ${patient.age}, gender ${patient.gender}. Diagnoses: ${(patient.diagnosis || []).join(', ')}. Allergies: ${(patient.allergies || []).join(', ') || 'none'}.`,
  });

  for (const visit of bundle.visits || []) {
    docs.push({
      section: 'visit',
      date: visit.date || 'VISIT',
      text: `Visit ${visit.date}: ${visit.department || ''} ${visit.visit_type || ''}. Doctor: ${visit.doctor || ''}. Notes: ${visit.doctor_notes || ''}. Symptoms: ${(visit.symptoms || []).join(', ')}.`,
    });
  }

  for (const med of bundle.medications || []) {
    docs.push({
      section: 'medication',
      date: med.start_date || 'MED',
      text: `Medication ${med.drug} ${med.dose}, ${med.frequency}, route ${med.route || 'NA'}, active: ${String(med.active ?? true)}.`,
    });
  }

  for (const lab of bundle.labs || []) {
    docs.push({
      section: 'lab',
      date: lab.date || 'LAB',
      text: `Lab ${lab.test} value ${lab.value}${lab.unit || ''} status ${lab.status || ''} range ${lab.normal_range || ''} on ${lab.date}.`,
    });
  }

  for (const alert of bundle.alerts || []) {
    docs.push({
      section: 'alert',
      date: alert.date || alert.timestamp || 'ALERT',
      text: `Alert ${alert.severity || ''}: ${alert.message}`,
    });
  }

  return docs;
}

async function indexPatientBundle(bundle) {
  try {
    if (!bundle?.patient?.patient_id) return { indexed: 0 };
    await initIndex();
    if (!index) return { indexed: 0 };

    const patientId = bundle.patient.patient_id;
    if (indexedPatientIds.has(patientId)) return { indexed: 0 };

    const docs = buildDocsFromBundle(bundle);
    for (const doc of docs) {
      const vector = await getEmbedding(doc.text);
      await index.insertItem({
        vector,
        metadata: {
          patientId,
          date: doc.date,
          section: doc.section,
          text: doc.text,
        },
      });
    }
    indexedPatientIds.add(patientId);
    return { indexed: docs.length };
  } catch (e) {
    console.warn('Index patient bundle warning:', e.message);
    return { indexed: 0 };
  }
}

async function semanticSearch(query, patientId, topK = 3) {
  try {
    await initIndex();
    if (!index) return [];
    const queryVector = await getEmbedding(query);
    const results = await index.queryItems(queryVector, topK * 3);
    // Filter by patient and return top results
    return results
      .filter(r => r.item.metadata.patientId === patientId)
      .slice(0, topK)
      .map(r => ({ score: r.score, ...r.item.metadata }));
  } catch (e) {
    console.warn('Semantic search warning:', e.message);
    return [];
  }
}

module.exports = { initIndex, indexPatient, indexPatientBundle, semanticSearch };
