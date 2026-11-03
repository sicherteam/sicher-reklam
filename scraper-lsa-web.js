#!/usr/bin/env node
'use strict';

/**
 * 24/7 Automated LSA Web Scraper with Automated 2FA Login
 * Logs in to ads.google.com/localservices/inbox using Google Authenticator (TOTP),
 * extracts the exact "Standort" (location) for every call & message,
 * syncs with data.json, and pushes real-time Telegram alerts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
  try { process.loadEnvFile('.env'); } catch {}
}

const EMAIL = process.env.GOOGLE_EMAIL || 'atsicherteam@gmail.com';
const PASSWORD = process.env.GOOGLE_PASSWORD;
const TOTP_SECRET = (process.env.GOOGLE_2FA_SECRET || '5gzwaIwsz2ehseiz2hjbdokz23rwmsan').replace(/\s+/g, '');
const INBOX_URL = process.env.LSA_INBOX_URL || 'https://ads.google.com/localservices/inbox?cid=9203255169&bid=11049534709&pid=9999999999&euid=8501543550&hl=de&gl=AT';
const PROJECT = process.env.PROJECT_NAME || 'Sicher Reklam';
const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '3226096935').replace(/-/g, '');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_CHAT_2 = process.env.TELEGRAM_CHAT_ID_2;
const DATA_PATH = path.resolve(process.env.DATA_PATH || 'data.json');
const SESSION_PATH = path.resolve('session-state.json');

function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, index = 0;
  const cleanStr = str.replace(/=+$/, '').toUpperCase().replace(/[\s-]/g, '');
  const out = Buffer.alloc(Math.floor(cleanStr.length * 5 / 8));
  for (let i = 0; i < cleanStr.length; i++) {
    const val = alphabet.indexOf(cleanStr[i]);
    if (val === -1) throw new Error('Invalid base32 char: ' + cleanStr[i]);
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

function generateTOTP(secret, timeStep = 30) {
  const key = base32Decode(secret);
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / timeStep);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return code.toString().padStart(6, '0');
}

function htmlEscape(value) {
  return String(value ?? '-').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendTelegram(lead) {
  const targets = [];
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT) {
    for (const id of TELEGRAM_CHAT.split(',').map(s => s.trim()).filter(Boolean)) {
      targets.push({ token: TELEGRAM_TOKEN, chatId: id });
    }
  }
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_2) {
    for (const id of TELEGRAM_CHAT_2.split(',').map(s => s.trim()).filter(Boolean)) {
      targets.push({ token: TELEGRAM_TOKEN, chatId: id });
    }
  }
  if (targets.length === 0) {
    console.log('No Telegram targets configured.');
    return;
  }

  const isMsg = lead.art?.toLowerCase().includes('nachricht') || lead.art?.toLowerCase().includes('sms');
  const header = isMsg
    ? `💬 <b>NEUER Kunde (Nachricht)!</b> (${htmlEscape(PROJECT)})`
    : `📞 <b>NEUER Kunde (Tel)!</b> (${htmlEscape(PROJECT)})`;

  const lines = [
    header,
    `<b>Kunde:</b> ${htmlEscape(lead.kunde || '-')}`,
    `<b>Ort:</b> ${htmlEscape(lead.standort && lead.standort !== '-' ? lead.standort : '-')}`,
    `<b>Datum:</b> ${htmlEscape(lead.datum || '-')}`,
  ];
  if (lead.jobtyp && lead.jobtyp !== '-') {
    lines.push(`<b>Dienstleistung:</b> ${htmlEscape(lead.jobtyp)}`);
  }
  if (lead.status && lead.status !== '-') {
    lines.push(`<b>Status:</b> ${htmlEscape(lead.status)}`);
  }
  if (lead.leadId) {
    lines.push(`\n<code>#LSA-${CUSTOMER_ID}-${lead.leadId}</code>`);
  }

  const text = lines.join('\n');
  for (const t of targets) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${t.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: t.chatId,
          text: text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      const data = await res.json();
      console.log(`Telegram sent to ${t.chatId}: ${data.ok ? 'SUCCESS' : JSON.stringify(data)}`);
    } catch (e) {
      console.error(`Telegram send error to ${t.chatId}:`, e.message);
    }
  }
}

function parseCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) return [];
  const leads = [];

  for (let i = 1; i < lines.length; i++) {
    const row = [];
    let insideQuotes = false;
    let current = '';
    for (const char of lines[i]) {
      if (char === '"') {
        insideQuotes = !insideQuotes;
      } else if (char === ',' && !insideQuotes) {
        row.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    row.push(current.trim());

    // Header: Kunde,Art der Dienstleistung,Suchintention,Standort,Art der Anfrage,Gebührenstatus,Anfrage erhalten,Letzte Aktivität
    const kunde = row[0] || '';
    const jobtyp = row[1] || '';
    const standort = row[3] || '';
    const art = row[4] || '';
    const status = row[5] || '';
    const datum = row[6] || '';

    if (kunde || standort) {
      leads.push({ kunde, jobtyp, standort, art, status, datum });
    }
  }
  return leads;
}

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '').replace(/^43/, '0');
}

function loadData() {
  if (!fs.existsSync(DATA_PATH)) return { updatedAt: null, leads: [] };
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
}

function saveData(data) {
  const tmp = `${DATA_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, DATA_PATH);
}

async function run() {
  console.log(`=== Starting 24/7 LSA Web Scraper for ${PROJECT} ===`);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--start-maximized'
    ]
  });

  const contextOptions = {
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  };

  if (fs.existsSync(SESSION_PATH)) {
    console.log('Restoring previous session state from', SESSION_PATH);
    contextOptions.storageState = SESSION_PATH;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    console.log('Navigating to LSA Inbox URL:', INBOX_URL);
    await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Dismiss GDPR consent if present
    const consentBtn = page.locator('button:has-text("Alle akzeptieren"), button:has-text("Ich stimme zu"), button:has-text("Accept all")').first();
    if (await consentBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('Accepting cookies...');
      await consentBtn.click();
      await page.waitForTimeout(2000);
    }

    let currentUrl = page.url();
    console.log('Landing URL:', currentUrl);

    // If redirected to Google login
    if (currentUrl.includes('accounts.google.com') || currentUrl.includes('ServiceLogin')) {
      console.log('Google login required. Starting automated 2FA login...');
      if (!PASSWORD) {
        throw new Error('GOOGLE_PASSWORD is required in environment/secrets!');
      }

      // Step 1: Email
      console.log('Typing email:', EMAIL);
      const emailInput = page.locator('#identifierId, input[name="identifier"], input[type="email"], input[type="text"]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 30000 });
      await emailInput.click();
      await emailInput.pressSequentially(EMAIL, { delay: 60 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: 'step1_email.png' }).catch(() => {});
      await emailInput.press('Enter');

      const nextBtn = page.locator('#identifierNext button, #identifierNext, button:has-text("Weiter"), button:has-text("Next")').first();
      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn.click().catch(() => {});
      }
      await page.waitForTimeout(4000);

      // Step 2: Password
      console.log('Waiting for password input...');
      const passInput = page.locator('input[type="password"], input[name="Passwd"], input[name="password"]').first();
      await passInput.waitFor({ state: 'visible', timeout: 30000 });
      await passInput.click();
      await passInput.pressSequentially(PASSWORD, { delay: 60 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: 'step2_password.png' }).catch(() => {});
      await passInput.press('Enter');

      const passNext = page.locator('#passwordNext button, #passwordNext, button:has-text("Weiter"), button:has-text("Next")').first();
      if (await passNext.isVisible({ timeout: 2000 }).catch(() => false)) {
        await passNext.click().catch(() => {});
      }
      await page.waitForTimeout(4000);

      // Step 3: 2FA TOTP
      console.log('Checking for 2FA challenge...');
      await page.waitForTimeout(4000);
      await page.screenshot({ path: 'step3_2fa_prompt.png' }).catch(() => {});

      let bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');
      let isAuthenticatorScreen = /authenticator|authentifikator/i.test(bodyText) && !bodyText.includes('g.co/sc');

      if (!isAuthenticatorScreen) {
        console.log('Current screen is not Authenticator (found Sicherheitscode g.co/sc or prompt). Looking for "Andere Option wählen"...');
        const tryAnother = page.locator('button:has-text("Andere Option"), [role="button"]:has-text("Andere Option"), button:has-text("Try another"), [role="button"]:has-text("Try another"), button:has-text("Andere"), [role="button"]:has-text("Andere"), a:has-text("Andere")').first();
        if (await tryAnother.isVisible({ timeout: 5000 }).catch(() => false)) {
          console.log('Clicking "Andere Option wählen"...');
          await tryAnother.click();
          await page.waitForTimeout(3000);
          await page.screenshot({ path: 'step3b_other_options.png' }).catch(() => {});

          console.log('Searching for Authenticator option in list...');
          const authClicked = await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('*'));
            const target = all.find(el => el.textContent && el.textContent.includes('Google Authenticator') && el.children.length === 0);
            if (target) {
              const clickable = target.closest('li, [role="link"], [role="button"]') || target;
              clickable.click();
              return true;
            }
            return false;
          });

          if (!authClicked) {
            console.log('Fallback: clicking getByText Google Authenticator...');
            const authText = page.getByText(/Google Authenticator/i).first();
            await authText.click({ force: true }).catch(e => console.log('Auth click error:', e.message));
          }

          await page.waitForTimeout(3000);
          await page.screenshot({ path: 'step3c_authenticator_prompt.png' }).catch(() => {});

          // In case page is still on selection list, retry clicking li container
          const stillOnSelection = await page.locator('*:has-text("Wählen Sie aus, wie Sie sich anmelden möchten")').first().isVisible({ timeout: 2000 }).catch(() => false);
          if (stillOnSelection) {
            console.log('Still on selection list! Retrying click on li container...');
            await page.locator('li:has-text("Google Authenticator"), [role="link"]:has-text("Google Authenticator")').first().click({ force: true }).catch(() => {});
            await page.waitForTimeout(3000);
          }
        }
      }

      const totpSelector = 'input#totpPin, input[name="totpPin"], input[type="tel"], input[type="number"], input[type="text"]';
      const totpInput = page.locator(totpSelector).first();
      await totpInput.waitFor({ state: 'visible', timeout: 20000 });

      // Enter TOTP code with retry loop in case code is consumed or invalid
      for (let attempt = 1; attempt <= 2; attempt++) {
        const epoch = Math.floor(Date.now() / 1000);
        const remainingSecs = 30 - (epoch % 30);
        if (remainingSecs < 6) {
          console.log(`Only ${remainingSecs}s left in TOTP window, waiting ${remainingSecs + 1}s for fresh window...`);
          await page.waitForTimeout((remainingSecs + 1) * 1000);
        }

        const code = generateTOTP(TOTP_SECRET);
        console.log(`[Attempt ${attempt}/2] Generated fresh 6-digit TOTP code (${code}), entering...`);
        await totpInput.click();
        await totpInput.fill('');
        await totpInput.pressSequentially(code, { delay: 80 });
        await page.waitForTimeout(1000);
        await page.screenshot({ path: `step4_totp_filled_att${attempt}.png` }).catch(() => {});

        // Check "Auf diesem Gerät nicht mehr nachfragen" if present
        const trustDevice = page.locator('input[type="checkbox"], [role="checkbox"]').first();
        if (await trustDevice.isVisible({ timeout: 2000 }).catch(() => false)) {
          const isChecked = await trustDevice.isChecked().catch(() => false);
          if (!isChecked) {
            console.log('Checking "Auf diesem Gerät nicht mehr nachfragen"...');
            await trustDevice.check().catch(() => {});
          }
        }

        // Submit TOTP
        console.log('Submitting TOTP code...');
        await totpInput.press('Enter');
        await page.waitForTimeout(1000);
        const totpNext = page.locator('#totpNext button, #totpNext, button:has-text("Weiter"), button:has-text("Next")').first();
        if (await totpNext.isVisible({ timeout: 3000 }).catch(() => false)) {
          await totpNext.click().catch(() => {});
        }
        await page.waitForTimeout(6000);
        await page.screenshot({ path: `step5_after_totp_att${attempt}.png` }).catch(() => {});

        const hasErrorCode = await page.locator('*:has-text("Falscher Code"), *:has-text("Wrong code"), *:has-text("ungültig")').first().isVisible({ timeout: 1500 }).catch(() => false);
        if (!hasErrorCode) {
          console.log('TOTP code accepted!');
          break;
        }

        if (attempt < 2) {
          console.log('Google reported code invalid/consumed. Waiting 30s for next clean TOTP window before retry...');
          await page.waitForTimeout(30000);
        }
      }

      // Check for interstitial prompts like "Nicht jetzt" / "Not now" / "Passkey"
      for (let i = 0; i < 5; i++) {
        const skipBtn = page.locator('button:has-text("Nicht jetzt"), button:has-text("Überspringen"), button:has-text("Später"), button:has-text("Not now"), button:has-text("Skip")').first();
        if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log('Dismissing interstitial prompt...');
          await skipBtn.click().catch(() => {});
          await page.waitForTimeout(3000);
        }
      }

      // Wait for navigation back to LSA
      console.log('Waiting for ads.google.com navigation...');
      try {
        await page.waitForURL(url => url.hostname.includes('ads.google.com'), { timeout: 60000 });
        console.log('Successfully navigated to ads.google.com! URL:', page.url());
      } catch {
        console.log('Not yet on ads.google.com, current URL:', page.url());
        console.log('Navigating directly to INBOX_URL...');
        await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      }

      // Ensure we are on INBOX_URL
      if (!page.url().includes('/inbox')) {
        console.log('Navigating to INBOX_URL:', INBOX_URL);
        await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      }

      console.log('Current URL after login:', page.url());
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'step6_lsa_landing.png' }).catch(() => {});
      await context.storageState({ path: SESSION_PATH });
      console.log('Saved session state to', SESSION_PATH);
    }

    // Dismiss any Ads modals or dialogs if present
    const dialogCloseBtn = page.locator('[aria-label="Schließen"], [aria-label="Close"], button:has-text("Verstanden"), button:has-text("Got it")').first();
    if (await dialogCloseBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dialogCloseBtn.click().catch(() => {});
    }

    // Check if on /verification screen (e.g. Sicher account) and navigate to "Anfragen" (inbox)
    if (page.url().includes('/verification') || await page.locator('*:has-text("Unternehmensüberprüfung")').first().isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('Detected verification screen! Transitioning to "Anfragen" (inbox)...');
      await page.screenshot({ path: 'step_verification_screen.png' }).catch(() => {});

      // 1. Click hamburger menu in top-left (☰)
      console.log('Clicking hamburger menu (☰)...');
      const menuSelectors = [
        'button[aria-label*="menü" i]',
        'button[aria-label*="menu" i]',
        '[role="button"][aria-label*="menü" i]',
        '[role="button"][aria-label*="menu" i]',
        'material-button.menu-button',
        'material-button:has(material-icon[icon="menu"])',
        'material-button:has-text("menu")',
        'button:has-text("menu")',
        '[icon="menu"]',
        'material-icon:has-text("menu")',
        'i:has-text("menu")',
        '.material-icons:has-text("menu")'
      ];

      let menuClicked = false;
      for (const sel of menuSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.log(`Clicking menu button with selector: ${sel}`);
          await el.click().catch(() => {});
          menuClicked = true;
          break;
        }
      }

      if (!menuClicked) {
        console.log('Clicking hamburger icon by coordinate (32, 32)...');
        await page.mouse.click(32, 32);
      }

      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'step_menu_opened.png' }).catch(() => {});

      // 2. Click "Anfragen" in sidebar menu
      console.log('Looking for "Anfragen" in sidebar menu...');
      const anfragenSelectors = [
        'a:has-text("Anfragen")',
        'button:has-text("Anfragen")',
        '[role="menuitem"]:has-text("Anfragen")',
        '[role="link"]:has-text("Anfragen")',
        'material-select-item:has-text("Anfragen")',
        'material-list-item:has-text("Anfragen")',
        'div:has-text("Anfragen")'
      ];

      let anfragenClicked = false;
      for (const sel of anfragenSelectors) {
        const item = page.locator(sel).last();
        if (await item.isVisible({ timeout: 1500 }).catch(() => false)) {
          console.log(`Clicking Anfragen with selector: ${sel}`);
          await item.click().catch(() => {});
          anfragenClicked = true;
          break;
        }
      }

      if (!anfragenClicked) {
        console.log('Trying getByText for Anfragen...');
        const textItem = page.getByText('Anfragen', { exact: true }).first();
        if (await textItem.isVisible({ timeout: 2000 }).catch(() => false)) {
          await textItem.click().catch(() => {});
          anfragenClicked = true;
        }
      }

      if (!anfragenClicked) {
        console.log('Clicking Anfragen by coordinate (80, 80)...');
        await page.mouse.click(80, 80);
      }

      await page.waitForTimeout(5000);
      await page.screenshot({ path: 'step_inbox_loaded.png' }).catch(() => {});
      console.log('Current URL after Anfragen click:', page.url());
    }

    // Wait for the table to render
    console.log('Waiting for inbox table or download button...');
    await page.waitForSelector('button:has-text("HERUNTERLADEN"), [role="table"], table, tr', { timeout: 45000 });
    await page.waitForTimeout(4000);

    // Method A: Click HERUNTERLADEN to get official CSV
    let leads = [];
    const downloadBtn = page.locator('button:has-text("HERUNTERLADEN"), [aria-label*="Herunterladen"], [aria-label*="Download"]').first();
    if (await downloadBtn.isVisible().catch(() => false)) {
      console.log('Clicking HERUNTERLADEN button...');
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 20000 }),
          downloadBtn.click()
        ]);
        const tempPath = path.resolve(`leads_${Date.now()}.csv`);
        await download.saveAs(tempPath);
        const csvText = fs.readFileSync(tempPath, 'utf8');
        leads = parseCsv(csvText);
        console.log(`Parsed ${leads.length} leads from downloaded CSV.`);
        try { fs.unlinkSync(tempPath); } catch {}
      } catch (e) {
        console.log('CSV download click failed:', e.message);
      }
    }

    // Method B: Parse DOM Table for Anfrage-IDs & Standorte
    console.log('Inspecting DOM table for lead rows...');
    const domRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr, [role="row"]'));
      return rows.map(r => {
        const cells = Array.from(r.querySelectorAll('td, [role="cell"]')).map(c => c.innerText.trim());
        return cells;
      }).filter(cells => cells.length >= 5);
    });
    console.log(`Found ${domRows.length} DOM rows.`);

    // If CSV didn't load, use DOM rows
    if (leads.length === 0 && domRows.length > 0) {
      for (const cells of domRows) {
        // Cells: Kunde, Jobtyp, Suchintention, Standort, Art der Anfrage, Gebührenstatus, Anfrage erhalten, Letzte Aktivität, Anfrage-ID
        leads.push({
          kunde: cells[0] || '',
          jobtyp: cells[1] || '',
          standort: cells[3] || '',
          art: cells[4] || '',
          status: cells[5] || '',
          datum: cells[6] || '',
          leadId: cells[cells.length - 1] || null
        });
      }
    }

    // Match DOM Anfrage-IDs with CSV leads
    for (const dRow of domRows) {
      const dPhone = (dRow[0] || '').replace(/\D/g, '');
      const dId = dRow[dRow.length - 1] || '';
      const dLoc = dRow[3] || '';
      for (const l of leads) {
        const lPhone = (l.kunde || '').replace(/\D/g, '');
        if ((dPhone && lPhone && (dPhone.endsWith(lPhone) || lPhone.endsWith(dPhone))) || (l.kunde === dRow[0])) {
          if (dId && /^\d+$/.test(dId)) l.leadId = dId;
          if (dLoc && (!l.standort || l.standort === '-')) l.standort = dLoc;
        }
      }
    }

    console.log(`Final processed leads count: ${leads.length}`);

    // Sync with data.json
    const data = loadData();
    const existingLeads = data.leads || [];
    let updatedCount = 0;
    let newCount = 0;

    for (const lead of leads) {
      const normPhone = normalizePhone(lead.kunde);
      
      // Match by leadId or phone
      let matched = existingLeads.find(l => {
        if (lead.leadId && l.googleLeadId && String(l.googleLeadId) === String(lead.leadId)) return true;
        if (normPhone && l.Telefon && normalizePhone(l.Telefon) === normPhone) return true;
        return false;
      });

      if (matched) {
        // Update location if it was missing or default
        if (lead.standort && lead.standort !== '-' && matched.Konum !== lead.standort) {
          console.log(`Updating location for ${matched.Musteri || matched.Telefon}: ${matched.Konum} -> ${lead.standort}`);
          matched.Konum = lead.standort;
          updatedCount++;
        }
        // If telegram wasn't sent yet, send it with the real location!
        if (!matched.telegramSent) {
          console.log(`Sending pending Telegram alert for ${matched.Musteri || matched.Telefon} with Ort: ${matched.Konum}`);
          await sendTelegram({
            kunde: matched.Musteri || matched.Telefon,
            standort: matched.Konum,
            datum: matched.Tarih,
            jobtyp: matched.Hizmet,
            status: matched.leadStatus,
            art: matched.leadType === 'MESSAGE' ? 'Nachricht' : 'Telefon',
            leadId: matched.googleLeadId
          });
          matched.telegramSent = true;
          updatedCount++;
        }
      } else {
        // Brand new lead found from web inbox
        console.log(`New lead from web inbox: ${lead.kunde} (${lead.standort}) - ${lead.art}`);
        const newLeadObj = {
          id: `lsa:web:${CUSTOMER_ID}:${lead.leadId || Date.now()}`,
          Musteri: lead.kunde || 'Kunde',
          Telefon: lead.kunde?.match(/\d{4,}/) ? lead.kunde : null,
          Telefon2: null,
          Hizmet: lead.jobtyp || '-',
          Konum: lead.standort && lead.standort !== '-' ? lead.standort : '-',
          Tarih: lead.datum || '-',
          Mesaj: '-',
          conversations: [],
          conversationCount: 0,
          lastConversationId: null,
          telegramSent: false,
          googleLeadId: lead.leadId || null,
          leadType: lead.art?.toLowerCase().includes('telefon') ? 'PHONE_CALL' : 'MESSAGE',
          leadStatus: lead.status || 'ACTIVE'
        };

        // Send Telegram immediately
        await sendTelegram(lead);
        newLeadObj.telegramSent = true;
        existingLeads.unshift(newLeadObj);
        newCount++;
      }
    }

    if (updatedCount > 0 || newCount > 0) {
      console.log(`Saving data.json: ${newCount} new leads, ${updatedCount} updated.`);
      data.updatedAt = new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
      saveData(data);
    } else {
      console.log('No new leads or location changes.');
    }

  } catch (err) {
    console.error('Scraper error:', err);
    // Take screenshot on error for debugging
    try {
      await page.screenshot({ path: 'error_screenshot.png' });
      console.log('Saved error screenshot to error_screenshot.png');
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('Browser closed. Scraper run finished.');
  }
}

run();
