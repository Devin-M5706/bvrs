require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { runOnboarding, checkContextNeeds, extractTask, extractUserMappings, updateUserMappings } = require('./services/ai');
const { createIssue } = require('./services/github');
const { addToContext, isDuplicate, isOnboarded } = require('./services/memory');
const { getProjectMeta } = require('./services/github-project');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  
  // Verify GitHub connection (but project may not be configured yet)
  try {
    const meta = await getProjectMeta();
    console.log(`✅ Connected to GitHub Project: ${meta.projectId}`);
  } catch (error) {
    console.log(`ℹ️  GitHub Project not yet configured - will prompt during onboarding`);
  }
});

client.on('messageCreate', async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;
  
  // Add to conversation context
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
    
    // Show ready message on first completion
    if (onboarding.reply) {
      await message.reply(onboarding.reply);
      return;
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
    
    // Extract task using AI
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