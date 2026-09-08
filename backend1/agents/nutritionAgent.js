const Groq = require('groq-sdk');

const SYSTEM_PROMPT = `You are a Nutrition Analysis AI integrated into a hospital patient portal.

Given a food description, return a JSON response with nutritional analysis personalized to the patient's conditions.

Return EXACTLY this JSON format:
{
  "foods_identified": ["string"],
  "nutrition": {
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "fat_g": number,
    "fiber_g": number,
    "sodium_mg": number
  },
  "health_score": 1-10,
  "health_score_label": "Poor | Fair | Good | Excellent",
  "patient_specific_advice": ["string — personalised to their conditions"],
  "general_advice": ["string"],
  "disclaimer": "Nutritional values are estimates for general guidance. Consult your dietitian for a personalised meal plan."
}

Be specific to Indian foods. Values are approximate estimates — accuracy is secondary to helpfulness.`;

async function runNutritionAgent(foodDescription, patientConditions, apiKey) {
  const client = new Groq({ apiKey: apiKey || process.env.GROQ_API_KEY });

  const prompt = `Food Description: "${foodDescription}"
Patient Conditions: ${patientConditions?.join(', ') || 'Not specified'}

Analyse the nutritional content and provide personalised advice for this patient's conditions.`;

  const response = await client.chat.completions.create({
    model: process.env.GROQ_MODEL || 'groq/compound-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    max_tokens: 1024,
    response_format: { type: 'json_object' }
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    return { error: 'Could not parse nutrition response', raw: response.choices[0].message.content };
  }
}

module.exports = { runNutritionAgent };
