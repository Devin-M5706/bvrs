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

// Activity logger - posts a log message for bot actions
async function logActivity(channel, action, details) {
  const timestamp = new Date().toLocaleTimeString();
  const logMessage = `📝 **[${timestamp}]** ${action}\n${details}`;
  console.log(`[LOG] ${action}: ${details}`);
  
  // Try to send to the same channel (could also use a dedicated log channel)
  if (channel && channel.send) {
    try {
      await channel.send(logMessage);
    } catch (err) {
      console.error('Failed to send log:', err.message);
    }
  }
}

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
        await logActivity(message.channel, 'Onboarding Progress', onboarding.reply.split('\n')[0]);
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
      await logActivity(message.channel, '🔍 Detecting Task Update', `Looking for: "${taskUpdate.taskReference}"`);
      
      // Find the issue by title/keywords
      const issue = await findIssueByTitle(taskUpdate.taskReference);
      
      if (issue) {
        let reply = '';
        let actions = [];
        
        // Handle different update types
        if (taskUpdate.newStatus === 'done' || taskUpdate.newStatus === 'cancelled') {
          const closed = await closeIssue(issue.number, `Closed via Discord: ${message.content}`);
          if (closed) {
            reply = `✅ ${taskUpdate.newStatus === 'done' ? 'Completed' : 'Cancelled'} task: "${issue.title}"\n🔗 ${issue.html_url}`;
            actions.push(`Status → ${taskUpdate.newStatus}`);
          }
        } else if (taskUpdate.newStatus) {
          const updated = await updateIssueStatus(issue.number, taskUpdate.newStatus);
          if (updated) {
            const statusEmoji = { in_progress: '🔄', blocked: '🚫' };
            reply = `${statusEmoji[taskUpdate.newStatus] || '📝'} Updated "${issue.title}" to ${taskUpdate.newStatus.replace('_', ' ')}\n🔗 ${issue.html_url}`;
            actions.push(`Status → ${taskUpdate.newStatus}`);
          }
        }
        
        if (taskUpdate.newPriority) {
          await updateIssuePriority(issue.number, taskUpdate.newPriority);
          reply += `\n⚡ Priority set to ${taskUpdate.newPriority}`;
          actions.push(`Priority → ${taskUpdate.newPriority}`);
        }
        
        if (taskUpdate.newAssignee) {
          const githubUser = mapAssignee(taskUpdate.newAssignee);
          if (githubUser) {
            await reassignIssue(issue.number, githubUser);
            reply += `\n👤 Assigned to ${taskUpdate.newAssignee}`;
            actions.push(`Assignee → ${taskUpdate.newAssignee}`);
          }
        }
        
        if (reply) {
          await message.reply(reply);
          await logActivity(message.channel, '✅ Task Updated', `"${issue.title}"\n${actions.join(' | ')}`);
          return;
        }
      } else {
        // Couldn't find the issue
        if (taskUpdate.confidence === 'high') {
          await message.reply(`⚠️ I couldn't find a task matching "${taskUpdate.taskReference}". Try being more specific or use the issue number.`);
          await logActivity(message.channel, '⚠️ Task Not Found', `Searched for: "${taskUpdate.taskReference}"`);
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
        await logActivity(message.channel, '👥 Team Updated', mappings);
      }
    }
    
    // Update context from conversation
    await checkContextNeeds(message.content, message.channelId);
    
    // Extract new tasks using AI
    const task = await extractTask(message.content, message.channelId);
    
    if (task.isActionable) {
      // Handle low confidence - ask for clarification
      if (task.confidence === 'low') {
        await logActivity(message.channel, '🤔 Low Confidence Detection', `Possible task: "${task.title || 'unclear'}"`);
        
        let reply = `🤔 **I think this might be a task, but I need clarification:**\n\n`;
        
        if (task.clarityQuestions && task.clarityQuestions.length > 0) {
          reply += task.clarityQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n');
        } else {
          reply += `• What exactly needs to be done?\n• Who should be assigned?\n• What's the priority?`;
        }
        
        reply += `\n\n_Reply with more details or say "create it" to proceed anyway._`;
        await message.reply(reply);
        return;
      }
      
      // Handle medium confidence - ask for confirmation
      if (task.confidence === 'medium') {
        await logActivity(message.channel, '🤔 Medium Confidence Detection', `Possible task: "${task.title}"`);
        
        let reply = `📝 **I think this is a task. Is this correct?**\n\n`;
        reply += `**${task.title}**\n`;
        reply += `Priority: ${task.priority}\n`;
        if (task.assignee) reply += `Assignee: @${task.assignee}\n`;
        
        if (task.clarityQuestions && task.clarityQuestions.length > 0) {
          reply += `\n**Questions:**\n`;
          reply += task.clarityQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n');
        }
        
        reply += `\n\n_React with ✅ to create, or provide more details._`;
        
        const confirmationMsg = await message.reply(reply);
        await confirmationMsg.react('✅');
        await confirmationMsg.react('❌');
        return;
      }
      
      // High confidence - create the task
      if (task.confidence === 'high' && !isDuplicate(task.title)) {
        await logActivity(message.channel, '📋 Creating Task', `"${task.title}" | Priority: ${task.priority} | Assignee: ${task.assignee || 'unassigned'}`);
        
        const issue = await createIssue(task);
        
        let reply = `✅ Created task: "${task.title}"\n🔗 ${issue.html_url}`;
        
        // Show captured implicit signals
        if (task.implicitSignals) {
          const capturedSignals = [];
          if (task.implicitSignals.blockers) capturedSignals.push(`Blockers: ${task.implicitSignals.blockers.join(', ')}`);
          if (task.implicitSignals.urgencyReason) capturedSignals.push(`Why urgent: ${task.implicitSignals.urgencyReason}`);
          if (task.implicitSignals.businessImpact) capturedSignals.push(`Impact: ${task.implicitSignals.businessImpact}`);
          
          if (capturedSignals.length > 0) {
            reply += `\n\n📌 **Captured context:**\n${capturedSignals.map(s => `• ${s}`).join('\n')}`;
          }
        }
        
        await message.reply(reply);
        await logActivity(message.channel, '✅ Task Created', `#${issue.number}: "${task.title}"`);
      }
    }
  } catch (error) {
    console.error('Error processing message:', error);
    await logActivity(message.channel, '❌ Error', error.message);
  }
});

client.login(process.env.DISCORD_TOKEN);