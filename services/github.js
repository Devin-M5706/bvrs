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

/**
 * Find an issue by searching for keywords in the title
 */
async function findIssueByTitle(keywords) {
  try {
    // Build search query
    const query = `${keywords} repo:${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO} is:issue is:open`;
    
    const response = await octokit.search.issuesAndPullRequests({
      q: query,
      per_page: 5
    });
    
    if (response.data.items.length === 0) {
      return null;
    }
    
    // Return the best match (first result)
    return response.data.items[0];
  } catch (error) {
    console.error('Error searching issues:', error.message);
    return null;
  }
}

/**
 * Update an issue's status (via labels and project board)
 */
async function updateIssueStatus(issueNumber, status) {
  const statusLabels = {
    'in_progress': 'in-progress',
    'blocked': 'blocked',
    'done': 'done',
    'cancelled': 'cancelled'
  };
  
  try {
    // Add status label
    const labelToAdd = statusLabels[status];
    if (labelToAdd) {
      await octokit.issues.addLabels({
        owner: process.env.GITHUB_OWNER,
        repo: process.env.GITHUB_REPO,
        issue_number: issueNumber,
        labels: [labelToAdd]
      });
    }
    
    // Update project board status
    const { getProjectMeta, updateProjectField } = require('./github-project');
    const { projectId, fields } = await getProjectMeta();
    
    // Find the issue node ID
    const issue = await octokit.issues.get({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      issue_number: issueNumber
    });
    
    // Note: Project status update would need the item ID
    // For now, we just update labels
    
    console.log(`✅ Updated issue #${issueNumber} status to ${status}`);
    return true;
  } catch (error) {
    console.error('Error updating issue status:', error.message);
    return false;
  }
}

/**
 * Close an issue with an optional comment
 */
async function closeIssue(issueNumber, comment = null) {
  try {
    // Add closing comment if provided
    if (comment) {
      await octokit.issues.createComment({
        owner: process.env.GITHUB_OWNER,
        repo: process.env.GITHUB_REPO,
        issue_number: issueNumber,
        body: comment
      });
    }
    
    // Close the issue
    await octokit.issues.update({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      issue_number: issueNumber,
      state: 'closed'
    });
    
    console.log(`✅ Closed issue #${issueNumber}`);
    return true;
  } catch (error) {
    console.error('Error closing issue:', error.message);
    return false;
  }
}

/**
 * Reassign an issue to a different user
 */
async function reassignIssue(issueNumber, githubUsername) {
  try {
    await octokit.issues.addAssignees({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      issue_number: issueNumber,
      assignees: [githubUsername]
    });
    
    console.log(`✅ Reassigned issue #${issueNumber} to ${githubUsername}`);
    return true;
  } catch (error) {
    console.error('Error reassigning issue:', error.message);
    return false;
  }
}

/**
 * Update an issue's priority
 */
async function updateIssuePriority(issueNumber, priority) {
  try {
    // Remove old priority labels and add new one
    const issue = await octokit.issues.get({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      issue_number: issueNumber
    });
    
    const currentLabels = issue.data.labels.map(l => l.name);
    const priorityLabels = ['high', 'medium', 'low'];
    const labelsToRemove = currentLabels.filter(l => priorityLabels.includes(l));
    
    // Remove old priority labels
    for (const label of labelsToRemove) {
      await octokit.issues.removeLabel({
        owner: process.env.GITHUB_OWNER,
        repo: process.env.GITHUB_REPO,
        issue_number: issueNumber,
        name: label
      });
    }
    
    // Add new priority label
    await octokit.issues.addLabels({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      issue_number: issueNumber,
      labels: [priority]
    });
    
    console.log(`✅ Updated issue #${issueNumber} priority to ${priority}`);
    return true;
  } catch (error) {
    console.error('Error updating priority:', error.message);
    return false;
  }
}

/**
 * Add a comment to an issue
 */
async function addIssueComment(issueNumber, comment) {
  try {
    await octokit.issues.createComment({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      issue_number: issueNumber,
      body: comment
    });
    
    console.log(`✅ Added comment to issue #${issueNumber}`);
    return true;
  } catch (error) {
    console.error('Error adding comment:', error.message);
    return false;
  }
}

module.exports = { 
  createIssue,
  findIssueByTitle,
  updateIssueStatus,
  closeIssue,
  reassignIssue,
  updateIssuePriority,
  addIssueComment,
  ensureLabelsExist
};