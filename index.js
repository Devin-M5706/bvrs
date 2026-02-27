require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { extractTask, extractUserMappings, updateUserMappings, extractJiraActions } = require('./services/ai');
const { createIssue: createGithubIssue } = require('./services/github');
const { createIssue: createJiraIssue, dispatchAction } = require('./services/jira');
const { addToContext, isDuplicate, getContext } = require('./services/memory');
const { getProjectMeta } = require('./services/github-project');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on('clientReady', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);

  // Verify GitHub Project connection
  try {
    const meta = await getProjectMeta();
    console.log(`✅ Connected to GitHub Project: ${meta.projectId}`);
  } catch (error) {
    console.error('⚠️  GitHub Project connection failed:', error.message);
    console.log('   Issues will still be created, but project board may not update');
  }

  console.log(`✅ Jira org: ${process.env.JIRA_ORG_ID} | project: ${process.env.JIRA_PROJECT_KEY}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const { channelId, content } = message;
  const authorName = message.member?.displayName ?? message.author.username;

  // Add to context BEFORE extracting so AI sees full history
  addToContext(channelId, content, authorName);

  try {
    // ── 1. User mapping (unchanged) ─────────────────────────────────────────
    const userResult = await extractUserMappings(content, channelId);
    if (userResult?.hasMappings) {
      const updated = await updateUserMappings(userResult.mappings);
      if (updated) {
        const mappings = Object.entries(userResult.mappings)
          .map(([d, g]) => `@${d} → ${g}`)
          .join('\n');
        await message.reply(`✅ Added team members:\n${mappings}`);
      }
    }

    // ── 2. New task → create in both GitHub AND Jira ─────────────────────────
    const task = await extractTask(content, channelId);
    if (task.isActionable && !isDuplicate(task.title)) {
      const [githubIssue, jiraIssue] = await Promise.allSettled([
        createGithubIssue(task),
        createJiraIssue(task),
      ]);

      const lines = [`✅ Created task: "${task.title}"`];
      if (githubIssue.status === 'fulfilled') lines.push(`🐙 GitHub: ${githubIssue.value.html_url}`);
      else console.error('GitHub issue failed:', githubIssue.reason?.message);

      if (jiraIssue.status === 'fulfilled')  lines.push(`🔵 Jira: ${jiraIssue.value.html_url}`);
      else console.error('Jira issue failed:', jiraIssue.reason?.message);

      await message.reply(lines.join('\n'));
    }

    // ── 3. Passive Jira updates (status, blockers, assignments) ─────────────
    if (typeof extractJiraActions === 'function') {
      const context = getContext(channelId);
      const actions = await extractJiraActions({
        triggerMessage: content,
        authorId: message.author.id,
        authorName,
        contextMessages: context,
      });

      for (const action of actions) {
        if (action.type === 'new_task') continue; // handled above

        try {
          const result = await dispatchAction(action, authorName);
          if (result.success) console.log(`[Jira] ${result.detail}`);
          else console.warn(`[Jira skip] ${result.detail}`);
        } catch (err) {
          console.error(`[Jira error] ${action.type} on ${action.ticketKey}:`, err.message);
        }
      }
    }

  } catch (error) {
    console.error('Error processing message:', error);
  }
});

client.login(process.env.DISCORD_TOKEN);