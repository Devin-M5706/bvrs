// In-memory storage (resets on restart - fine for hackathon!)
const conversationContext = new Map(); // channelId -> Array<messages>
const taskHashes = new Set(); // For deduplication
const knownContext = new Map(); // channelId -> { projectName, teamMembers, sprintGoal, etc. }

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
  
  // Keep only last 10 messages per channel
  if (messages.length > 10) {
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
    projectDescription: null
  };
}

function updateKnownContext(channelId, updates) {
  const current = getKnownContext(channelId);
  knownContext.set(channelId, { ...current, ...updates });
  console.log(`✅ Updated context for channel ${channelId}:`, updates);
}

function hasMinimumContext(channelId) {
  const ctx = getKnownContext(channelId);
  return ctx.projectName && ctx.teamMembers.length > 0;
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
}

// Get stats (useful for debugging)
function getStats() {
  return {
    channels: conversationContext.size,
    tasksTracked: taskHashes.size,
    contextChannels: knownContext.size
  };
}

module.exports = { 
  addToContext, 
  getContext, 
  getKnownContext,
  updateKnownContext,
  hasMinimumContext,
  isDuplicate, 
  clearContext,
  getStats 
};
