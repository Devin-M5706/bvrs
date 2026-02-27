require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { runOnboarding, checkContextNeeds, extractTask, extractUserMappings, updateUserMappings, detectTaskUpdate } = require('./services/ai');
const { createIssue, findIssueByTitle, updateIssueStatus, closeIssue, reassignIssue, updateIssuePriority, addIssueComment } = require('./services/github');
const { addToContext, isDuplicate, isOnboarded } = require('./services/memory');
const { getProjectMeta, mapAssignee } = require('./services/github-project');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  
  try {
    const meta = await getProjectMeta();
    console.log(`✅ Connected to GitHub Project: ${meta.projectId}`);
  } catch (error) {
    console.log(`ℹ️  GitHub Project not yet configured - will prompt during onboarding`);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  addToContext(message.channelId, message.content, message.author.username);
  
  try {
    // Run onboarding flow if not complete
    const onboarding = await runOnboarding(message.content, message.channelId);
    if (!onboarding.complete) {
      if (onboarding.reply) {
        await message.reply(onboarding.reply);
      }
      return;
    }
    
    if (onboarding.reply) {
      await message.reply(onboarding.reply);
      return;
    }
    
    // Check for task updates FIRST (before extracting new tasks)
    const taskUpdate = await detectTaskUpdate(message.content, message.channelId);
    
    if (taskUpdate.isUpdate && taskUpdate.confidence !== 'low') {
      // Find the issue by title/keywords
      const issue = await findIssueByTitle(taskUpdate.taskReference);
      
      if (issue) {
        let reply = '';
        
        // Handle different update types
        if (taskUpdate.newStatus === 'done' || taskUpdate.newStatus === 'cancelled') {
          const closed = await closeIssue(issue.number, `Closed via Discord: ${message.content}`);
          if (closed) {
            reply = `✅ ${taskUpdate.newStatus === 'done' ? 'Completed' : 'Cancelled'} task: "${issue.title}"\n🔗 ${issue.html_url}`;
          }
        } else if (taskUpdate.newStatus) {
          const updated = await updateIssueStatus(issue.number, taskUpdate.newStatus);
          if (updated) {
            const statusEmoji = { in_progress: '🔄', blocked: '🚫' };
            reply = `${statusEmoji[taskUpdate.newStatus] || '📝'} Updated "${issue.title}" to ${taskUpdate.newStatus.replace('_', ' ')}\n🔗 ${issue.html_url}`;
          }
        }
        
        if (taskUpdate.newPriority) {
          await updateIssuePriority(issue.number, taskUpdate.newPriority);
          reply += `\n⚡ Priority set to ${taskUpdate.newPriority}`;
        }
        
        if (taskUpdate.newAssignee) {
          const githubUser = mapAssignee(taskUpdate.newAssignee);
          if (githubUser) {
            await reassignIssue(issue.number, githubUser);
            reply += `\n👤 Assigned to ${taskUpdate.newAssignee}`;
          }
        }
        
        if (reply) {
          await message.reply(reply);
          return;
        }
      } else {
        // Couldn't find the issue
        if (taskUpdate.confidence === 'high') {
          await message.reply(`⚠️ I couldn't find a task matching "${taskUpdate.taskReference}". Try being more specific or use the issue number.`);
        }
      }
    }
    
    // Check for new user mappings
    const userResult = await extractUserMappings(message.content, message.channelId);
    if (userResult.hasMappings) {
      const updated = await updateUserMappings(userResult.mappings);
      if (updated) {
        const mappings = Object.entries(userResult.mappings)
          .map(([d, g]) => `@${d} → ${g}`)
          .join('\n');
        await message.reply(`✅ Added team members:\n${mappings}`);
      }
    }
    
    // Update context from conversation
    await checkContextNeeds(message.content, message.channelId);
    
    // Extract new tasks using AI
    const task = await extractTask(message.content, message.channelId);
    
    if (task.isActionable && !isDuplicate(task.title)) {
      const issue = await createIssue(task);
      await message.reply(`✅ Created task: "${task.title}"\n🔗 ${issue.html_url}`);
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
});

client.login(process.env.DISCORD_TOKEN);