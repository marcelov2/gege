import { config } from 'dotenv';
import { Client, GatewayIntentBits, EmbedBuilder, Colors } from 'discord.js';
import axios from 'axios';

// Configuração do ambiente
config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Variáveis de ambiente
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

// Estruturas de dados
const serverConfigs = new Map(); // Substitui as variáveis únicas por servidor
let twitchAccessToken = '';

// Função para inicializar configurações dos servidores
function initializeServerConfigs() {
  if (!process.env.SERVER_CONFIGS) {
    console.error('❌ Variável SERVER_CONFIGS não encontrada no arquivo .env');
    process.exit(1);
  }

  try {
    const configs = process.env.SERVER_CONFIGS.split('|').filter(Boolean);
    
    configs.forEach(config => {
      const [serverId, channelId, users] = config.split(':');
      
      if (!serverId || !channelId || !users) {
        console.error(`⚠️ Configuração inválida: ${config}`);
        return;
      }
      
      const configKey = `${serverId.trim()}_${channelId.trim()}`;
      
      serverConfigs.set(configKey, {
        serverId: serverId.trim(),
        channelId: channelId.trim(),
        twitchUsers: users.split(',').map(u => u.trim()).filter(Boolean),
        monitoredStreams: new Map(), // Monitoramento independente para cada canal
        liveStreamers: [],
        currentStreamerIndex: 0
      });
    });

    console.log(`✅ Configurações carregadas para ${serverConfigs.size} servidor(es)`);
  } catch (error) {
    console.error('❌ Erro ao processar SERVER_CONFIGS:', error);
    process.exit(1);
  }
}

// [MANTIDAS TODAS AS SUAS FUNÇÕES ORIGINAIS, MAS ADAPTADAS PARA MULTI-SERVIDORES]

// Função para obter o token de acesso da Twitch (igual à original)
async function getTwitchAccessToken() {
  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials',
      },
    });
    twitchAccessToken = response.data.access_token;
  } catch (error) {
    console.error('Erro ao obter o token da Twitch:', error);
  }
}

// Função para verificar se um canal está ao vivo (igual à original)
async function checkStream(twitchUser) {
  try {
    const response = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${twitchUser}`, {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        Authorization: `Bearer ${twitchAccessToken}`,
      },
    });

    if (response.data.data.length > 0) {
      const userResponse = await axios.get(`https://api.twitch.tv/helix/users?login=${twitchUser}`, {
        headers: {
          'Client-ID': TWITCH_CLIENT_ID,
          Authorization: `Bearer ${twitchAccessToken}`,
        },
      });

      const profileImageUrl = userResponse.data.data[0].profile_image_url;
      return { stream: response.data.data[0], profileImageUrl };
    } else {
      return null;
    }
  } catch (error) {
    console.error('Erro ao verificar o status do stream:', error);
    return null;
  }
}

// Função para limpar o chat (igual à original, mas agora por canal)
async function clearChat(channel) {
  let messages;
  do {
    messages = await channel.messages.fetch({ limit: 100 });
    if (messages.size === 0) break;
    await channel.bulkDelete(messages).catch(error => console.error('Erro ao limpar mensagens:', error));
  } while (messages.size > 0);
}

// Função para verificar as lives (adaptada para multi-servidores)
async function checkTwitchStreams() {
  for (const [configKey, config] of serverConfigs.entries()) {
    const channel = client.channels.cache.get(config.channelId);
    if (!channel) {
      console.error(`❌ Canal não encontrado: ${config.channelId}`);
      continue;
    }

    config.liveStreamers = []; // Reset para este servidor/canal

    for (const twitchUser of config.twitchUsers) {
      const streamData = await checkStream(twitchUser);
      if (streamData && !config.monitoredStreams.has(twitchUser)) {
        const { stream, profileImageUrl } = streamData;
        const thumbnailUrl = stream.thumbnail_url.replace('{width}', '400').replace('{height}', '225') + `?time=${Date.now()}`;

        const liveEmbed = new EmbedBuilder()
          .setTitle(`${twitchUser} está ao vivo na Twitch!`)
          .setURL(`https://twitch.tv/${twitchUser}`)
          .setDescription(`**Título**: ${stream.title}\n**Jogo**: ${stream.game_name}\n**Visualizações**: ${stream.viewer_count}`)
          .setThumbnail(profileImageUrl)
          .setImage(thumbnailUrl)
          .setColor(Colors.Red)
          .setFooter({ text: 'Clique no título para assistir à live' });

        const liveMessage = await channel.send({ content: `🔴 @everyone ${twitchUser} está ao vivo!`, embeds: [liveEmbed] });
        config.monitoredStreams.set(twitchUser, { liveMessage, game: stream.game_name });
        config.liveStreamers.push({ username: twitchUser, game: stream.game_name });
        rotatePresence(config); // Passa a configuração específica
      } else if (!streamData && config.monitoredStreams.has(twitchUser)) {
        const liveMessage = config.monitoredStreams.get(twitchUser).liveMessage;
        await liveMessage.delete();
        config.monitoredStreams.delete(twitchUser);
        config.liveStreamers = config.liveStreamers.filter(s => s.username !== twitchUser);
      }
    }
  }
}

// Função para atualizar thumbnails (adaptada para multi-servidores)
async function updateThumbnails() {
  for (const [configKey, config] of serverConfigs.entries()) {
    const channel = client.channels.cache.get(config.channelId);
    if (!channel) continue;

    for (const [twitchUser, streamInfo] of config.monitoredStreams.entries()) {
      const streamData = await checkStream(twitchUser);
      if (streamData) {
        const { stream, profileImageUrl } = streamData;
        const thumbnailUrl = stream.thumbnail_url.replace('{width}', '400').replace('{height}', '225') + `?time=${Date.now()}`;

        const updatedEmbed = new EmbedBuilder()
          .setTitle(`${twitchUser} está ao vivo na Twitch!`)
          .setURL(`https://twitch.tv/${twitchUser}`)
          .setDescription(`**Título**: ${stream.title}\n**Jogo**: ${stream.game_name}\n**Visualizações**: ${stream.viewer_count}`)
          .setThumbnail(profileImageUrl)
          .setImage(thumbnailUrl)
          .setColor(Colors.Red)
          .setFooter({ text: 'Clique no título para assistir à live' });

        await streamInfo.liveMessage.edit({ embeds: [updatedEmbed] });
      }
    }
  }
}

// Função para atualizar a presença (adaptada para multi-servidores)
function rotatePresence(config) {
  if (config.liveStreamers.length > 0) {
    const streamer = config.liveStreamers[config.currentStreamerIndex];
    if (streamer) {
      client.user.setActivity(`assistindo ${streamer.username} jogar ${streamer.game}`, { type: 'WATCHING' });
      config.currentStreamerIndex = (config.currentStreamerIndex + 1) % config.liveStreamers.length;
    }
  } else {
    // Só zera a presença se nenhum servidor tiver lives
    const anyLive = Array.from(serverConfigs.values()).some(c => c.liveStreamers.length > 0);
    if (!anyLive) {
      client.user.setActivity(null);
    }
  }
}

// Função para reiniciar o bot (igual à original)
function restartBotIn12Hours() {
  let remainingTime = 12 * 60 * 60 * 1000;
  const interval = setInterval(() => {
    remainingTime -= 60 * 1000;
    const hours = Math.floor(remainingTime / (1000 * 60 * 60));
    const minutes = Math.floor((remainingTime % (1000 * 60 * 60)) / (1000 * 60));
    console.log(`Reinício em: ${hours} horas e ${minutes} minutos...`);

    if (remainingTime <= 0) {
      clearInterval(interval);
      console.log("Reiniciando o bot agora...");
      process.exit();
    }
  }, 60 * 1000);
}

// Inicialização do bot (adaptada para multi-servidores)
client.once('ready', async () => {
  console.log('Bot está online!');
  initializeServerConfigs();
  await getTwitchAccessToken();

  // Limpa o chat em todos os canais configurados
  for (const [configKey, config] of serverConfigs.entries()) {
    const channel = client.channels.cache.get(config.channelId);
    if (channel) await clearChat(channel);
  }

  // Configura os intervalos
  setInterval(checkTwitchStreams, 60 * 1000);
  setInterval(updateThumbnails, 15 * 60 * 1000);
  restartBotIn12Hours();
});

client.login(DISCORD_TOKEN);
