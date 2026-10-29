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
const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '4889362380').replace(/-/g, '');
const LOGIN_ID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
const DATA_PATH = path.resolve(process.env.DATA_PATH || 'data.json');
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 120);
const SKIP_TELEGRAM = process.env.SKIP_TELEGRAM === 'true' || BOOTSTRAP || DRY_RUN;
const GIT_PUSH = process.env.GIT_PUSH === 'true' && !DRY_RUN;
const PROJECT = process.env.PROJECT_NAME || 'Mustafa Reklam';

function required(key) { const val = process.env[key]; if (!val) throw new Error(`Missing ${key}`); return val; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
  // One extra UTC day ensures no missing events due to advertiser timezone offset.
  const dt = new Date(Date.now() - (LOOKBACK_DAYS + 1) * 86400000);
  return dt.toISOString().slice(0, 10);
}

function toLegacyDate(accountLocalTime) {
  // Google Ads returns creation_date_time in the advertiser account's local timezone.
  // Never add a fixed UTC offset: Vienna alternates between CET and CEST.
  const match = String(accountLocalTime || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}:${match[5]}` : '-';
}
function dateSortKey(value) {
  const m = String(value).match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);
  return m ? `${m[3]}${m[2]}${m[1]}${m[4]}${m[5]}` : '';
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

  const format = (key, label) => `<b>${label}:</b> ${htmlEscape(lead[key])}`;
  const message = [
    `🔔 <b>YENİ Müşteri!</b> (${htmlEscape(PROJECT)})`,
    format('Musteri', 'Müşteri'),
    ...(lead.Telefon ? [format('Telefon', 'Telefon')] : []),
    format('Konum', 'Konum'),
    format('Hizmet', 'Hizmet'),
    format('Tarih', 'Tarih'),
    format('Mesaj', 'Mesaj'),
  ].join('\n');

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
  // Conversations can be many per lead. Restrict by event timestamp, but include
  // conversations slightly older than lead-query window to avoid boundary mismatch.
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
    return {
      // Do not modify legacy MD5 identifiers: API leads have a stable prefixed ID.
      id: `lsa:${CUSTOMER_ID}:${lead.id}`,
      Musteri: contact.consumerName || phone || 'Müşteri',
      Telefon: phone,
      Hizmet: lead.serviceId || lead.categoryId || lead.leadType || '-',
      // The API does not guarantee the inbox's location column. Do not invent it.
      Konum: '-',
      Tarih: toLegacyDate(lead.creationDateTime),
      Mesaj: conversations.length ? conversations.map(x => x.text).join('\n\n') : '-',
      telegramSent: false,
      // Additional audit fields, safe for existing consumers to ignore.
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
  // Do not pull/rebase automatically while handling customer data.
  execFileSync('git', ['commit', '-m', 'Update LSA lead data [skip ci]'], { cwd, stdio: 'inherit', timeout: 15000 });
  execFileSync('git', ['push', 'origin', 'HEAD:main'], { cwd, stdio: 'inherit', timeout: 30000 });
}

async function main() {
  if (!/^\d{10}$/.test(CUSTOMER_ID)) throw new Error('GOOGLE_ADS_CUSTOMER_ID must be 10 digits');
  const token = await accessToken();
  if (CHECK) return check(token);
  const imported = await fetchLeads(token); // On API error, existing data remains untouched.
  const current = loadData();
  const byId = new Map(current.leads.map(l => [l.id, l]));
  let added = 0, changed = 0;
  for (const lead of imported) {
    const old = byId.get(lead.id);
    if (!old) {
      added++;
      byId.set(lead.id, { ...lead, telegramSent: BOOTSTRAP ? true : false });
    } else {
      const merged = { ...old, ...lead, telegramSent: Boolean(old.telegramSent) };
      // Retain historically scraped location / human-friendly service if API does not have it.
      if (lead.Konum === '-' && old.Konum && old.Konum !== '-') merged.Konum = old.Konum;
      if (lead.Mesaj === '-' && old.Mesaj && old.Mesaj !== '-') merged.Mesaj = old.Mesaj;
      if (JSON.stringify(old) !== JSON.stringify(merged)) changed++;
      byId.set(lead.id, merged);
    }
  }
  const all = [...byId.values()].sort((a, b) => dateSortKey(b.Tarih).localeCompare(dateSortKey(a.Tarih)));
  console.log(`${imported.length} API leads; ${added} new; ${changed} updated; ${all.length} total including legacy records.`);
  if (DRY_RUN) return console.log('Dry run: no file writes, Telegram notifications or Git changes.');
  // Persist first, including new records marked telegramSent=false, so crashes are retried.
  const output = { ...current, updatedAt: new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }), leads: all };
  atomicWrite(output);
  if (!SKIP_TELEGRAM) {
    // Only API leads are candidates. Legacy entries must not be unexpectedly re-sent.
    for (const lead of all.filter(l => l.googleLeadId && !l.telegramSent)) {
      try {
        if (await sendTelegram(lead)) {
          lead.telegramSent = true;
          atomicWrite(output);
          console.log(`Telegram sent for ${lead.id}`);
        }
      } catch (e) { console.error(`Telegram failed for ${lead.id}: ${e.message}`); process.exitCode = 1; }
      await sleep(250);
    }
  } else { console.log('Telegram disabled (SKIP_TELEGRAM, --bootstrap or --dry-run).'); }
  if (GIT_PUSH) gitPush();
  console.log(`Saved ${DATA_PATH}`);
}
main().catch(err => { console.error(`ERROR: ${err.message}`); process.exitCode = 1; });
