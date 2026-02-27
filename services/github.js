const { Octokit } = require('@octokit/rest');

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

async function createIssue(task) {
  const body = `## Description
${task.description}

---
**Priority:** ${task.priority}
${task.assignee ? `**Assignee:** @${task.assignee}` : ''}

*Created by Discord Task Bot*`;

  try {
    const response = await octokit.issues.create({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      title: task.title,
      body: body,
      labels: [task.priority, 'discord-bot']
    });
    
    console.log(`✅ Created issue #${response.data.number}: ${task.title}`);
    return response.data;
  } catch (error) {
    console.error('GitHub API error:', error);
    throw error;
  }
}

module.exports = { createIssue };