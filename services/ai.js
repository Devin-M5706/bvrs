const OpenAI = require('openai');
const { getContext, getKnownContext, updateKnownContext } = require('./memory');
const fs = require('fs');
const path = require('path');

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

async function checkContextNeeds(message, channelId) {
  const context = getContext(channelId);
  const knownCtx = getKnownContext(channelId);
  
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a helpful project assistant. Analyze the conversation and determine what context you need to better understand tasks and assignments.

Known context so far:
- Project Name: ${knownCtx.projectName || 'Unknown'}
- Team Members: ${knownCtx.teamMembers.length > 0 ? knownCtx.teamMembers.join(', ') : 'Unknown'}
- Sprint/Goal: ${knownCtx.sprintGoal || 'Unknown'}

Recent conversation:
${context.join('\n')}

Your job:
1. Check if this message provides project context (name, team, goals)
2. If context is missing AND we need it to process tasks, generate a friendly question
3. Extract any context updates from the message

Context needed when:
- No project name known and task references "the project"
- No team members known and someone is assigned a task
- Task references sprint/feature we don't know about

Return JSON only:
{
  "needsMoreContext": boolean,
  "question": "string or null (friendly question to ask the team)",
  "contextUpdates": {
    "projectName": "string or null",
    "teamMembers": ["array of usernames or null"],
    "sprintGoal": "string or null"
  }
}`
      },
      { role: 'user', content: message }
    ],
    response_format: { type: 'json_object' }
  });
  
  const result = JSON.parse(response.choices[0].message.content);
  
  // Apply context updates if any
  if (result.contextUpdates) {
    const updates = {};
    if (result.contextUpdates.projectName) updates.projectName = result.contextUpdates.projectName;
    if (result.contextUpdates.teamMembers && result.contextUpdates.teamMembers.length > 0) {
      updates.teamMembers = result.contextUpdates.teamMembers;
    }
    if (result.contextUpdates.sprintGoal) updates.sprintGoal = result.contextUpdates.sprintGoal;
    
    if (Object.keys(updates).length > 0) {
      updateKnownContext(channelId, updates);
    }
  }
  
  console.log('AI context check:', result);
  return result;
}

async function extractTask(message, channelId) {
  const context = getContext(channelId);
  const knownCtx = getKnownContext(channelId);
  
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `You analyze Discord messages and extract actionable tasks.

Project context:
- Name: ${knownCtx.projectName || 'Unknown project'}
- Team: ${knownCtx.teamMembers.length > 0 ? knownCtx.teamMembers.join(', ') : 'Unknown team'}
- Current focus: ${knownCtx.sprintGoal || 'Unknown'}

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

async function extractUserMappings(message, channelId) {
  const context = getContext(channelId);
  
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `You analyze Discord messages to extract team member introductions and Discord→GitHub username mappings.

Recent conversation context:
${context.join('\n')}

Your job:
1. Detect if the message introduces team members or project assignments
2. Extract Discord usernames and their corresponding GitHub usernames
3. Look for patterns like:
   - "@discord_user (github_user)"
   - "discord_user is github_user"
   - "discord_user -> github_user"
   - "discord_user: github_user"
   - Team rosters or member lists

Rules:
- Discord usernames may have @ prefix or not
- GitHub usernames should NOT include @
- Only return mappings that are clearly stated
- Return empty object if no mappings found

Return JSON only:
{
  "hasMappings": boolean,
  "mappings": {
    "discord_username": "github_username"
  }
}`
      },
      { role: 'user', content: message }
    ],
    response_format: { type: 'json_object' }
  });
  
  const result = JSON.parse(response.choices[0].message.content);
  console.log('AI extracted user mappings:', result);
  return result;
}

async function updateUserMappings(newMappings) {
  if (!newMappings || Object.keys(newMappings).length === 0) return false;
  
  const configPath = path.join(__dirname, '../config/users.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  let updated = false;
  for (const [discord, github] of Object.entries(newMappings)) {
    const normalizedDiscord = discord.toLowerCase().replace(/[@]/g, '');
    if (!config.discordToGithub[normalizedDiscord] || 
        config.discordToGithub[normalizedDiscord] !== github) {
      config.discordToGithub[normalizedDiscord] = github;
      console.log(`✅ Mapped @${normalizedDiscord} → ${github}`);
      updated = true;
    }
  }
  
  if (updated) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('✅ Updated users.json with new mappings');
  }
  
  return updated;
}

module.exports = { 
  checkContextNeeds,
  extractTask, 
  extractUserMappings, 
  updateUserMappings 
};
