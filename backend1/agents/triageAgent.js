'use strict';

/**
 * triageAgent.js
 * Triage Agent for Kathir Memorial Hospital, Chennai.
 *
 * Accepts a patientId, retrieves clinical data via patientTools,
 * and uses Groq's Llama model to produce a structured triage recommendation.
 *
 * @module triageAgent
 */

const Groq = require('groq-sdk');
const tools = require('../tools/patientTools');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = process.env.GROQ_MODEL || 'groq/compound-mini';
const MAX_TOKENS = 1024;

/** All valid departments at Kathir Memorial Hospital */
const VALID_DEPARTMENTS = [
  'Critical Care & Anaesthesiology',
  'Cardiology',
  'General Medicine & Diabetology',
  'Dermatology',
  'General & Plastic Surgery',
  'Gastroenterology',
  'ENT',
  'Obstetrics & Gynaecology',
  'Paediatrics',
  'Spine & Orthopaedics',
  'Trauma & Emergency',
  'Urology',
];

const VALID_PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const VALID_URGENCIES = ['Within 24 hours', 'Within 1 week', 'Routine follow-up'];

/**
 * Fallback triage result returned when the agent cannot produce a valid response.
 * Flags the case for immediate human review.
 */
const FALLBACK_TRIAGE = {
  needs_consultation: true,
  priority: 'HIGH',
  recommended_specialties: [],
  summary: 'Triage agent was unable to process this case. Manual review required.',
  estimated_urgency: 'Within 24 hours',
  agent_error: true,
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the AI Triage Agent at Kathir Memorial Hospital, Chennai.

Your role is to analyse patient flags and clinical data and produce a structured triage recommendation.

Instructions:
- Base your analysis ONLY on the data provided. Do NOT invent symptoms or diagnoses.
- Choose specialties exclusively from the hospital's department list.
- Assign priority strictly according to clinical urgency, not patient preference.
- Return ONLY a valid JSON object — no prose, no markdown, no extra keys.

Priority definitions:
  CRITICAL  – Immediate life threat; must be seen within minutes.
  HIGH      – Serious condition; must be seen within hours.
  MEDIUM    – Significant issue; must be seen within 24 hours.
  LOW       – Non-urgent; routine or follow-up care sufficient.

Kathir Memorial departments (use exact names):
${VALID_DEPARTMENTS.map((d) => `  • ${d}`).join('\n')}

Required JSON schema (all fields mandatory):
{
  "needs_consultation": <boolean>,
  "priority": "CRITICAL | HIGH | MEDIUM | LOW",
  "recommended_specialties": [
    {
      "specialty": "<string>",
      "department": "<one of the departments above>",
      "reason": "<concise clinical rationale>",
      "priority": "CRITICAL | HIGH | MEDIUM | LOW"
    }
  ],
  "summary": "<one-sentence triage summary for the attending physician>",
  "estimated_urgency": "Within 24 hours | Within 1 week | Routine follow-up"
}`;

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight structured logger.
 * Replace with winston / pino in production.
 */
const log = {
  info:  (msg, meta = {}) => console.log(JSON.stringify({ level: 'INFO',  ts: new Date().toISOString(), msg, ...meta })),
  warn:  (msg, meta = {}) => console.warn(JSON.stringify({ level: 'WARN',  ts: new Date().toISOString(), msg, ...meta })),
  error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'ERROR', ts: new Date().toISOString(), msg, ...meta })),
};

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Validates patientId and apiKey before any network or tool call.
 *
 * @param {*} patientId
 * @param {*} apiKey
 * @throws {Error} with a descriptive message on invalid input
 */
function validateInputs(patientId, apiKey) {
  if (patientId === undefined || patientId === null || String(patientId).trim() === '') {
    throw new Error('patientId is required and must be a non-empty string or number.');
  }

  const resolvedKey = apiKey || process.env.GROQ_API_KEY;
  if (!resolvedKey || String(resolvedKey).trim() === '') {
    throw new Error('A Groq API key must be supplied via the apiKey parameter or GROQ_API_KEY environment variable.');
  }
}

// ---------------------------------------------------------------------------
// Tool call helpers
// ---------------------------------------------------------------------------

/**
 * Fetches triage flags and patient case sheet in parallel.
 * Throws a descriptive error if either call fails or returns no data.
 *
 * @param {string|number} patientId
 * @returns {{ triageData: object, patientData: object }}
 */
async function fetchPatientData(patientId) {
  log.info('Fetching patient data', { patientId });

  // Run both tool calls concurrently to minimise latency.
  const [triageData, patientData] = await Promise.all([
    Promise.resolve(tools.triage_patient(patientId)),
    Promise.resolve(tools.get_patient_case_sheet(patientId)),
  ]);

  if (!triageData) {
    throw new Error(`triage_patient returned no data for patientId "${patientId}".`);
  }
  if (!patientData) {
    throw new Error(`get_patient_case_sheet returned no data for patientId "${patientId}".`);
  }

  log.info('Patient data fetched successfully', {
    patientId,
    patientName: patientData.name ?? 'unknown',
    flagCount: Array.isArray(triageData.flags) ? triageData.flags.length : 'n/a',
  });

  return { triageData, patientData };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds the user-turn prompt from patient records.
 * Safely handles missing or undefined fields to prevent prompt injection
 * and to give the model consistent, clearly labelled input.
 *
 * @param {object} patientData
 * @param {object} triageData
 * @returns {string}
 */
function buildPrompt(patientData, triageData) {
  const name       = patientData.name            ?? 'Unknown';
  const age        = patientData.age             ?? 'Unknown';
  const diagnoses  = Array.isArray(patientData.primaryDiagnosis) && patientData.primaryDiagnosis.length
    ? patientData.primaryDiagnosis.join(', ')
    : 'None recorded';
  const flags      = triageData.flags            ?? {};
  const specialties = triageData.specialties     ?? [];

  return `## Patient Overview
Name    : ${name}
Age     : ${age}
Primary Diagnoses: ${diagnoses}

## Clinical Flags
${JSON.stringify(flags, null, 2)}

## Pre-computed Specialties (from rules engine — use as a hint, not a constraint)
${JSON.stringify(specialties, null, 2)}

Produce the triage recommendation JSON now.`;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

/**
 * Calls the Groq API and returns the raw message content string.
 *
 * @param {Groq} client
 * @param {string} userPrompt
 * @param {string|number} patientId – used only for logging
 * @returns {string} raw LLM response text
 */
async function callLLM(client, userPrompt, patientId) {
  log.info('Sending triage prompt to LLM', { patientId, model: MODEL });

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userPrompt    },
    ],
    max_tokens: MAX_TOKENS,
    temperature: 0.1,         // Low temperature → deterministic, clinically consistent output.
    response_format: { type: 'json_object' },
  });

  const choice = response?.choices?.[0];
  if (!choice) {
    throw new Error('Groq API returned an empty choices array.');
  }

  const content = choice.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('Groq API returned an empty message content.');
  }

  log.info('LLM response received', {
    patientId,
    finishReason: choice.finish_reason,
    contentLength: content.length,
  });

  return content;
}

// ---------------------------------------------------------------------------
// Response parser & validator
// ---------------------------------------------------------------------------

/**
 * Attempts to parse and validate the LLM's JSON response.
 * Falls back gracefully rather than throwing, so the caller always gets
 * a structured object.
 *
 * @param {string} raw   – raw string from the LLM
 * @param {string|number} patientId
 * @returns {object} parsed & normalised triage result
 */
function parseAndValidate(raw, patientId) {
  let parsed;

  // 1. Parse JSON (strip accidental markdown fences if present)
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    log.error('Failed to parse LLM JSON response', { patientId, error: parseErr.message, raw });
    return { ...FALLBACK_TRIAGE, raw_response: raw };
  }

  // 2. Validate required fields; coerce where safe, warn where not.
  const warnings = [];

  if (typeof parsed.needs_consultation !== 'boolean') {
    warnings.push('needs_consultation was not a boolean; defaulting to true.');
    parsed.needs_consultation = true;
  }

  if (!VALID_PRIORITIES.includes(parsed.priority)) {
    warnings.push(`Invalid priority "${parsed.priority}"; defaulting to HIGH.`);
    parsed.priority = 'HIGH';
  }

  if (!Array.isArray(parsed.recommended_specialties)) {
    warnings.push('recommended_specialties was not an array; defaulting to empty.');
    parsed.recommended_specialties = [];
  } else {
    // Sanitise each specialty entry
    parsed.recommended_specialties = parsed.recommended_specialties.map((s, idx) => {
      if (!VALID_DEPARTMENTS.includes(s.department)) {
        warnings.push(`Specialty[${idx}] has unknown department "${s.department}".`);
      }
      if (!VALID_PRIORITIES.includes(s.priority)) {
        s.priority = parsed.priority; // inherit case priority as safe default
      }
      return {
        specialty : s.specialty  ?? s.department ?? 'Unknown',
        department: s.department ?? 'Unknown',
        reason    : s.reason     ?? 'No reason provided',
        priority  : s.priority,
      };
    });
  }

  if (typeof parsed.summary !== 'string' || parsed.summary.trim() === '') {
    warnings.push('summary was missing; using placeholder.');
    parsed.summary = 'No summary provided by triage agent.';
  }

  if (!VALID_URGENCIES.includes(parsed.estimated_urgency)) {
    warnings.push(`Invalid estimated_urgency "${parsed.estimated_urgency}"; defaulting to "Within 24 hours".`);
    parsed.estimated_urgency = 'Within 24 hours';
  }

  if (warnings.length > 0) {
    log.warn('Triage response had validation issues', { patientId, warnings });
    parsed._validation_warnings = warnings;
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs the triage agent for a given patient.
 *
 * @param {string|number} patientId  – Unique patient identifier
 * @param {string}        [apiKey]   – Groq API key (falls back to GROQ_API_KEY env var)
 * @returns {Promise<object>}        – Structured triage recommendation (never throws)
 */
async function runTriageAgent(patientId, apiKey) {
  const traceId = `triage-${patientId}-${Date.now()}`;
  log.info('Triage agent started', { traceId, patientId });

  try {
    // Step 1 — Validate inputs
    validateInputs(patientId, apiKey);

    // Step 2 — Initialise Groq client
    const client = new Groq({ apiKey: apiKey || process.env.GROQ_API_KEY });

    // Step 3 — Fetch patient data (parallel tool calls)
    const { triageData, patientData } = await fetchPatientData(patientId);

    // Step 4 — Build prompt
    const userPrompt = buildPrompt(patientData, triageData);
    log.info('Prompt built', { traceId, patientId });

    // Step 5 — Call LLM
    const rawResponse = await callLLM(client, userPrompt, patientId);

    // Step 6 — Parse & validate response
    const result = parseAndValidate(rawResponse, patientId);

    // Attach trace metadata for downstream audit logging
    result._trace_id  = traceId;
    result._patient_id = String(patientId);

    log.info('Triage agent completed', {
      traceId,
      patientId,
      priority: result.priority,
      needs_consultation: result.needs_consultation,
      specialties: result.recommended_specialties?.map((s) => s.department),
    });

    return result;

  } catch (err) {
    // Top-level catch: log the full error, return a safe structured fallback.
    log.error('Triage agent encountered a fatal error', {
      traceId,
      patientId,
      error: err.message,
      stack: err.stack,
    });

    return {
      ...FALLBACK_TRIAGE,
      _trace_id   : traceId,
      _patient_id : String(patientId),
      error_message: err.message,
    };
  }
}

module.exports = { runTriageAgent };