// Thread-Aware Context System
// Handles threads, entity resolution, decisions, temporal patterns, cross-channel memory

const { getContext, getKnownContext, updateKnownContext } = require('./memory');

// ============================================
// DATA STRUCTURES
// ============================================

// Thread tracking: channelId -> Array<Thread>
const threads = new Map();

// Entity resolution: channelId -> EntityMap
const entityMaps = new Map();

// Decision tracking: channelId -> Array<Decision>
const decisions = new Map();

// Task origins: taskId -> OriginInfo
const taskOrigins = new Map();

// Cross-channel project memory: projectName -> ProjectMemory
const projectMemory = new Map();

// Confidence trail: Array<ConfidenceEntry>
const confidenceTrail = [];

// Attention scores cache: channelId -> Array<ScoredMessage>
const attentionCache = new Map();

// ============================================
// 1. THREAD-AWARE CONTEXT
// ============================================

class Thread {
  constructor(id, channelId, topic = null) {
    this.id = id;
    this.channelId = channelId;
    this.topic = topic;
    this.messages = [];
    this.entities = new Set();
    this.taskCreated = false;
    this.taskId = null;
    this.startedAt = Date.now();
    this.lastActivityAt = Date.now();
    this.isActive = true;
  }

  addMessage(messageId, content, username, timestamp) {
    this.messages.push({
      id: messageId,
      content,
      username,
      timestamp,
      attentionScore: null
    });
    this.lastActivityAt = timestamp;
    
    // Auto-close thread after 30 minutes of inactivity
    if (this.isActive && Date.now() - this.lastActivityAt > 30 * 60 * 1000) {
      this.isActive = false;
    }
  }

  linkTask(taskId) {
    this.taskCreated = true;
    this.taskId = taskId;
  }

  getSummary() {
    const recentMessages = this.messages.slice(-5);
    return {
      topic: this.topic,
      messageCount: this.messages.length,
      participants: [...new Set(this.messages.map(m => m.username))],
      recentMessages: recentMessages.map(m => `${m.username}: ${m.content}`),
      taskCreated: this.taskCreated,
      taskId: this.taskId,
      duration: Date.now() - this.startedAt
    };
  }
}

function getOrCreateThread(channelId, messageId, content) {
  if (!threads.has(channelId)) {
    threads.set(channelId, []);
  }
  
  const channelThreads = threads.get(channelId);
  
  // Find active thread or create new one
  let activeThread = channelThreads.find(t => t.isActive);
  
  // Check if content suggests a new topic
  const topicChange = detectTopicChange(content);
  
  if (!activeThread || topicChange.isNewTopic) {
    activeThread = new Thread(
      `${channelId}-${Date.now()}`,
      channelId,
      topicChange.topic || null
    );
    channelThreads.push(activeThread);
  }
  
  return activeThread;
}

function detectTopicChange(content) {
  const newTopicIndicators = [
    /^(?:hey|hi|so|ok|anyway|btw|moving on)/i,
    /^(?:new topic|different question|one more thing)/i,
    /^(?:also|additionally|another thing)/i
  ];
  
  const isNewTopic = newTopicIndicators.some(pattern => pattern.test(content));
  
  // Extract potential topic from content
  const topicMatch = content.match(/(?:the\s+)?(\w+(?:\s+\w+)?)(?:\s+(?:issue|bug|feature|task|problem))/i);
  const topic = topicMatch ? topicMatch[1] : null;
  
  return { isNewTopic, topic };
}

function addMessageToThread(channelId, messageId, content, username, timestamp = Date.now()) {
  const thread = getOrCreateThread(channelId, messageId, content);
  thread.addMessage(messageId, content, username, timestamp);
  
  // Extract and track entities
  const entities = extractEntities(content);
  // entities is an object with arrays, not an array itself
  const allEntities = [
    ...entities.people,
    ...entities.tasks,
    ...entities.features,
    ...entities.concepts
  ];
  allEntities.forEach(e => thread.entities.add(e));
  
  return thread;
}

function getActiveThread(channelId) {
  const channelThreads = threads.get(channelId) || [];
  return channelThreads.find(t => t.isActive) || null;
}

function getThreadByTaskId(taskId) {
  for (const [channelId, channelThreads] of threads) {
    const thread = channelThreads.find(t => t.taskId === taskId);
    if (thread) return thread;
  }
  return null;
}

// ============================================
// 2. ENTITY RESOLUTION & REFERENCE TRACKING
// ============================================

class EntityMap {
  constructor(channelId) {
    this.channelId = channelId;
    this.people = new Map();       // name -> { mentions, lastMention, github }
    this.tasks = new Map();        // taskTitle -> { mentions, taskId, status }
    this.features = new Map();     // featureName -> { mentions, relatedTasks }
    this.concepts = new Map();     // concept -> { mentions, context }
    this.focusStack = [];          // Stack of currently-discussed entities
    this.lastUpdated = Date.now();
  }

  addPerson(name, githubUsername = null) {
    const normalized = name.toLowerCase().replace(/[@]/g, '');
    const existing = this.people.get(normalized) || { mentions: 0, lastMention: null, github: null };
    this.people.set(normalized, {
      mentions: existing.mentions + 1,
      lastMention: Date.now(),
      github: githubUsername || existing.github
    });
    this.pushToFocusStack({ type: 'person', name: normalized });
  }

  addTask(title, taskId = null, status = 'mentioned') {
    const normalized = title.toLowerCase().substring(0, 50);
    const existing = this.tasks.get(normalized) || { mentions: 0, taskId: null, status: null };
    this.tasks.set(normalized, {
      mentions: existing.mentions + 1,
      taskId: taskId || existing.taskId,
      status: status
    });
    this.pushToFocusStack({ type: 'task', name: normalized, title });
  }

  addFeature(name) {
    const existing = this.features.get(name) || { mentions: 0, relatedTasks: [] };
    this.features.set(name, {
      mentions: existing.mentions + 1,
      relatedTasks: existing.relatedTasks
    });
    this.pushToFocusStack({ type: 'feature', name });
  }

  pushToFocusStack(entity) {
    // Remove if already in stack
    this.focusStack = this.focusStack.filter(e => 
      !(e.type === entity.type && e.name === entity.name)
    );
    // Add to top
    this.focusStack.unshift({ ...entity, timestamp: Date.now() });
    // Keep only last 10
    if (this.focusStack.length > 10) {
      this.focusStack = this.focusStack.slice(0, 10);
    }
  }

  resolveReference(reference) {
    const lowerRef = reference.toLowerCase();
    
    // Pronoun resolution
    const pronounMap = {
      'he': 'person',
      'she': 'person',
      'they': 'person',
      'it': 'task_or_feature',
      'that': 'task_or_feature',
      'this': 'task_or_feature',
      'the issue': 'task',
      'the bug': 'task',
      'the task': 'task',
      'the feature': 'feature'
    };
    
    const type = pronounMap[lowerRef];
    if (!type) return null;
    
    // Look up in focus stack
    const resolved = this.focusStack.find(e => {
      if (type === 'person') return e.type === 'person';
      if (type === 'task_or_feature') return e.type === 'task' || e.type === 'feature';
      if (type === 'task') return e.type === 'task';
      if (type === 'feature') return e.type === 'feature';
      return false;
    });
    
    return resolved || null;
  }

  getCurrentFocus() {
    return this.focusStack.slice(0, 3);
  }
}

function getEntityMap(channelId) {
  if (!entityMaps.has(channelId)) {
    entityMaps.set(channelId, new EntityMap(channelId));
  }
  return entityMaps.get(channelId);
}

function extractEntities(content) {
  const entities = {
    people: [],
    tasks: [],
    features: [],
    concepts: []
  };
  
  // Extract @mentions
  const mentionMatches = content.match(/@?(\w+)/g) || [];
  entities.people = mentionMatches
    .map(m => m.replace('@', ''))
    .filter(m => m.length > 2);
  
  // Extract task-like patterns
  const taskPatterns = [
    /(?:fix|fixing|fixes)\s+(?:the\s+)?(\w+(?:\s+\w+)?)/gi,
    /(?:implement|implementing)\s+(?:the\s+)?(\w+(?:\s+\w+)?)/gi,
    /(?:bug|issue)\s+(?:with\s+|in\s+)?(\w+(?:\s+\w+)?)/gi
  ];
  
  taskPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      entities.tasks.push(match[1]);
    }
  });
  
  // Extract feature names (capitalized phrases)
  const featureMatches = content.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g) || [];
  entities.features = featureMatches;
  
  return entities;
}

function resolvePronouns(content, channelId) {
  const entityMap = getEntityMap(channelId);
  const pronouns = ['he', 'she', 'they', 'it', 'that', 'this'];
  const resolved = {};
  
  pronouns.forEach(pronoun => {
    const regex = new RegExp(`\\b${pronoun}\\b`, 'gi');
    if (regex.test(content)) {
      const ref = entityMap.resolveReference(pronoun);
      if (ref) {
        resolved[pronoun] = ref;
      }
    }
  });
  
  return resolved;
}

// ============================================
// 3. DECISION TRACKING
// ============================================

class Decision {
  constructor(channelId, threadId) {
    this.id = `${channelId}-decision-${Date.now()}`;
    this.channelId = channelId;
    this.threadId = threadId;
    this.what = null;
    this.why = null;
    this.who = null;
    this.when = Date.now();
    this.alternatives = [];
    this.relatedTaskId = null;
    this.confidence = null;
  }
}

function recordDecision(channelId, decision) {
  if (!decisions.has(channelId)) {
    decisions.set(channelId, []);
  }
  decisions.get(channelId).push(decision);
  return decision;
}

function extractDecision(content, username, channelId) {
  // Decision patterns
  const decisionPatterns = [
    /(?:let's|we should|we'll|we will|I think we should|decided to)\s+(.+)/i,
    /(?:going with|choosing|selected|picked)\s+(.+?)(?:\s+because|\s+over|\s*,|\s*$)/i,
    /(?:the plan is|plan is to)\s+(.+)/i
  ];
  
  for (const pattern of decisionPatterns) {
    const match = content.match(pattern);
    if (match) {
      const decision = new Decision(channelId, getActiveThread(channelId)?.id);
      decision.what = match[1].trim();
      decision.who = username;
      
      // Try to extract "why"
      const whyMatch = content.match(/because\s+(.+?)(?:\.|,|$)/i);
      if (whyMatch) {
        decision.why = whyMatch[1].trim();
      }
      
      // Try to extract alternatives
      const altMatch = content.match(/instead of\s+(.+?)(?:\.|,|$)/i);
      if (altMatch) {
        decision.alternatives.push(altMatch[1].trim());
      }
      
      return recordDecision(channelId, decision);
    }
  }
  
  return null;
}

function getRecentDecisions(channelId, limit = 5) {
  const channelDecisions = decisions.get(channelId) || [];
  return channelDecisions.slice(-limit);
}

// ============================================
// 4. TEMPORAL CONTEXT & PATTERNS
// ============================================

function analyzeTemporalPatterns(channelId) {
  const channelThreads = threads.get(channelId) || [];
  const now = Date.now();
  
  const patterns = {
    recurringTopics: [],
    urgencyTrends: [],
    stalenessAlerts: [],
    deadlineWarnings: []
  };
  
  // Analyze recurring topics
  const topicCounts = {};
  channelThreads.forEach(thread => {
    if (thread.topic) {
      topicCounts[thread.topic] = (topicCounts[thread.topic] || 0) + 1;
    }
  });
  
  patterns.recurringTopics = Object.entries(topicCounts)
    .filter(([_, count]) => count >= 2)
    .map(([topic, count]) => ({ topic, count }));
  
  // Check for stale tasks
  const entityMap = getEntityMap(channelId);
  entityMap.tasks.forEach((data, taskName) => {
    if (data.status === 'mentioned' || data.status === 'in_progress') {
      const thread = getThreadByTaskId(data.taskId);
      if (thread) {
        const hoursSinceActivity = (now - thread.lastActivityAt) / (1000 * 60 * 60);
        if (hoursSinceActivity > 24) {
          patterns.stalenessAlerts.push({
            task: taskName,
            hoursSinceActivity: Math.round(hoursSinceActivity),
            lastMentionedBy: thread.messages[thread.messages.length - 1]?.username
          });
        }
      }
    }
  });
  
  return patterns;
}

function extractTimeContext(content) {
  const timePatterns = {
    relative: [
      { pattern: /(\d+)\s*(?:hours?|hrs?|h)\s+ago/i, unit: 'hours' },
      { pattern: /(\d+)\s*(?:days?|d)\s+ago/i, unit: 'days' },
      { pattern: /(\d+)\s*(?:weeks?|w)\s+ago/i, unit: 'weeks' },
      { pattern: /yesterday/i, unit: 'days', value: 1 },
      { pattern: /this morning/i, unit: 'hours', value: 12 },
      { pattern: /just now|right now|currently/i, unit: 'minutes', value: 0 }
    ],
    deadline: [
      { pattern: /by\s+(?:this\s+)?(\w+day)/i, type: 'weekday' },
      { pattern: /by\s+(?:end of\s+)?(\w+)/i, type: 'period' },
      { pattern: /(?:needs? to be done|due)\s+(?:by|before)\s+(.+)/i, type: 'deadline' },
      { pattern: /(\d+)\s*(?:hours?|days?|weeks?)\s+(?:from now|left)/i, type: 'duration' }
    ],
    duration: [
      { pattern: /for\s+(\d+)\s*(?:hours?|days?|weeks?)/i, type: 'ongoing' },
      { pattern: /(?:been|for)\s+(?:the\s+)?(?:last|past)\s+(\d+)\s*(?:hours?|days?|weeks?)/i, type: 'elapsed' }
    ]
  };
  
  const extracted = {
    relative: null,
    deadline: null,
    duration: null
  };
  
// ... existing code up to the extractTimeContext function ...

  // Extract relative time
  for (const { pattern, unit, value } of timePatterns.relative) {
    const match = content.match(pattern);
    if (match) {
      extracted.relative = {
        value: value !== undefined ? value : parseInt(match[1]),
        unit,
        raw: match[0]
      };
      break;
    }
  }
  
  // Extract deadline
  for (const { pattern, type } of timePatterns.deadline) {
    const match = content.match(pattern);
    if (match) {
      extracted.deadline = {
        target: match[1],
        type,
        raw: match[0]
      };
      break;
    }
  }
  
  // Extract duration
  for (const { pattern, type } of timePatterns.duration) {
    const match = content.match(pattern);
    if (match) {
      extracted.duration = {
        value: parseInt(match[1]),
        type,
        raw: match[0]
      };
      break;
    }
  }
  
  return extracted;
}

function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return 'just now';
}

// ============================================
// 5. TASK ↔ CONVERSATION LINKING
// ============================================

class TaskOrigin {
  constructor(taskId, channelId, threadId) {
    this.taskId = taskId;
    this.channelId = channelId;
    this.threadId = threadId;
    this.messages = [];
    this.entities = [];
    this.decision = null;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }
  
  addMessage(content, username, timestamp) {
    this.messages.push({ content, username, timestamp });
    this.updatedAt = Date.now();
  }
  
  setDecision(decision) {
    this.decision = decision;
  }
  
  getSummary() {
    const recentMessages = this.messages.slice(-3);
    return {
      taskId: this.taskId,
      messageCount: this.messages.length,
      recentMessages: recentMessages.map(m => `${m.username}: ${m.content}`),
      decision: this.decision ? {
        what: this.decision.what,
        why: this.decision.why,
        who: this.decision.who
      } : null,
      age: formatRelativeTime(this.createdAt)
    };
  }
  
  getFullContext() {
    return {
      taskId: this.taskId,
      channelId: this.channelId,
      threadId: this.threadId,
      fullConversation: this.messages.map(m => ({
        username: m.username,
        content: m.content,
        time: formatRelativeTime(m.timestamp)
      })),
      decision: this.decision,
      entities: this.entities,
      createdAt: new Date(this.createdAt).toISOString()
    };
  }
}

function linkTaskToOrigin(taskId, channelId, threadId, messages = []) {
  const origin = new TaskOrigin(taskId, channelId, threadId);
  messages.forEach(m => {
    origin.addMessage(m.content, m.username, m.timestamp || Date.now());
  });
  taskOrigins.set(taskId, origin);
  
  // Also link the thread
  const thread = getThreadByTaskId(taskId) || getActiveThread(channelId);
  if (thread) {
    thread.linkTask(taskId);
  }
  
  return origin;
}

function getTaskOrigin(taskId) {
  return taskOrigins.get(taskId) || null;
}

function addMessageToTaskOrigin(taskId, content, username) {
  const origin = taskOrigins.get(taskId);
  if (origin) {
    origin.addMessage(content, username, Date.now());
    return true;
  }
  return false;
}

function findTaskOriginByKeyword(keyword, channelId = null) {
  const normalized = keyword.toLowerCase();
  
  for (const [taskId, origin] of taskOrigins) {
    if (channelId && origin.channelId !== channelId) continue;
    
    // Check messages for keyword
    const found = origin.messages.some(m => 
      m.content.toLowerCase().includes(normalized)
    );
    if (found) return { taskId, origin };
  }
  
  return null;
}

// ============================================
// 6. CROSS-CHANNEL PROJECT MEMORY
// ============================================

class ProjectMemory {
  constructor(projectName) {
    this.projectName = projectName;
    this.channels = new Map();       // channelId -> { name, purpose }
    this.sharedEntities = new Map(); // entity -> { channels, mentions }
    this.crossChannelDecisions = [];
    this.activeTasks = new Map();    // taskId -> { channelId, status }
    this.lastSynced = Date.now();
  }
  
  registerChannel(channelId, name = null, purpose = null) {
    this.channels.set(channelId, {
      name: name || channelId,
      purpose,
      registeredAt: Date.now()
    });
  }
  
  addCrossChannelEntity(entity, channelId) {
    const existing = this.sharedEntities.get(entity) || { channels: new Set(), mentions: 0 };
    existing.channels.add(channelId);
    existing.mentions++;
    this.sharedEntities.set(entity, existing);
  }
  
  addTask(taskId, channelId, status = 'mentioned') {
    this.activeTasks.set(taskId, { channelId, status, addedAt: Date.now() });
  }
  
  updateTaskStatus(taskId, status) {
    const task = this.activeTasks.get(taskId);
    if (task) {
      task.status = status;
      task.updatedAt = Date.now();
    }
  }
  
  getTaskDistribution() {
    const distribution = {};
    for (const [taskId, data] of this.activeTasks) {
      const channel = data.channelId;
      distribution[channel] = (distribution[channel] || 0) + 1;
    }
    return distribution;
  }
  
  getTrendingEntities(limit = 5) {
    return [...this.sharedEntities.entries()]
      .sort((a, b) => b[1].mentions - a[1].mentions)
      .slice(0, limit)
      .map(([entity, data]) => ({
        entity,
        mentions: data.mentions,
        channels: [...data.channels].length
      }));
  }
}

function getProjectMemory(projectName) {
  if (!projectMemory.has(projectName)) {
    projectMemory.set(projectName, new ProjectMemory(projectName));
  }
  return projectMemory.get(projectName);
}

function syncChannelToProject(projectName, channelId, entityMap) {
  const project = getProjectMemory(projectName);
  project.registerChannel(channelId);
  
  // Sync entities
  entityMap.people.forEach((data, name) => {
    project.addCrossChannelEntity(`person:${name}`, channelId);
  });
  entityMap.tasks.forEach((data, title) => {
    project.addCrossChannelEntity(`task:${title}`, channelId);
    if (data.taskId) {
      project.addTask(data.taskId, channelId, data.status);
    }
  });
  entityMap.features.forEach((data, name) => {
    project.addCrossChannelEntity(`feature:${name}`, channelId);
  });
  
  project.lastSynced = Date.now();
}

function getCrossChannelContext(projectName) {
  const project = getProjectMemory(projectName);
  return {
    channels: [...project.channels.entries()].map(([id, data]) => ({
      channelId: id,
      ...data
    })),
    trendingEntities: project.getTrendingEntities(),
    taskDistribution: project.getTaskDistribution(),
    totalTasks: project.activeTasks.size
  };
}

// ============================================
// 7. CONFIDENCE TRAIL & LEARNING
// ============================================

class ConfidenceEntry {
  constructor(message, result, action, outcome = null) {
    this.id = `conf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.timestamp = Date.now();
    this.message = message;
    this.result = result;           // { isActionable, confidence, title }
    this.action = action;           // 'created', 'asked_clarification', 'skipped'
    this.outcome = outcome;         // 'accepted', 'rejected', 'corrected', null
    this.correction = null;         // What it should have been, if rejected
    this.patterns = this.extractPatterns(message);
  }
  
  extractPatterns(message) {
    return {
      length: message.length,
      hasHedging: /(?:maybe|might|could|perhaps|possibly|someday|eventually)/i.test(message),
      hasUrgency: /(?:asap|urgent|critical|blocking|right now|immediately)/i.test(message),
      hasAssignee: /(?:@\w+|\b(?:you|he|she|they)\b\s+(?:should|can|could|need))/i.test(message),
      hasDeadline: /(?:by|before|due|deadline|friday|monday|tomorrow)/i.test(message),
      isQuestion: /\?/.test(message),
      firstWord: message.split(' ')[0]?.toLowerCase(),
      wordCount: message.split(/\s+/).length
    };
  }
  
  setOutcome(outcome, correction = null) {
    this.outcome = outcome;
    this.correction = correction;
  }
}

function recordConfidence(message, result, action) {
  const entry = new ConfidenceEntry(message, result, action);
  confidenceTrail.push(entry);
  
  // Keep only last 1000 entries
  if (confidenceTrail.length > 1000) {
    confidenceTrail.shift();
  }
  
  return entry;
}

function recordOutcome(entryId, outcome, correction = null) {
  const entry = confidenceTrail.find(e => e.id === entryId);
  if (entry) {
    entry.setOutcome(outcome, correction);
    return true;
  }
  return false;
}

function analyzeConfidencePatterns() {
  const analysis = {
    totalEntries: confidenceTrail.length,
    byConfidence: { high: 0, medium: 0, low: 0 },
    byOutcome: { accepted: 0, rejected: 0, corrected: 0, pending: 0 },
    falsePositives: [],
    patterns: {}
  };
  
  confidenceTrail.forEach(entry => {
    // Count by confidence
    if (entry.result.confidence) {
      analysis.byConfidence[entry.result.confidence]++;
    }
    
    // Count by outcome
    if (entry.outcome) {
      analysis.byOutcome[entry.outcome]++;
    } else {
      analysis.byOutcome.pending++;
    }
    
    // Track false positives (medium/high confidence that was rejected)
    if (entry.outcome === 'rejected' && entry.result.confidence !== 'low') {
      analysis.falsePositives.push({
        message: entry.message,
        predictedTitle: entry.result.title,
        patterns: entry.patterns
      });
    }
  });
  
  // Analyze pattern correlations
  analysis.patterns = {
    hedgingReducesConfidence: analyzePatternCorrelation('hasHedging', 'low'),
    urgencyIncreasesConfidence: analyzePatternCorrelation('hasUrgency', 'high'),
    questionsAreLowConfidence: analyzePatternCorrelation('isQuestion', 'low')
  };
  
  return analysis;
}

function analyzePatternCorrelation(patternKey, targetConfidence) {
  const withPattern = confidenceTrail.filter(e => e.patterns[patternKey]);
  const matchingConfidence = withPattern.filter(e => e.result.confidence === targetConfidence);
  
  if (withPattern.length === 0) return null;
  
  return {
    total: withPattern.length,
    matchingTarget: matchingConfidence.length,
    percentage: Math.round((matchingConfidence.length / withPattern.length) * 100)
  };
}

function getLearnedConfidenceAdjustment(message, baseConfidence) {
  const patterns = new ConfidenceEntry(message, {}, null).patterns;
  const analysis = analyzeConfidencePatterns();
  
  let adjustment = 0;
  
  // Apply learned adjustments
  if (patterns.hasHedging && analysis.patterns.hedgingReducesConfidence) {
    if (analysis.patterns.hedgingReducesConfidence.percentage > 60) {
      adjustment -= 1; // Downgrade confidence
    }
  }
  
  if (patterns.hasUrgency && analysis.patterns.urgencyIncreasesConfidence) {
    if (analysis.patterns.urgencyIncreasesConfidence.percentage > 60) {
      adjustment += 1; // Upgrade confidence
    }
  }
  
  if (patterns.isQuestion && analysis.patterns.questionsAreLowConfidence) {
    if (analysis.patterns.questionsAreLowConfidence.percentage > 50) {
      adjustment -= 1;
    }
  }
  
  // Apply adjustment to confidence
  const levels = ['low', 'medium', 'high'];
  const currentIndex = levels.indexOf(baseConfidence);
  const newIndex = Math.max(0, Math.min(2, currentIndex + adjustment));
  
  return {
    originalConfidence: baseConfidence,
    adjustedConfidence: levels[newIndex],
    adjustment,
    reasons: getAdjustmentReasons(patterns, analysis)
  };
}

function getAdjustmentReasons(patterns, analysis) {
  const reasons = [];
  
  if (patterns.hasHedging) {
    reasons.push('Message contains hedging language (maybe, might, someday)');
  }
  if (patterns.isQuestion) {
    reasons.push('Message is phrased as a question');
  }
  if (patterns.hasUrgency) {
    reasons.push('Message contains urgency indicators');
  }
  if (patterns.wordCount < 5) {
    reasons.push('Message is very short');
  }
  
  return reasons;
}

// ============================================
// 8. ATTENTION SCORING
// ============================================

function calculateAttentionScore(message, context = {}) {
  let score = 0;
  const content = message.content || message;
  
  // High-value indicators (+ points)
  const highValuePatterns = [
    { pattern: /(?:bug|issue|broken|crash|error|fail)/i, points: 30, reason: 'Bug/issue mention' },
    { pattern: /(?:urgent|asap|critical|blocking|production)/i, points: 25, reason: 'Urgency indicator' },
    { pattern: /(?:need\s+to|have\s+to|must|should|todo)/i, points: 20, reason: 'Task language' },
    { pattern: /@(\w+)/, points: 15, reason: 'Direct mention' },
    { pattern: /(?:implement|build|create|fix|add)/i, points: 15, reason: 'Action verb' },
    { pattern: /(?:deadline|by\s+\w+|before\s+\w+)/i, points: 10, reason: 'Time constraint' },
    { pattern: /(?:customer|user|client|revenue)/i, points: 15, reason: 'Business impact' }
  ];
  
  // Low-value indicators (- points)
  const lowValuePatterns = [
    { pattern: /^(?:ok|okay|cool|nice|got it|thanks|ty|lol|ha)/i, points: -20, reason: 'Low-info response' },
    { pattern: /^(?:hey|hi|hello|yo|sup)/i, points: -15, reason: 'Greeting' },
    { pattern: /^\s*$/, points: -30, reason: 'Empty message' },
    { pattern: /(?:lol|lmao|haha|hehe)/i, points: -10, reason: 'Casual response' }
  ];
  
  // Apply pattern scoring
  const matchedReasons = [];
  
  highValuePatterns.forEach(({ pattern, points, reason }) => {
    if (pattern.test(content)) {
      score += points;
      matchedReasons.push({ reason, points, type: 'positive' });
    }
  });
  
  lowValuePatterns.forEach(({ pattern, points, reason }) => {
    if (pattern.test(content)) {
      score += points;
      matchedReasons.push({ reason, points, type: 'negative' });
    }
  });
  
  // Context adjustments
  if (context.inReplyTo) {
    score += 5; // Replies are more important
    matchedReasons.push({ reason: 'Reply message', points: 5, type: 'context' });
  }
  
  if (context.previousMentionedSameTopic) {
    score += 10; // Continuing discussion
    matchedReasons.push({ reason: 'Continuing topic', points: 10, type: 'context' });
  }
  
  // Normalize score to 0-100 range
  score = Math.max(0, Math.min(100, score));
  
  return {
    score,
    level: score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low',
    reasons: matchedReasons
  };
}

function scoreAndCacheMessage(channelId, message) {
  if (!attentionCache.has(channelId)) {
    attentionCache.set(channelId, []);
  }
  
  const scoredMessage = {
    ...message,
    attention: calculateAttentionScore(message)
  };
  
  const cache = attentionCache.get(channelId);
  cache.push(scoredMessage);
  
  // Keep only last 100 messages
  if (cache.length > 100) {
    cache.shift();
  }
  
  return scoredMessage;
}

function getHighAttentionMessages(channelId, threshold = 60) {
  const cache = attentionCache.get(channelId) || [];
  return cache.filter(m => m.attention.score >= threshold);
}

function summarizeLowAttention(channelId) {
  const cache = attentionCache.get(channelId) || [];
  const lowAttention = cache.filter(m => m.attention.score < 30);
  
  if (lowAttention.length === 0) return null;
  
  return {
    count: lowAttention.length,
    summary: `${lowAttention.length} low-importance messages (greetings, acknowledgments, etc.)`,
    messages: lowAttention.slice(-10).map(m => m.content?.substring(0, 50))
  };
}

// ... existing code up to processMessage function ...

// ============================================
// INTEGRATION: PROCESS MESSAGE THROUGH ALL CONTEXT SYSTEMS
// ============================================

function processMessage(channelId, content, username, projectName = null) {
  const timestamp = Date.now();
  const messageId = `${channelId}-${timestamp}`;
  
  // 1. Add to thread
  const thread = addMessageToThread(channelId, messageId, content, username, timestamp);
  
  // 2. Update entity map
  const entityMap = getEntityMap(channelId);
  const entities = extractEntities(content);
  
  entities.people.forEach(p => entityMap.addPerson(p));
  entities.tasks.forEach(t => entityMap.addTask(t));
  entities.features.forEach(f => entityMap.addFeature(f));
  
  // 3. Resolve pronouns
  const resolvedPronouns = resolvePronouns(content, channelId);
  
  // 4. Extract decisions
  const decision = extractDecision(content, username, channelId);
  
  // 5. Extract time context
  const timeContext = extractTimeContext(content);
  
  // 6. Score attention
  const attentionResult = calculateAttentionScore(content, {
    inReplyTo: content.includes('>') // Simple reply detection
  });
  
  // 7. Score and cache
  scoreAndCacheMessage(channelId, { content, username, timestamp });
  
  // 8. Sync to project memory if project name known
  if (projectName) {
    syncChannelToProject(projectName, channelId, entityMap);
  }
  
  // Return enriched context
  return {
    thread: {
      id: thread.id,
      topic: thread.topic,
      isActive: thread.isActive,
      messageCount: thread.messages.length
    },
    entities: {
      people: entities.people,
      tasks: entities.tasks,
      features: entities.features,
      resolvedPronouns
    },
    currentFocus: entityMap.getCurrentFocus(),
    decision,
    timeContext,
    attention: attentionResult
  };
}

// ============================================
// FORMATTED CONTEXT OUTPUT FOR AI PROMPTS
// ============================================

function getFormattedContext(channelId, options = {}) {
  const { 
    includeThread = true, 
    includeEntities = true, 
    includeDecisions = true,
    includeTimePatterns = true,
    maxMessages = 10 
  } = options;
  
  const output = [];
  
  // Get thread context
  if (includeThread) {
    const thread = getActiveThread(channelId);
    if (thread) {
      const summary = thread.getSummary();
      output.push(`**Current Discussion Topic:** ${summary.topic || 'General'}`);
      output.push(`**Participants:** ${summary.participants.join(', ')}`);
      output.push(`**Recent Messages:**`);
      summary.recentMessages.slice(-maxMessages).forEach(m => {
        output.push(`  ${m}`);
      });
    }
  }
  
  // Get entity context
  if (includeEntities) {
    const entityMap = getEntityMap(channelId);
    const focus = entityMap.getCurrentFocus();
    
    if (focus.length > 0) {
      output.push(`\n**Currently Discussing:**`);
      focus.forEach(f => {
        output.push(`  - ${f.type}: ${f.name || f.title}`);
      });
    }
  }
  
  // Get recent decisions
  if (includeDecisions) {
    const recentDecisions = getRecentDecisions(channelId, 3);
    if (recentDecisions.length > 0) {
      output.push(`\n**Recent Decisions:**`);
      recentDecisions.forEach(d => {
        output.push(`  - ${d.what}${d.why ? ` (because: ${d.why})` : ''}`);
      });
    }
  }
  
  // Get temporal patterns
  if (includeTimePatterns) {
    const patterns = analyzeTemporalPatterns(channelId);
    if (patterns.stalenessAlerts.length > 0) {
      output.push(`\n**⚠️ Stale Tasks:**`);
      patterns.stalenessAlerts.forEach(s => {
        output.push(`  - "${s.task}" - ${s.hoursSinceActivity}h since last activity`);
      });
    }
  }
  
  return output.join('\n');
}

function getTaskContextForAI(taskId) {
  const origin = getTaskOrigin(taskId);
  if (!origin) return null;
  
  const summary = origin.getSummary();
  const lines = [];
  
  lines.push(`**Task #${taskId} Origin:**`);
  lines.push(`Created ${summary.age}`);
  
  if (summary.decision) {
    lines.push(`**Decision:** ${summary.decision.what}`);
    if (summary.decision.why) {
      lines.push(`**Reason:** ${summary.decision.why}`);
    }
    if (summary.decision.who) {
      lines.push(`**Decided by:** ${summary.decision.who}`);
    }
  }
  
  lines.push(`\n**Origin Conversation:**`);
  summary.recentMessages.forEach(m => {
    lines.push(`  ${m}`);
  });
  
  return lines.join('\n');
}

function getProjectSummary(projectName) {
  const project = getProjectMemory(projectName);
  const crossChannel = getCrossChannelContext(projectName);
  
  const lines = [];
  lines.push(`📊 **Project: ${projectName}**\n`);
  
  lines.push(`**Channels:** ${crossChannel.channels.length}`);
  crossChannel.channels.forEach(c => {
    lines.push(`  - ${c.name}`);
  });
  
  lines.push(`\n**Total Tasks:** ${crossChannel.totalTasks}`);
  lines.push(`**Task Distribution:**`);
  Object.entries(crossChannel.taskDistribution).forEach(([channel, count]) => {
    lines.push(`  - ${channel}: ${count} tasks`);
  });
  
  if (crossChannel.trendingEntities.length > 0) {
    lines.push(`\n**Trending Topics:**`);
    crossChannel.trendingEntities.forEach(e => {
      lines.push(`  - ${e.entity}: ${e.mentions} mentions across ${e.channels} channel(s)`);
    });
  }
  
  return lines.join('\n');
}

function answerContextQuery(query, channelId, projectName = null) {
  const lowerQuery = query.toLowerCase();
  
  // "What's the context on issue #X?"
  const issueMatch = query.match(/issue\s*#?(\d+)|task\s*#?(\d+)/i);
  if (issueMatch) {
    const taskId = issueMatch[1] || issueMatch[2];
    return getTaskContextForAI(taskId);
  }
  
  // "Why did we decide X?"
  if (lowerQuery.includes('why') && lowerQuery.includes('decide')) {
    const recentDecisions = getRecentDecisions(channelId, 5);
    if (recentDecisions.length > 0) {
      return recentDecisions.map(d => 
        `• ${d.what}${d.why ? ` — because ${d.why}` : ' (no reason recorded)'}`
      ).join('\n');
    }
    return "No recent decisions found.";
  }
  
  // "What's fallen through the cracks?" / "What's stale?"
  if (lowerQuery.includes('stale') || lowerQuery.includes('fallen through') || lowerQuery.includes('forgotten')) {
    const patterns = analyzeTemporalPatterns(channelId);
    if (patterns.stalenessAlerts.length > 0) {
      return patterns.stalenessAlerts.map(s =>
        `• "${s.task}" — ${s.hoursSinceActivity}h since last activity`
      ).join('\n');
    }
    return "No stale tasks found!";
  }
  
  // "What are we discussing?"
  if (lowerQuery.includes('discussing') || lowerQuery.includes('talking about')) {
    const entityMap = getEntityMap(channelId);
    const focus = entityMap.getCurrentFocus();
    const thread = getActiveThread(channelId);
    
    let response = '';
    if (thread?.topic) {
      response += `**Topic:** ${thread.topic}\n`;
    }
    if (focus.length > 0) {
      response += `**Focus:**\n`;
      focus.forEach(f => {
        response += `• ${f.type}: ${f.name || f.title}\n`;
      });
    }
    return response || "No active discussion detected.";
  }
  
  // "What's trending?"
  if (lowerQuery.includes('trending') || lowerQuery.includes('popular')) {
    if (projectName) {
      const crossChannel = getCrossChannelContext(projectName);
      if (crossChannel.trendingEntities.length > 0) {
        return crossChannel.trendingEntities.map(e =>
          `• ${e.entity}: ${e.mentions} mentions`
        ).join('\n');
      }
    }
    return "No trending topics found.";
  }
  
  // Default: return formatted context
  return getFormattedContext(channelId);
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function clearChannelContext(channelId) {
  threads.delete(channelId);
  entityMaps.delete(channelId);
  decisions.delete(channelId);
  attentionCache.delete(channelId);
}

function getContextStats(channelId) {
  const thread = getActiveThread(channelId);
  const entityMap = getEntityMap(channelId);
  const channelDecisions = decisions.get(channelId) || [];
  
  return {
    thread: thread ? {
      topic: thread.topic,
      messageCount: thread.messages.length,
      isActive: thread.isActive
    } : null,
    entities: {
      people: entityMap.people.size,
      tasks: entityMap.tasks.size,
      features: entityMap.features.size,
      focusStackSize: entityMap.focusStack.length
    },
    decisions: channelDecisions.length,
    taskOrigins: taskOrigins.size,
    confidenceEntries: confidenceTrail.length
  };
}

// ============================================
// MODULE EXPORTS
// ============================================

module.exports = {
  // Thread management
  Thread,
  getOrCreateThread,
  addMessageToThread,
  getActiveThread,
  getThreadByTaskId,
  
  // Entity resolution
  EntityMap,
  getEntityMap,
  extractEntities,
  resolvePronouns,
  
  // Decision tracking
  Decision,
  extractDecision,
  getRecentDecisions,
  recordDecision,
  
  // Temporal patterns
  analyzeTemporalPatterns,
  extractTimeContext,
  formatRelativeTime,
  
  // Task origins
  TaskOrigin,
  linkTaskToOrigin,
  getTaskOrigin,
  addMessageToTaskOrigin,
  findTaskOriginByKeyword,
  
  // Cross-channel memory
  ProjectMemory,
  getProjectMemory,
  syncChannelToProject,
  getCrossChannelContext,
  
  // Confidence trail
  ConfidenceEntry,
  recordConfidence,
  recordOutcome,
  analyzeConfidencePatterns,
  getLearnedConfidenceAdjustment,
  
  // Attention scoring
  calculateAttentionScore,
  scoreAndCacheMessage,
  getHighAttentionMessages,
  summarizeLowAttention,
  
  // Integration
  processMessage,
  getFormattedContext,
  getTaskContextForAI,
  getProjectSummary,
  answerContextQuery,
  
  // Utilities
  clearChannelContext,
  getContextStats
};