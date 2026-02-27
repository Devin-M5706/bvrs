// In-memory storage (resets on restart - fine for hackathon!)
const conversationContext = new Map(); // channelId -> Array<messages>
const taskHashes = new Set(); // For deduplication
const knownContext = new Map(); // channelId -> { projectName, teamMembers, sprintGoal, etc. }
const onboardingComplete = new Map(); // channelId -> boolean

function addToContext(channelId, content, username) {
  if (!conversationContext.has(channelId)) {
    conversationContext.set(channelId, []);
  }
  
  const messages = conversationContext.get(channelId);
  messages.push({
    content,
    username,
    timestamp: Date.now()
  });
  
  // Keep only last 20 messages per channel
  if (messages.length > 20) {
    messages.shift();
  }
}

function getContext(channelId) {
  const messages = conversationContext.get(channelId) || [];
  // Format as "username: message" for context
  return messages.map(m => `${m.username}: ${m.content}`);
}

function getKnownContext(channelId) {
  return knownContext.get(channelId) || {
    projectName: null,
    teamMembers: [],
    sprintGoal: null,
    projectDescription: null,
    githubOwner: null,
    githubRepo: null
  };
}

function updateKnownContext(channelId, updates) {
  const current = getKnownContext(channelId);
  knownContext.set(channelId, { ...current, ...updates });
  console.log(`✅ Updated context for channel ${channelId}:`, updates);
}

function isOnboarded(channelId) {
  return onboardingComplete.get(channelId) || false;
}

function setOnboarded(channelId, status = true) {
  onboardingComplete.set(channelId, status);
}

function hasMinimumContext(channelId) {
  const ctx = getKnownContext(channelId);
  const config = require('../config/users.json');
  return ctx.projectName && 
         ctx.teamMembers.length > 0 && 
         config.projectConfig.projectNumber !== null;
}

function isDuplicate(taskTitle) {
  // Normalize title for comparison
  const hash = taskTitle
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .substring(0, 50); // Use first 50 chars
  
  if (taskHashes.has(hash)) {
    console.log('⚠️  Duplicate task detected:', taskTitle);
    return true;
  }
  
  taskHashes.add(hash);
  return false;
}

// Clear context for a channel (optional utility)
function clearContext(channelId) {
  conversationContext.delete(channelId);
  knownContext.delete(channelId);
  onboardingComplete.delete(channelId);
}

// Get stats (useful for debugging)
function getStats() {
  return {
    channels: conversationContext.size,
    tasksTracked: taskHashes.size,
    contextChannels: knownContext.size,
    onboardedChannels: onboardingComplete.size
  };
}

module.exports = { 
  addToContext, 
  getContext, 
  getKnownContext,
  updateKnownContext,
  hasMinimumContext,
  isOnboarded,
  setOnboarded,
  isDuplicate, 
  clearContext,
  getStats 
};
