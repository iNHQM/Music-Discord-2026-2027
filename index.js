'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, Events } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, entersState, VoiceConnectionStatus, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, NoSubscriberBehavior } = require('@discordjs/voice');
const configPath = path.join(__dirname, 'config.json');
// Resolve executables relative to this project, never relative to CMD's working directory.
// Set YTDLP_PATH / FFMPEG_PATH if you keep them somewhere else.
function resolveExecutable(filename, envName, command) {
  const local = path.join(__dirname, 'bin', filename);
  if (fs.existsSync(local)) return local;
  const override = process.env[envName];
  if (override) return path.resolve(override);
  return command; // available on PATH, otherwise a friendly ENOENT error below
}
const ytDlpBin = resolveExecutable(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp', 'YTDLP_PATH', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const ffmpegBin = resolveExecutable(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', 'FFMPEG_PATH', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
function assertTool(bin, tool) {
  const check = spawnSync(bin, [tool === 'yt-dlp' ? '--version' : '-version'], { windowsHide: true, timeout: 12000, stdio: 'ignore' });
  if (check.error) throw toolError(check.error, tool, bin);
  if (check.status !== 0) throw new Error(`${tool} could not start: ${bin}`);
}
function spawnTool(bin, args, options = {}) {
  const child = spawn(bin, args, { windowsHide: true, ...options });
  return child;
}
function toolError(err, tool, bin) {
  if (err.code === 'ENOENT') return new Error(`${tool} executable not found. Put ${process.platform === 'win32' ? tool + '.exe' : tool} in the project's bin folder or set its PATH. Tried: ${bin}`);
  return err;
}

if (!fs.existsSync(configPath)) { console.error('Copy config.example.json to config.json and fill in your bot tokens and channel IDs.'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!cfg.ServerId || !Array.isArray(cfg.bots) || !cfg.bots.length) throw new Error('Set ServerId and bots in config.json');
const states = cfg.bots.map((b, i) => ({ id: i, config: b, client: null, connection: null, player: null, queue: [], current: null, panel: null, ffmpeg: null, searchProc: null, busy: false, repeat: false, volume: Math.min(100, Math.max(0, Number(b.volume ?? 50))), started: false, stopping: false, reconnectTimer: null, status: 'Offline', emojis: {} }));
const icon = (name) => path.join(__dirname, 'assets', name);
const iconAttachment = (file, name) => new AttachmentBuilder(icon(file), { name });
const duration = (s) => { s = Math.max(0, Math.floor(Number(s) || 0)); return `${Math.floor(s / 60).toString().padStart(2,'0')}:${(s % 60).toString().padStart(2,'0')}`; };
const limit = (str, n = 180) => String(str || '').slice(0, n);
const emojiFiles = {
  repeat: ['nhqm_repeat', 'Repeat.png'],
  down: ['nhqm_volume_down', 'Volume Down.png'],
  pause: ['nhqm_pause', 'stop.png'],
  up: ['nhqm_volume_up', 'Volume Up.png'],
  skip: ['nhqm_skip', 'Skip.png']
};
const fallbackEmojis = { repeat: '🔁', down: '🔉', pause: '⏸️', up: '🔊', skip: '⏭️' };
// Custom button images must be uploaded as Discord server emojis first.
// If the bot lacks Manage Expressions permission, fallback Unicode emojis are used.
let emojiInitPromise;
async function initializeEmojis(client) {
  if (emojiInitPromise) return emojiInitPromise;
  emojiInitPromise = (async () => {
    const guild = await client.guilds.fetch(cfg.ServerId);
    const existing = await guild.emojis.fetch();
    const result = {};
    for (const [key, [name, file]] of Object.entries(emojiFiles)) {
      let emoji = existing.find(e => e.name === name);
      if (!emoji) {
        try {
          emoji = await guild.emojis.create({ attachment: icon(file), name, reason: 'NHQM Music player controls' });
        } catch (e) { console.warn(`[EMOJI] ${name}: ${e.message}. Using fallback.`); }
      }
      if (emoji) result[key] = { id: emoji.id, name: emoji.name };
    }
    return result;
  })().catch(err => { console.warn('[EMOJI] ' + err.message); return {}; });
  return emojiInitPromise;
}
function panelRow(s) {
  const buttons = [
    ['repeat', s.repeat ? ButtonStyle.Primary : ButtonStyle.Secondary],
    ['down', ButtonStyle.Secondary],
    ['pause', ButtonStyle.Secondary],
    ['up', ButtonStyle.Secondary],
    ['skip', ButtonStyle.Secondary]
  ];
  return new ActionRowBuilder().addComponents(buttons.map(([cmd, style]) =>
    new ButtonBuilder().setCustomId(`music:${s.id}:${cmd}`)
      .setEmoji(s.emojis[cmd] || fallbackEmojis[cmd]).setStyle(style)
  ));
}
function songEmbed(s, searching) {
  const e = new EmbedBuilder().setColor(searching ? 0xffffff : 0x292064).setThumbnail('attachment://music.png');
  if (searching) e.addFields({ name: 'Searching Song', value: `🔎 **${limit(searching.query)}**\nSearching YouTube, please wait...` });
  else if (s.current) e.addFields({ name: 'Playing Song', value: limit(s.current.title, 1000) }, { name: 'Song Duration', value: duration(s.current.duration) });
  else e.setDescription('**Nothing is playing right now.**\nType `ش song name` to play a track.');
  const requester = searching ? searching.requester : s.current?.requester;
  if (requester) e.setFooter({ text: limit(requester.name, 120), iconURL: requester.avatar || undefined });
  return e;
}
async function updatePanel(s, searching = null) {
  if (!s.client?.isReady()) return;
  const ch = await s.client.channels.fetch(s.config.textChannelId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const voice = await s.client.channels.fetch(s.config.voiceChannelId).catch(() => null);
  const payload = { content: `🔊 **${voice?.name || 'Voice Channel'}**`, embeds: [songEmbed(s, searching)], components: [panelRow(s)], files: [iconAttachment('Emo.png', 'music.png')] };
  try {
    if (s.panel) {
      // Editing attachments needs an explicit reset to avoid duplicate attachment names.
      await s.panel.edit({ ...payload, attachments: [] });
    } else s.panel = await ch.send(payload);
  } catch (err) {
    console.error(`[${s.config.name}] panel: ${err.message}`);
    s.panel = await ch.send(payload).catch(() => null);
  }
}
function execJson(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const p = spawnTool(ytDlpBin, args);
    let out = '', err = '';
    let settled = false; const fail = (e) => { if (!settled) { settled = true; reject(e); } }; const timer = setTimeout(() => { p.kill(); fail(new Error('yt-dlp timed out')); }, timeout);
    p.stdout.on('data', d => { out += d; if (out.length > 4000000) p.kill(); });
    p.stderr.on('data', d => { err += d.toString().slice(-1000); });
    p.on('error', e => { clearTimeout(timer); fail(toolError(e, 'yt-dlp', ytDlpBin)); });
    p.on('close', code => { clearTimeout(timer); if (settled) return; if (code !== 0) return fail(new Error(limit(err, 300) || `yt-dlp exited ${code}`)); try { settled = true; resolve(JSON.parse(out)); } catch { fail(new Error('Invalid yt-dlp output')); } });
  });
}
async function findSong(query, requester) {
  const url = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;
  assertTool(ytDlpBin, 'yt-dlp');
  const result = await execJson(['--no-playlist', '--dump-single-json', '--skip-download', '--no-warnings', url]);
  const item = result.entries?.[0] || result;
  if (!item?.webpage_url && !item?.original_url) throw new Error('No matching song');
  return { title: item.title || query, duration: item.duration || 0, url: item.webpage_url || item.original_url, requester };
}
function cleanupAudio(s) {
  if (s.ffmpeg) { const p = s.ffmpeg; s.ffmpeg = null; p.kill(); }
}
async function playNext(s) {
  if (!s.started || s.busy) return;
  const next = s.queue.shift();
  if (!next) { s.current = null; s.status = 'Idle'; if (s.panel) await updatePanel(s); return; }
  s.busy = true;
  s.current = next;
  s.status = `Loading: ${limit(next.title, 50)}`;
  if (s.panel) await updatePanel(s);
  try {
    // Refresh a stream URL immediately before playing; yt-dlp URLs may expire.
    assertTool(ytDlpBin, 'yt-dlp');
    assertTool(ffmpegBin, 'ffmpeg');
    const streamUrl = await new Promise((resolve, reject) => {
      const p = spawnTool(ytDlpBin, ['--no-playlist', '-f', 'bestaudio/best', '-g', '--no-warnings', next.url]);
      let output = '', error = '';
      const t = setTimeout(() => { p.kill(); reject(new Error('Stream URL timeout')); }, 45000);
      p.stdout.on('data', d => output += d.toString());
      p.stderr.on('data', d => error += d.toString().slice(-300));
      p.on('error', e => { clearTimeout(t); reject(toolError(e, 'yt-dlp', ytDlpBin)); });
      p.on('close', c => { clearTimeout(t); c === 0 && output.trim() ? resolve(output.trim().split(/\r?\n/)[0]) : reject(new Error(error || 'Stream not available')); });
    });
    if (!s.started || s.current !== next) return;
    cleanupAudio(s);
    const ff = spawnTool(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', streamUrl, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    s.ffmpeg = ff;
    ff.on('error', e => { const msg = toolError(e, 'ffmpeg', ffmpegBin).message; console.error(`[${s.config.name}] ffmpeg: ${msg}`); s.status = `Error: ${limit(msg, 80)}`; s.player?.stop(true); });
    ff.stderr.on('data', d => console.error(`[${s.config.name}] ${limit(d, 200)}`));
    const resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume.setVolume(s.volume / 100);
    s.player.play(resource);
    s.status = `Playing: ${limit(next.title, 50)}`;
    if (s.panel) await updatePanel(s);
  } catch (err) { console.error(`[${s.config.name}] playback: ${err.message}`); s.status = `Error: ${limit(err.message, 80)}`; s.current = null; }
  finally { s.busy = false; if (!s.current && s.started) setImmediate(() => playNext(s)); }
}
function skip(s) { const old = s.current; s.current = null; cleanupAudio(s); s.player?.stop(true); if (!old) playNext(s); }
async function ensureVoice(s) {
  if (!s.started || !s.client?.isReady() || s.stopping) return;
  const guild = await s.client.guilds.fetch(cfg.ServerId).catch(() => null);
  if (!guild) { s.status = 'Server not found'; return; }
  const ch = await guild.channels.fetch(s.config.voiceChannelId).catch(() => null);
  if (!ch?.isVoiceBased()) { s.status = 'Voice channel not found'; return; }
  if (s.connection && s.connection.state.status !== VoiceConnectionStatus.Destroyed) return;
  const conn = joinVoiceChannel({ channelId: ch.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
  s.connection = conn;
  conn.subscribe(s.player);
  conn.on('stateChange', (_, now) => {
    if (now.status === VoiceConnectionStatus.Destroyed || now.status === VoiceConnectionStatus.Disconnected) {
      if (s.connection === conn) s.connection = null;
      if (s.started && !s.stopping) { clearTimeout(s.reconnectTimer); s.reconnectTimer = setTimeout(() => { try { conn.destroy(); } catch {} ensureVoice(s); }, 5000); }
    }
  });
  try { await entersState(conn, VoiceConnectionStatus.Ready, 20000); s.status = 'Connected / Idle'; }
  catch { s.status = 'Voice connection pending'; }
}
function canControl(s, member) { return member?.voice?.channelId === s.config.voiceChannelId; }
async function voiceError(target, s) {
  const ch = await s.client.channels.fetch(s.config.voiceChannelId).catch(() => null);
  const e = new EmbedBuilder().setColor(0x29195d).setDescription(`*You must be listening in* **${ch?.name || 'the assigned voice channel'}** to control this player.`).setThumbnail('attachment://error.png');
  const data = { embeds: [e], files: [iconAttachment('Errors.png', 'error.png')] };
  if (target.isButton?.()) return target.reply({ ...data, ephemeral: true });
  return target.reply(data);
}
async function control(s, cmd) {
  if (cmd === 'repeat') s.repeat = !s.repeat;
  if (cmd === 'down') s.volume = Math.max(0, s.volume - 10);
  if (cmd === 'up') s.volume = Math.min(100, s.volume + 10);
  if (['down','up'].includes(cmd)) s.player?.state?.resource?.volume?.setVolume(s.volume / 100);
  if (cmd === 'pause') { if (s.player.state.status === AudioPlayerStatus.Paused) s.player.unpause(); else if (s.player.state.status === AudioPlayerStatus.Playing) s.player.pause(); }
  if (cmd === 'skip') skip(s);
  if (s.panel) await updatePanel(s);
}
// Public action embeds: visible to everyone in the configured text channel.
const actionImages = {
  repeat: 'Repeat.png', down: 'Volume Down.png', up: 'Volume Up.png',
  pause: 'stop.png', skip: 'Skip.png'
};
async function sendControlEmbed(s, cmd, interaction = null) {
  const channel = await s.client.channels.fetch(s.config.textChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const voice = await s.client.channels.fetch(s.config.voiceChannelId).catch(() => null);
  const paused = s.player?.state?.status === AudioPlayerStatus.Paused;
  const messages = {
    repeat: `Repeat: **${s.repeat ? 'ON' : 'OFF'}**`,
    down: `Volume decreased to **${s.volume}%**`,
    up: `Volume increased to **${s.volume}%**`,
    pause: paused ? '**Music Paused**' : '**Music Resumed**',
    skip: '**Song Skipped**'
  };
  const file = actionImages[cmd];
  if (!file) return;
  const embed = new EmbedBuilder()
    .setColor(0x343434)
    .setDescription(messages[cmd])
    .setThumbnail('attachment://action.png');
  const payload = {
    content: `🔊 **${voice?.name || 'Voice Channel'}**`,
    embeds: [embed],
    files: [iconAttachment(file, 'action.png')]
  };
  // A non-ephemeral follow-up is public even though the button was acknowledged via deferUpdate.
  if (interaction) return interaction.followUp({ ...payload, ephemeral: false });
  return channel.send(payload);
}

async function startBot(s) {
  if (s.started) return;
  if (!s.config.token || s.config.token.includes('BOT_')) throw new Error(`Missing token for ${s.config.name}`);
  s.stopping = false; s.started = true; s.status = 'Connecting...';
  s.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  s.player.on(AudioPlayerStatus.Idle, () => {
    cleanupAudio(s);
    if (s.current && s.repeat && s.started) s.queue.unshift(s.current);
    s.current = null;
    if (!s.busy) playNext(s);
  });
  s.player.on('error', err => { console.error(`[${s.config.name}] player: ${err.message}`); skip(s); });
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates] });
  s.client = client;
  client.once(Events.ClientReady, async () => { s.status = 'Online'; s.emojis = await initializeEmojis(client); await ensureVoice(s); console.log(`[READY] ${s.config.name} -> ${s.config.voiceChannelId}`); });
  client.on(Events.MessageCreate, async m => {
    if (m.author.bot || m.guildId !== cfg.ServerId || m.channelId !== s.config.textChannelId) return;
    const text = m.content.trim(); const [command] = text.split(/\s+/);
    const allowed = ['ش','وقف','كمل','تخطي','كرر','قائمة','اخرج'];
    if (!allowed.includes(command)) return;
    if (!canControl(s, m.member)) return voiceError(m, s).catch(console.error);
    if (command === 'ش') {
      const query = text.slice(command.length).trim();
      if (!query) { await updatePanel(s); return; }
      const requester = { name: m.member?.displayName || m.author.username, avatar: m.author.displayAvatarURL() };
      await updatePanel(s, { query, requester });
      try { const song = await findSong(query, requester); s.queue.push(song); await m.react('✅').catch(() => {}); if (!s.current && !s.busy) await playNext(s); else await updatePanel(s); }
      catch (e) { await m.reply({ embeds: [new EmbedBuilder().setColor(0x292064).setTitle('Unable to find or play this song').setDescription(limit(e.message, 700))] }); await updatePanel(s); }
      return;
    }
    if (command === 'قائمة') return m.reply({ embeds: [new EmbedBuilder().setColor(0x292064).setTitle('Song Queue').setDescription(s.queue.length ? s.queue.slice(0, 10).map((x,i) => `${i+1}. ${limit(x.title, 70)}`).join('\n') : 'The queue is empty.')] });
    if (command === 'اخرج') return m.reply({ embeds: [new EmbedBuilder().setColor(0x292064).setDescription('This bot stays in its assigned voice channel. Use the web dashboard to disconnect it.')] });
    let actionTaken = null;
    if (command === 'وقف' && s.player.state.status === AudioPlayerStatus.Playing) { await control(s, 'pause'); actionTaken = 'pause'; }
    else if (command === 'كمل' && s.player.state.status === AudioPlayerStatus.Paused) { await control(s, 'pause'); actionTaken = 'pause'; }
    else if (!['وقف','كمل'].includes(command)) { actionTaken = ({ تخطي:'skip', كرر:'repeat' })[command]; if (actionTaken) await control(s, actionTaken); }
    if (actionTaken) await sendControlEmbed(s, actionTaken).catch(e => console.error(`[${s.config.name}] action embed: ${e.message}`));
    await m.react('✅').catch(() => {});
  });
  client.on(Events.InteractionCreate, async i => {
    if (!i.isButton() || !i.customId.startsWith(`music:${s.id}:`)) return;
    if (i.guildId !== cfg.ServerId || !canControl(s, i.member)) return voiceError(i, s).catch(console.error);
    await i.deferUpdate();
    const actionName = i.customId.split(':')[2];
    await control(s, actionName);
    await sendControlEmbed(s, actionName, i).catch(e => console.error(`[${s.config.name}] action embed: ${e.message}`));
  });
  client.on(Events.Error, e => console.error(`[${s.config.name}] client: ${e.message}`));
  try { await client.login(s.config.token); }
  catch (e) { s.started = false; s.status = `Login error: ${limit(e.message, 80)}`; client.destroy(); throw e; }
}
async function stopBot(s) {
  s.stopping = true; s.started = false; clearTimeout(s.reconnectTimer); s.queue = []; s.current = null;
  cleanupAudio(s); s.player?.stop(true);
  try { s.connection?.destroy(); } catch {}
  s.connection = null; s.panel = null;
  s.client?.destroy(); s.client = null; s.status = 'Offline'; s.stopping = false;
}
const app = express();
app.use(express.json({ limit: '10kb' }));
// Serve the banner from the original project Photos directory.
app.use('/Photos', express.static(path.join(__dirname, 'Photos')));
app.use(express.static(path.join(__dirname, 'public')));
const safeState = s => ({ id: s.id, name: s.config.name, voiceChannelId: s.config.voiceChannelId, textChannelId: s.config.textChannelId, status: s.status, started: s.started, volume: s.volume, repeat: s.repeat, current: s.current?.title || null, queue: s.queue.length });
app.get('/api/status', (_,res) => res.json(states.map(safeState)));
let pending = false;
app.post('/api/:action', async (req,res) => {
  const action = req.params.action;
  if (!['start-all','stop-all','start','stop'].includes(action)) return res.status(404).json({ error:'Unknown action' });
  if (pending) return res.status(409).json({ error:'Operation already running' });
  const selected = action.endsWith('-all') ? states : [states[Number(req.body?.id)]];
  if (selected.some(x => !x)) return res.status(400).json({ error:'Invalid bot ID' });
  pending = true; const results = [];
  try { await Promise.all(selected.map(async s => { try { if (action.startsWith('start')) await startBot(s); else await stopBot(s); results.push({ id:s.id, ok:true }); } catch(e) { results.push({ id:s.id, ok:false, error:limit(e.message,150) }); } })); res.json({ results }); }
  finally { pending = false; }
});
const host = cfg.dashboard?.host || '127.0.0.1';
if (!['127.0.0.1','localhost','::1'].includes(host)) throw new Error('Dashboard is local-only for safety. Set dashboard.host to 127.0.0.1.');
const port = Number(cfg.dashboard?.port || 3210);
app.listen(port, host, () => console.log(`NHQM MUSIC DASHBOARD: http://${host}:${port}`));
process.on('SIGINT', async () => { await Promise.all(states.map(stopBot)); process.exit(0); });
