const OpenAI = require('openai');
const { getContext } = require('./memory');

// Together.ai API (OpenAI-compatible)
const openai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1'
});

// Model options (pick one):
// - meta-llama/Llama-3.3-70B-Instruct-Turbo (fast, cheap)
// - meta-llama/Llama-3.1-405B-Instruct-Turbo (more powerful)
// - mistralai/Mixtral-8x7B-Instruct-v0.1
const MODEL = process.env.MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

async function extractTask(message, channelId) {
  const context = getContext(channelId);
  
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `You analyze Discord messages and extract actionable tasks.

Recent conversation context in this channel:
${context.join('\n')}

Your job:
1. Determine if the message contains an actionable task, bug report, or action item
2. If yes, extract structured data
3. If no, return isActionable: false

Rules:
- Only mark as actionable if there's a clear task, bug, or action item
- Extract assignee if someone is mentioned (e.g., "@sarah", "sarah can you...")
- Infer priority from urgency words:
  - "urgent", "asap", "critical", "blocking" = high
  - "soon", "this week", "by friday" = medium  
  - Everything else = low
- Create a concise, clear task title
- Include original message context in description

Return JSON only, no markdown:
{
  "isActionable": boolean,
  "title": "string (concise task title)",
  "assignee": "string or null (username without @)",
  "priority": "low" | "medium" | "high",
  "description": "string (original message context)"
}`
      },
      { role: 'user', content: message }
    ],
    response_format: { type: 'json_object' }
  });
  
  const result = JSON.parse(response.choices[0].message.content);
  console.log('AI extracted:', result);
  return result;
}

module.exports = { extractTask };