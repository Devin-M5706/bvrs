const OpenAI = require('openai');
const { getContext, getKnownContext, updateKnownContext, isOnboarded, setOnboarded, hasMinimumContext } = require('./memory');
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

// Track what question we asked last (for contextual follow-up)
const lastQuestion = new Map(); // channelId -> { type, askedAt }

function loadConfig() {
  const configPath = path.join(__dirname, '../config/users.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function saveConfig(config) {
  const configPath = path.join(__dirname, '../config/users.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('✅ Updated users.json');
}

async function runOnboarding(message, channelId) {
  const knownCtx = getKnownContext(channelId);
  const config = loadConfig();
  
  // Determine what we need to ask
  const missing = [];
  if (!knownCtx.projectName) missing.push('projectName');
  if (knownCtx.teamMembers.length === 0) missing.push('teamMembers');
  if (config.projectConfig.projectNumber === null) missing.push('projectNumber');
  
  // If nothing missing, we're done
  if (missing.length === 0) {
    if (!isOnboarded(channelId)) {
      setOnboarded(channelId, true);
      return { 
        complete: true, 
        reply: generateReadyMessage(knownCtx, config)
      };
    }
    return { complete: true, reply: null };
  }
  
  // Get current question type
  const currentQuestion = lastQuestion.get(channelId);
  
  // If we asked a question, try to extract the answer
  if (currentQuestion) {
    const extraction = await extractOnboardingAnswer(message, channelId, currentQuestion.type);
    if (extraction.extracted) {
      // Reload context after extraction
      const updatedCtx = getKnownContext(channelId);
      const updatedConfig = loadConfig();
      
      // Check what's still missing
      const stillMissing = [];
      if (!updatedCtx.projectName) stillMissing.push('projectName');
      if (updatedCtx.teamMembers.length === 0) stillMissing.push('teamMembers');
      if (updatedConfig.projectConfig.projectNumber === null) stillMissing.push('projectNumber');
      
      // If all done, show ready message
      if (stillMissing.length === 0) {
        lastQuestion.delete(channelId);
        setOnboarded(channelId, true);
        return { 
          complete: true, 
          reply: `${extraction.confirmation}\n\n${generateReadyMessage(updatedCtx, updatedConfig)}` 
        };
      }
      
      // Ask next question
      const nextQuestionType = stillMissing[0];
      const question = generateQuestion(nextQuestionType, updatedCtx);
      lastQuestion.set(channelId, { type: nextQuestionType, askedAt: Date.now() });
      
      return { 
        complete: false, 
        reply: `${extraction.confirmation}\n\n${question}` 
      };
    }
  }
  
  // Ask the first missing question
  const questionType = missing[0];
  const question = generateQuestion(questionType, knownCtx);
  lastQuestion.set(channelId, { type: questionType, askedAt: Date.now() });
  
  return { complete: false, reply: question };
}

function generateQuestion(type, knownCtx) {
  switch (type) {
    case 'projectName':
      return `🤔 **Hey! I'm ready to track your tasks. Let's get set up:**\n\nWhat project are you working on?\n_(e.g., "ShopApp, an e-commerce platform")_`;
    
    case 'teamMembers':
      return `🤔 **Who's on the team?**\n\nList your team members with their GitHub usernames:\n_\`@discord (github-username)\`_\n\nExample: \`@alex (alex-smith), @sarah (sarah-dev)\``;
    
    case 'projectNumber':
      return `🤔 **What's your GitHub Project number?**\n\nFind it in your project URL:\n\`github.com/owner/repo/projects/N\`\n\nJust tell me the number (e.g., "3" or "project 5")`;
    
    default:
      return `🤔 Tell me more about your project...`;
  }
}

async function extractOnboardingAnswer(message, channelId, questionType) {
  const knownCtx = getKnownContext(channelId);
  const config = loadConfig();
  
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `You extract information from a user's response to an onboarding question.

Question asked: "${questionType}"
Expected answer type: ${
  questionType === 'projectName' ? 'Project name and optional description' :
  questionType === 'teamMembers' ? 'List of team members with GitHub usernames' :
  questionType === 'projectNumber' ? 'A number (GitHub Project number)' :
  'Any relevant info'
}

Current context:
- Project: ${knownCtx.projectName || 'Unknown'}
- Team: ${knownCtx.teamMembers.length > 0 ? knownCtx.teamMembers.join(', ') : 'Unknown'}
- GitHub Project #: ${config.projectConfig.projectNumber || 'Unknown'}

Extract the answer and return JSON:
{
  "extracted": boolean,
  "data": {
    "projectName": "string or null",
    "projectDescription": "string or null", 
    "teamMembers": [{"discord": "string", "github": "string"}] or null,
    "projectNumber": number or null
  },
  "confirmation": "string (friendly confirmation message)"
}

Rules:
- For projectNumber: Extract just the number, even from phrases like "project 3" or "it's number 5"
- For teamMembers: Parse formats like "@alex (alex-gh)" or "alex is alex-gh"
- Be flexible with user input
- Generate a friendly confirmation like "✅ Got it! Project: ShopApp"`
      },
      { role: 'user', content: message }
    ],
    response_format: { type: 'json_object' }
  });
  
  const result = JSON.parse(response.choices[0].message.content);
  console.log('Onboarding extraction:', result);
  
  // Apply extracted data
  if (result.extracted && result.data) {
    const contextUpdates = {};
    let configUpdated = false;
    
    if (result.data.projectName) {
      contextUpdates.projectName = result.data.projectName;
    }
    if (result.data.projectDescription) {
      contextUpdates.projectDescription = result.data.projectDescription;
    }
    
    // Save team members to users.json and context
    if (result.data.teamMembers && result.data.teamMembers.length > 0) {
      for (const member of result.data.teamMembers) {
        const normalized = member.discord.toLowerCase().replace(/[@]/g, '');
        config.discordToGithub[normalized] = member.github;
      }
      contextUpdates.teamMembers = result.data.teamMembers.map(m => m.discord);
      configUpdated = true;
    }
    
    // Save project number to config
    if (result.data.projectNumber !== null && result.data.projectNumber !== undefined) {
      config.projectConfig.projectNumber = result.data.projectNumber;
      configUpdated = true;
    }
    
    // Apply context updates
    if (Object.keys(contextUpdates).length > 0) {
      updateKnownContext(channelId, contextUpdates);
    }
    
    // Save config if changed
    if (configUpdated) {
      saveConfig(config);
    }
  }
  
  return result;
}

function generateReadyMessage(knownCtx, config) {
  const teamList = knownCtx.teamMembers.length > 0 
    ? knownCtx.teamMembers.join(', ') 
    : 'No team members set';
  
  let msg = `✅ **All set! 🚀**\n\n`;
  msg += `📋 **Project:** ${knownCtx.projectName || 'Unknown'}\n`;
  msg += `👥 **Team:** ${teamList}\n`;
  msg += `📊 **GitHub Project:** #${config.projectConfig.projectNumber}\n\n`;
  msg += `_Just chat and I'll create tasks automatically!_`;
  
  return msg;
}

async function checkContextNeeds(message, channelId) {
  const context = getContext(channelId);
  const knownCtx = getKnownContext(channelId);
  const config = loadConfig();
  
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a helpful project assistant. Analyze the conversation and determine if context needs updating.

Known context:
- Project Name: ${knownCtx.projectName || 'Unknown'}
- Team Members: ${knownCtx.teamMembers.length > 0 ? knownCtx.teamMembers.join(', ') : 'Unknown'}
- Sprint/Goal: ${knownCtx.sprintGoal || 'Unknown'}

Recent conversation:
${context.join('\n')}

Your job:
1. Check if this message provides context updates (new team member, project name change, etc.)
2. Extract any context updates

Return JSON only:
{
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
  
  const config = loadConfig();
  
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
    saveConfig(config);
  }
  
  return updated;
}

module.exports = { 
  runOnboarding,
  checkContextNeeds,
  extractTask, 
  extractUserMappings, 
  updateUserMappings 
};