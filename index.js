require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { extractTask } = require('./services/ai');
const { createIssue } = require('./services/github');
const { addToContext, isDuplicate } = require('./services/memory');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;
  
  // Add to conversation context
  addToContext(message.channelId, message.content, message.author.username);
  
  try {
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