// services/jira.js
// Drop-in replacement for github.js — same createIssue(task) signature

const JIRA_BASE_URL = `https://api.atlassian.com/ex/jira/${process.env.JIRA_ORG_ID}/rest/api/3`;
const JIRA_EMAIL    = process.env.JIRA_EMAIL;
const JIRA_API_KEY  = process.env.JIRA_API_KEY?.trim();
const PROJECT_KEY   = process.env.JIRA_PROJECT_KEY;

const headers = {
  Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_KEY}`).toString('base64')}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

async function jiraFetch(path, options = {}) {
  const res = await fetch(`${JIRA_BASE_URL}${path}`, { headers, ...options });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira [${res.status}] ${path}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

function toADF(text) {
  return {
    type: 'doc', version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: text || '' }] }],
  };
}

// ─── User cache: discord username → jira accountId ───────────────────────────
const userCache = new Map();

async function resolveAssignee(discordUsername) {
  if (!discordUsername) return null;
  if (userCache.has(discordUsername)) return userCache.get(discordUsername);
  try {
    const results = await jiraFetch(
      `/user/search?query=${encodeURIComponent(discordUsername)}&maxResults=1`
    );
    if (results?.length) {
      userCache.set(discordUsername, results[0].accountId);
      return results[0].accountId;
    }
  } catch { /* no match — skip assignee */ }
  return null;
}

// ─── Core: createIssue ────────────────────────────────────────────────────────
// Accepts the same `task` shape that extractTask() returns:
// { title, description, priority, assignee, labels, isActionable }
async function createIssue(task) {
  const assigneeId = await resolveAssignee(task.assignee);

  const priorityMap = {
    high: 'High', medium: 'Medium', low: 'Low', urgent: 'Highest',
  };

  const body = {
    fields: {
      project:     { key: PROJECT_KEY },
      summary:     task.title,
      issuetype:   { name: task.issueType || 'Task' },
      description: toADF(task.description || ''),
      priority:    { name: priorityMap[task.priority?.toLowerCase()] || 'Medium' },
      ...(assigneeId && { assignee: { id: assigneeId } }),
      ...(task.labels?.length && { labels: task.labels }),
    },
  };

  const data = await jiraFetch('/issue', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  // Return shape similar to GitHub's issue response
  return {
    key:      data.key,
    html_url: `https://your-org.atlassian.net/browse/${data.key}`,
    id:       data.id,
  };
}

// ─── Passive update dispatcher ────────────────────────────────────────────────
async function dispatchAction(action, authorName) {
  switch (action.type) {
    case 'status_update': {
      if (!action.ticketKey) return { success: false, detail: 'No ticket key' };
      await updateStatus(action.ticketKey, action.newStatus);
      await addComment(action.ticketKey,
        `[Bot] Status → "${action.newStatus}" via Discord (${authorName})\n${action.reasoning}`);
      return { success: true, detail: `${action.ticketKey} → ${action.newStatus}` };
    }
    case 'new_task': {
      const issue = await createIssue({
        title: action.summary,
        description: `${action.description || ''}\n\n[Bot] Auto-created from Discord — ${action.reasoning}`,
        assignee: authorName,
      });
      return { success: true, detail: `Created ${issue.key} → ${issue.html_url}` };
    }
    case 'blocker': {
      if (!action.ticketKey) return { success: false, detail: 'No ticket key' };
      await updateStatus(action.ticketKey, 'Blocked');
      await addComment(action.ticketKey,
        `[Bot] Blocker flagged by ${authorName}: ${action.blockerDescription}`);
      return { success: true, detail: `${action.ticketKey} → Blocked` };
    }
    case 'assignment': {
      if (!action.ticketKey) return { success: false, detail: 'No ticket key' };
      const accountId = await resolveAssignee(authorName);
      if (!accountId) return { success: false, detail: `Can't resolve Jira user for ${authorName}` };
      await jiraFetch(`/issue/${action.ticketKey}/assignee`, {
        method: 'PUT',
        body: JSON.stringify({ accountId }),
      });
      await addComment(action.ticketKey, `[Bot] Assigned to ${authorName} via Discord.`);
      return { success: true, detail: `${action.ticketKey} assigned to ${authorName}` };
    }
    default:
      return { success: false, detail: `Unknown action: ${action.type}` };
  }
}

async function updateStatus(issueKey, targetStatus) {
  const { transitions } = await jiraFetch(`/issue/${issueKey}/transitions`);
  const match = transitions.find(
    t => t.name.toLowerCase() === targetStatus.toLowerCase()
  );
  if (!match) throw new Error(
    `No transition "${targetStatus}" for ${issueKey}. Available: ${transitions.map(t => t.name).join(', ')}`
  );
  await jiraFetch(`/issue/${issueKey}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: match.id } }),
  });
}

async function addComment(issueKey, text) {
  await jiraFetch(`/issue/${issueKey}/comment`, {
    method: 'POST',
    body: JSON.stringify({ body: toADF(text) }),
  });
}

module.exports = { createIssue, dispatchAction, updateStatus, addComment, resolveAssignee };