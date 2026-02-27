const { Octokit } = require('@octokit/rest');
const { addIssueToProject, mapAssignee } = require('./github-project');

const octokit = new Octokit({ 
  auth: process.env.GITHUB_TOKEN 
});

// Labels to ensure exist
const REQUIRED_LABELS = [
  { name: 'high', color: 'ff0000', description: 'High priority tasks' },
  { name: 'medium', color: 'ff9900', description: 'Medium priority tasks' },
  { name: 'low', color: '00ff00', description: 'Low priority tasks' },
  { name: 'discord-bot', color: '5865F2', description: 'Created via Discord bot' }
];

// Track if labels have been ensured
let labelsEnsured = false;

/**
 * Ensure required labels exist in the repo
 */
async function ensureLabelsExist() {
  if (labelsEnsured) return;
  
  for (const label of REQUIRED_LABELS) {
    try {
      await octokit.issues.createLabel({
        owner: process.env.GITHUB_OWNER,
        repo: process.env.GITHUB_REPO,
        ...label
      });
      console.log(`✅ Created label: ${label.name}`);
    } catch (error) {
      if (error.status !== 422) { // 422 = already exists
        console.error(`Error creating label ${label.name}:`, error.message);
      }
    }
  }
  
  labelsEnsured = true;
}

async function createIssue(task) {
  // Ensure labels exist before creating issue
  await ensureLabelsExist();

  const githubAssignee = mapAssignee(task.assignee);

  const body = `## Description
${task.description}

---
**Priority:** ${task.priority}
${task.assignee ? `**Discord mention:** @${task.assignee}` : ''}
${githubAssignee ? `**GitHub Assignee:** @${githubAssignee}` : ''}

*Created by Discord Task Bot*`;

  try {
    const response = await octokit.issues.create({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      title: task.title,
      body: body,
      labels: [task.priority, 'discord-bot'],
      assignees: githubAssignee ? [githubAssignee] : []
    });
    
    console.log(`✅ Created issue #${response.data.number}: ${task.title}`);

    // Add to GitHub Project V2 board
    if (response.data.node_id) {
      await addIssueToProject(response.data.node_id, task.priority);
    }

    return response.data;
  } catch (error) {
    console.error('GitHub API error:', error);
    throw error;
  }
}

module.exports = { createIssue };