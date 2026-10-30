#!/usr/bin/env node
'use strict';
// Node.js 20.6+. Run: node --env-file=.env scraper-api.js --check|--bootstrap|--dry-run
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  try { process.loadEnvFile('.env'); } catch {}
}

const cli = new Set(process.argv.slice(2));
const CHECK = cli.has('--check');
const BOOTSTRAP = cli.has('--bootstrap');
const DRY_RUN = cli.has('--dry-run') || CHECK;
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v26';
const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '3226096935').replace(/-/g, '');
const LOGIN_ID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
const DATA_PATH = path.resolve(process.env.DATA_PATH || 'data.json');
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 120);
const SKIP_TELEGRAM = process.env.SKIP_TELEGRAM === 'true' || BOOTSTRAP || DRY_RUN;
const GIT_PUSH = process.env.GIT_PUSH === 'true' && !DRY_RUN;
const PROJECT = process.env.PROJECT_NAME || 'Sicher Reklam';
const DEFAULT_LOCATION = process.env.DEFAULT_LOCATION || 'Wien';

function required(key) { const val = process.env[key]; if (!val) throw new Error(`Missing ${key}`); return val; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const AUSTRIAN_AREAS = [
  // Major Cities / States
  { name: 'Wien', regex: /\b(wien|vienna|1\d{3})\b/i },
  { name: 'Niederösterreich', regex: /\b(niederösterreich|niederoesterreich|nö)\b/i },
  { name: 'Burgenland', regex: /\b(burgenland)\b/i },
  { name: 'Oberösterreich', regex: /\b(oberösterreich|oö|linz|wels|steyr)\b/i },
  { name: 'Steiermark', regex: /\b(steiermark|graz|leoben)\b/i },
  { name: 'Kärnten', regex: /\b(kärnten|kaernten|klagenfurt|villach)\b/i },
  { name: 'Salzburg', regex: /\b(salzburg)\b/i },
  { name: 'Tirol', regex: /\b(tirol|innsbruck)\b/i },
  { name: 'Vorarlberg', regex: /\b(vorarlberg|bregenz|dornbirn|feldkirch)\b/i },

  // Specific NÖ / Burgenland / Vienna regions
  { name: 'Eisenstadt', regex: /\b(eisenstadt)\b/i },
  { name: 'Wiener Neustadt', regex: /\b(wiener\s*neustadt|wr\.?\s*neustadt)\b/i },
  { name: 'Sieghartskirchen', regex: /\b(sieghartskirchen)\b/i },
  { name: 'Zwettl', regex: /\b(zwettl)\b/i },
  { name: 'Weyer', regex: /\b(weyer)\b/i },
  { name: 'St. Pölten', regex: /\b(st\.?\s*pölten|sankt\s*pölten)\b/i },
  { name: 'Baden', regex: /\b(baden)\b/i },
  { name: 'Mödling', regex: /\b(mödling)\b/i },
  { name: 'Tulln', regex: /\b(tulln)\b/i },
  { name: 'Korneuburg', regex: /\b(korneuburg)\b/i },
  { name: 'Gänserndorf', regex: /\b(gänserndorf)\b/i },
  { name: 'Bruck an der Leitha', regex: /\b(bruck\s*an\s*der\s*leitha)\b/i },
  { name: 'Neusiedl am See', regex: /\b(neusiedl)\b/i },
  { name: 'Mattersburg', regex: /\b(mattersburg)\b/i },
  { name: 'Oberwart', regex: /\b(oberwart)\b/i },
  { name: 'Großpetersdorf', regex: /\b(großpetersdorf)\b/i },
  { name: 'Kohfidisch', regex: /\b(kohfidisch)\b/i },
  { name: 'Krems', regex: /\b(krems)\b/i },
  { name: 'Amstetten', regex: /\b(amstetten)\b/i },
  { name: 'Mistelbach', regex: /\b(mistelbach)\b/i },
  { name: 'Hollabrunn', regex: /\b(hollabrunn)\b/i },
  { name: 'Schwechat', regex: /\b(schwechat)\b/i },
  { name: 'Klosterneuburg', regex: /\b(klosterneuburg)\b/i },
];

const AUSTRIAN_PREFIXES = [
  { prefix: /^(?:\+43|0043|0)?1\d{4,}$/, location: 'Wien' },
  { prefix: /^(?:\+43|0043|0)?2682/, location: 'Eisenstadt' },
  { prefix: /^(?:\+43|0043|0)?2622/, location: 'Wiener Neustadt' },
  { prefix: /^(?:\+43|0043|0)?2274/, location: 'Sieghartskirchen' },
  { prefix: /^(?:\+43|0043|0)?2742/, location: 'St. Pölten' },
  { prefix: /^(?:\+43|0043|0)?2252/, location: 'Baden' },
  { prefix: /^(?:\+43|0043|0)?2236/, location: 'Mödling' },
  { prefix: /^(?:\+43|0043|0)?2272/, location: 'Tulln an der Donau' },
  { prefix: /^(?:\+43|0043|0)?2262/, location: 'Korneuburg' },
  { prefix: /^(?:\+43|0043|0)?2282/, location: 'Gänserndorf' },
  { prefix: /^(?:\+43|0043|0)?2162/, location: 'Bruck an der Leitha' },
  { prefix: /^(?:\+43|0043|0)?2167/, location: 'Neusiedl am See' },
  { prefix: /^(?:\+43|0043|0)?2732/, location: 'Krems an der Donau' },
  { prefix: /^(?:\+43|0043|0)?2822/, location: 'Zwettl' },
  { prefix: /^(?:\+43|0043|0)?316/,  location: 'Graz' },
  { prefix: /^(?:\+43|0043|0)?732/,  location: 'Linz' },
  { prefix: /^(?:\+43|0043|0)?662/,  location: 'Salzburg' },
  { prefix: /^(?:\+43|0043|0)?512/,  location: 'Innsbruck' },
  { prefix: /^(?:\+43|0043|0)?463/,  location: 'Klagenfurt' },
];

function detectLocation(lead, fallbackLocation = DEFAULT_LOCATION) {
  if (lead.Konum && lead.Konum !== '-' && lead.Konum.trim().length > 1) {
    return lead.Konum.trim();
  }

  const msg = lead.Mesaj || '';
  if (msg && msg !== '-') {
    const found = [];
    for (const item of AUSTRIAN_AREAS) {
      if (item.regex.test(msg)) found.push(item.name);
    }
    if (found.length > 0) {
      return [...new Set(found)].slice(0, 2).join(' / ');
    }
    const zipMatch = msg.match(/\b(1\d{3})\b/);
    if (zipMatch) return `Wien (${zipMatch[1]})`;
    const nöZipMatch = msg.match(/\b([23]\d{3})\b/);
    if (nöZipMatch) return `Niederösterreich (${nöZipMatch[1]})`;
  }

  const rawPhone = (lead.Telefon || '').replace(/[\s\-\/\(\)]/g, '');
  if (rawPhone) {
    for (const item of AUSTRIAN_PREFIXES) {
      if (item.prefix.test(rawPhone)) return item.location;
    }
  }

  return fallbackLocation;
}

async function requestJson(url, opts = {}, retry = 0) {
  let response;
  try { response = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) }); }
  catch (e) {
    if (retry < 3) { await sleep(500 * 2 ** retry); return requestJson(url, opts, retry + 1); }
    throw e;
  }
  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = {}; }
  if (!response.ok) {
    if ([429, 500, 502, 503, 504].includes(response.status) && retry < 3) {
      await sleep(1000 * 2 ** retry); return requestJson(url, opts, retry + 1);
    }
    const detail = json.error?.message || raw.slice(0, 700);
    const requestId = response.headers.get('request-id') || response.headers.get('google-ads-request-id');
    throw new Error(`HTTP ${response.status}: ${detail}${requestId ? ` (request-id ${requestId})` : ''}`);
  }
  return json;
}

async function accessToken() {
  const form = new URLSearchParams({
    client_id: required('GOOGLE_CLIENT_ID'),
    client_secret: required('GOOGLE_CLIENT_SECRET'),
    refresh_token: required('GOOGLE_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  });
  const result = await requestJson('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
  });
  if (!result.access_token) throw new Error('OAuth response did not contain an access token');
  return result.access_token;
}

function headers(token) {
  const value = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (devToken) value['developer-token'] = devToken;
  if (LOGIN_ID) value['login-customer-id'] = LOGIN_ID;
  return value;
}

async function gaql(token, query) {
  const out = [];
  let pageToken;
  do {
    const json = await requestJson(`https://googleads.googleapis.com/${API_VERSION}/customers/${CUSTOMER_ID}/googleAds:search`, {
      method: 'POST', headers: headers(token), body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
    });
    out.push(...(json.results || []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

function lastDate() {
  if (!Number.isInteger(LOOKBACK_DAYS) || LOOKBACK_DAYS < 1 || LOOKBACK_DAYS > 3650) {
    throw new Error('LOOKBACK_DAYS must be between 1 and 3650');
  }
  const dt = new Date(Date.now() - (LOOKBACK_DAYS + 1) * 86400000);
  return dt.toISOString().slice(0, 10);
}

function toLegacyDate(accountLocalTime) {
  const match = String(accountLocalTime || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}:${match[5]}` : '-';
}

function dateSortKey(value) {
  const m = String(value).match(/^(\d{2})\.(\d{2})\.(\d{2,4}) (\d{2}):(\d{2})$/);
  if (!m) return '';
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}${m[2]}${m[1]}${m[4]}${m[5]}`;
}

function htmlEscape(value) {
  return String(value ?? '-').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function loadData() {
  if (!fs.existsSync(DATA_PATH)) return { updatedAt: null, leads: [] };
  const content = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  if (!Array.isArray(content.leads)) throw new Error(`Invalid ${DATA_PATH}: leads[] missing`);
  return content;
}

function atomicWrite(value) {
  const tmp = `${DATA_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, DATA_PATH);
}

async function sendTelegram(lead) {
  const targets = [];

  const token1 = process.env.TELEGRAM_BOT_TOKEN;
  const chatId1 = process.env.TELEGRAM_CHAT_ID;
  if (token1 && chatId1) {
    for (const id of chatId1.split(',').map(s => s.trim()).filter(Boolean)) {
      targets.push({ token: token1, chatId: id });
    }
  }

  const token2 = process.env.TELEGRAM_BOT_TOKEN_2 || token1;
  const chatId2 = process.env.TELEGRAM_CHAT_ID_2;
  if (token2 && chatId2) {
    for (const id of chatId2.split(',').map(s => s.trim()).filter(Boolean)) {
      targets.push({ token: token2, chatId: id });
    }
  }

  if (targets.length === 0) throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');

  let customerText = '';
  if (lead.Telefon) {
    if (lead.Musteri && lead.Musteri !== lead.Telefon && lead.Musteri !== 'Müşteri' && lead.Musteri !== '-') {
      customerText = `${htmlEscape(lead.Musteri)} (${htmlEscape(lead.Telefon)})`;
    } else {
      customerText = htmlEscape(lead.Telefon);
    }
  } else {
    customerText = htmlEscape(lead.Musteri || '-');
  }

  const lines = [
    `🔔 <b>YENİ Müşteri!</b> (${htmlEscape(PROJECT)})`,
    `<b>Müşteri:</b> ${customerText}`,
    `<b>Konum:</b> ${htmlEscape(lead.Konum || DEFAULT_LOCATION)}`,
    `<b>Tarih:</b> ${htmlEscape(lead.Tarih || '-')}`,
    `<b>Anfrage-ID:</b> <code>${htmlEscape(lead.googleLeadId || lead.id)}</code>`,
  ];

  if (lead.Mesaj && lead.Mesaj !== '-') {
    lines.push(`<b>Mesaj:</b> ${htmlEscape(lead.Mesaj)}`);
  }

  const message = lines.join('\n');

  let anySuccess = false;
  for (const target of targets) {
    try {
      const result = await requestJson(`https://api.telegram.org/bot${target.token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: target.chatId, text: message.slice(0, 4000), parse_mode: 'HTML' }),
      });
      if (result.ok === true) anySuccess = true;
    } catch (err) {
      console.error(`Telegram send failed to ${target.chatId}: ${err.message}`);
    }
  }
  return anySuccess;
}

async function check(token) {
  console.log(`Checking Google Ads customer ${CUSTOMER_ID} via ${API_VERSION}...`);
  const customers = await gaql(token, 'SELECT customer.id, customer.descriptive_name, customer.time_zone, customer.manager FROM customer');
  for (const row of customers) console.log(JSON.stringify(row.customer));
  const campaigns = await gaql(token, "SELECT campaign.id, campaign.name, campaign.advertising_channel_type FROM campaign WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES'");
  console.log(`Local Services campaigns: ${campaigns.length}`);
  for (const row of campaigns) console.log(JSON.stringify(row.campaign));
  const sample = await gaql(token, `SELECT local_services_lead.id FROM local_services_lead WHERE local_services_lead.creation_date_time >= '${lastDate()}' LIMIT 1`);
  console.log(`Recent Local Services leads accessible: ${sample.length > 0 ? 'yes' : 'none returned'}`);
  console.log('Account check done. No files changed and no Telegram messages sent.');
}

async function fetchLeads(token) {
  const since = lastDate();
  const leadRows = await gaql(token, `
    SELECT local_services_lead.id, local_services_lead.resource_name,
           local_services_lead.lead_type, local_services_lead.category_id,
           local_services_lead.service_id, local_services_lead.contact_details,
           local_services_lead.creation_date_time, local_services_lead.lead_status
    FROM local_services_lead
    WHERE local_services_lead.creation_date_time >= '${since}'
    ORDER BY local_services_lead.creation_date_time DESC`);

  const conversationRows = await gaql(token, `
    SELECT local_services_lead_conversation.lead,
           local_services_lead_conversation.id,
           local_services_lead_conversation.event_date_time,
           local_services_lead_conversation.conversation_channel,
           local_services_lead_conversation.participant_type,
           local_services_lead_conversation.message_details.text
    FROM local_services_lead_conversation
    WHERE local_services_lead_conversation.event_date_time >= '${since}'
    ORDER BY local_services_lead_conversation.event_date_time ASC`);
  console.log(`API: ${leadRows.length} leads, ${conversationRows.length} conversation events since ${since}`);
  const messages = new Map();
  for (const row of conversationRows) {
    const c = row.localServicesLeadConversation || {};
    if (!c.lead || c.participantType !== 'CONSUMER' || !c.messageDetails?.text) continue;
    const existing = messages.get(c.lead) || [];
    existing.push({ id: c.id || '', date: c.eventDateTime || '', text: c.messageDetails.text });
    messages.set(c.lead, existing);
  }
  return leadRows.map(row => {
    const lead = row.localServicesLead;
    const contact = lead.contactDetails || {};
    const extension = contact.phoneNumberExtension;
    const phone = contact.phoneNumber ? `${contact.phoneNumber}${extension ? ` ext. ${extension}` : ''}` : null;
    const conversations = (messages.get(lead.resourceName) || []).sort((a, b) => a.date.localeCompare(b.date));
    const messageText = conversations.length ? conversations.map(x => x.text).join('\n\n') : '-';
    const detectedLoc = detectLocation({ Mesaj: messageText, Telefon: phone, Konum: '-' }, DEFAULT_LOCATION);

    return {
      id: `lsa:${CUSTOMER_ID}:${lead.id}`,
      Musteri: contact.consumerName || phone || 'Müşteri',
      Telefon: phone,
      Hizmet: lead.serviceId || lead.categoryId || lead.leadType || '-',
      Konum: detectedLoc,
      Tarih: toLegacyDate(lead.creationDateTime),
      Mesaj: messageText,
      telegramSent: false,
      googleLeadId: String(lead.id),
      googleLeadResource: lead.resourceName,
      leadType: lead.leadType || null,
      leadStatus: lead.leadStatus || null,
    };
  });
}

function gitPush() {
  const cwd = path.dirname(DATA_PATH);
  const file = path.basename(DATA_PATH);
  execFileSync('git', ['add', '--', file], { cwd, stdio: 'inherit', timeout: 15000 });
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' }).trim();
  if (!staged) return;
  execFileSync('git', ['commit', '-m', 'Update LSA lead data [skip ci]'], { cwd, stdio: 'inherit', timeout: 15000 });
  execFileSync('git', ['push', 'origin', 'HEAD:main'], { cwd, stdio: 'inherit', timeout: 30000 });
}

async function main() {
  if (!/^\d{10}$/.test(CUSTOMER_ID)) throw new Error('GOOGLE_ADS_CUSTOMER_ID must be 10 digits');
  const token = await accessToken();
  if (CHECK) return check(token);
  const imported = await fetchLeads(token);
  const current = loadData();
  const byId = new Map(current.leads.map(l => [l.id, l]));

  // Build a set of ALL IDs that have ever been sent to Telegram
  const sentIds = new Set();
  for (const l of current.leads) {
    if (l.telegramSent) {
      if (l.id) sentIds.add(String(l.id));
      if (l.googleLeadId) sentIds.add(String(l.googleLeadId));
      if (l.id && l.id.startsWith('lsa:')) {
        const parts = l.id.split(':');
        if (parts[2]) sentIds.add(String(parts[2]));
      }
    }
  }

  let added = 0, changed = 0;
  for (const lead of imported) {
    const old = byId.get(lead.id);
    const wasSent = (old && old.telegramSent) || 
                    sentIds.has(String(lead.googleLeadId)) || 
                    sentIds.has(String(lead.id));

    if (!old) {
      added++;
      byId.set(lead.id, { ...lead, telegramSent: BOOTSTRAP ? true : wasSent });
    } else {
      const merged = { ...old, ...lead, telegramSent: wasSent };
      // Retain historically scraped location if available and valid
      if (old.Konum && old.Konum !== '-' && old.Konum !== DEFAULT_LOCATION) {
        merged.Konum = old.Konum;
      }
      if (lead.Mesaj === '-' && old.Mesaj && old.Mesaj !== '-') merged.Mesaj = old.Mesaj;
      if (JSON.stringify(old) !== JSON.stringify(merged)) changed++;
      byId.set(lead.id, merged);
    }
  }

  // Sort descending for data.json display (newest first on top of data.json)
  const all = [...byId.values()].sort((a, b) => 
    dateSortKey(b.Tarih).localeCompare(dateSortKey(a.Tarih)) || 
    String(b.googleLeadId || '').localeCompare(String(a.googleLeadId || ''))
  );

  console.log(`${imported.length} API leads; ${added} new; ${changed} updated; ${all.length} total including legacy records.`);
  if (DRY_RUN) return console.log('Dry run: no file writes, Telegram notifications or Git changes.');

  const output = { ...current, updatedAt: new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }), leads: all };
  atomicWrite(output);

  if (!SKIP_TELEGRAM) {
    // CHRONOLOGICAL ORDER: Oldest first -> Newest last, so in Telegram the newest message sits at the bottom!
    const unsentLeads = all
      .filter(l => l.googleLeadId && !l.telegramSent)
      .sort((a, b) => 
        dateSortKey(a.Tarih).localeCompare(dateSortKey(b.Tarih)) || 
        String(a.googleLeadId).localeCompare(String(b.googleLeadId))
      );

    console.log(`Unsent leads to dispatch: ${unsentLeads.length}`);

    for (const lead of unsentLeads) {
      try {
        if (await sendTelegram(lead)) {
          lead.telegramSent = true;
          sentIds.add(String(lead.googleLeadId));
          sentIds.add(String(lead.id));
          atomicWrite(output);
          console.log(`Telegram sent for ${lead.id} (${lead.googleLeadId} - ${lead.Tarih})`);
        }
      } catch (e) {
        console.error(`Telegram failed for ${lead.id}: ${e.message}`);
        process.exitCode = 1;
      }
      await sleep(350);
    }
  } else {
    console.log('Telegram disabled (SKIP_TELEGRAM, --bootstrap or --dry-run).');
  }

  if (GIT_PUSH) gitPush();
  console.log(`Saved ${DATA_PATH}`);
}

main().catch(err => { console.error(`ERROR: ${err.message}`); process.exitCode = 1; });
