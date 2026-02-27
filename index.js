require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { extractTask, extractUserMappings, updateUserMappings } = require('./services/ai');
const { createIssue } = require('./services/github');
const { addToContext, isDuplicate } = require('./services/memory');
const { getProjectMeta } = require('./services/github-project');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on('clientready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  
  // Verify GitHub Project connection on startup
  try {
    const meta = await getProjectMeta();
    console.log(`✅ Connected to GitHub Project: ${meta.projectId}`);
  } catch (error) {
    console.error('⚠️  GitHub Project connection failed:', error.message);
    console.log('   Issues will still be created, but project board may not update');
  }
});

client.on('messageCreate', async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;
  
  // Add to conversation context
  addToContext(message.channelId, message.content, message.author.username);
  
  try {
    // Check for user introductions/mappings first
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
