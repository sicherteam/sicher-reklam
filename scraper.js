require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

puppeteer.use(StealthPlugin());

// --- MOD KONTROLLERİ (AÇ / KAPAT) ---
const SKIP_TELEGRAM = false; // true yapılırsa Telegram bildirimi atmaz
const SKIP_GIT_PUSH = false;  // true yapılırsa GitHub'a push yapmaz

// --- CONFIGURATION (OSMAN REKLAM) ---
const CONFIG = {
  projectName: 'Osman Reklam',
  userDataPath: '/home/yasin2celik/osman-reklam/user_data',
  targetUrl: 'https://ads.google.com/localservices/inbox?cid=2903573653&bid=10985702078&pid=9999999999&euid=3547106212&hl=de-AT&gl=AT',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
};

// 🔹 Tarih Normalizasyonu (YY ve YYYY farkını yok eder: "2026-07-29 14:30" yapar)
function normalizeDateForMd5(dateStr) {
  if (!dateStr || dateStr === '-') return '';
  const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{2,4})\s+(\d{2}):(\d{2})/);
  if (!match) return dateStr.replace(/\D/g, ''); // RegEx fallback
  
  let [, day, month, year, hour, minute] = match;
  if (year.length === 2) year = `20${year}`;
  
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

// 🔹 MD5 Hash Üretici (Normalize Edilmiş Tarih İle)
function generateLeadMd5(lead) {
  const musteri = (lead.Musteri || lead.phone || '').trim().toLowerCase();
  const hizmet = (lead.Hizmet || lead.jobType || '').trim().toLowerCase();
  const konum = (lead.Konum || lead.location || '').trim().toLowerCase();
  const tarih = normalizeDateForMd5(lead.Tarih || lead.anfrageDate || '');

  const rawString = `${musteri}|${hizmet}|${konum}|${tarih}`;
  return crypto.createHash('md5').update(rawString).digest('hex');
}

// Native Fetch API ile Telegram Bildirimi
async function sendTelegramMessage(lead) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
    console.warn("⚠️ Telegram API bilgileri eksik (.env)");
    return false;
  }

  // 🔹 Eğer Müşteri alanından bağımsız olarak ayrıştırılmış telefon numarası varsa ekler
  const phoneText = lead["Telefon"] ? `\n📞 *Telefon:* ${lead["Telefon"]}` : '';

  const message = `🔔 *YENİ Müşteri!* (${CONFIG.projectName})\n\n` +
                  `👤 *Müşteri:* ${lead["Musteri"]}${phoneText}\n` +
                  `📍 *Konum:* ${lead["Konum"]}\n` +
                  `💼 *Hizmet:* ${lead["Hizmet"]}\n` +
                  `📅 *Tarih:* ${lead["Tarih"]}\n` +
                  `💬 *Mesaj:* ${lead["Mesaj"]}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.telegramChatId,
        text: message,
        parse_mode: 'Markdown'
      })
    });
    return res.ok;
  } catch (err) {
    console.error('⚠️ Telegram mesaj hatası:', err.message);
    return false;
  }
}

// 24-Hour Strict Date Formatter (Viyana / UTC+2 Offset Destekli)
function parseTo24HourDate(dateStr) {
  if (!dateStr || dateStr === '-') return '-';

  const fixedStr = dateStr.replace(/(\b\d{1,2})(\d{2})\s*(AM|PM)/gi, '$1:$2 $3');
  const match = fixedStr.match(/(\d{2}\.\d{2}\.\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return dateStr;

  let [, datePart, hoursStr, minutes, modifier] = match;
  let hours = parseInt(hoursStr, 10);

  // 1. AM/PM Dönüşümü
  if (modifier) {
    const isPM = modifier.toUpperCase() === 'PM';
    const isAM = modifier.toUpperCase() === 'AM';
    if (isPM && hours < 12) hours += 12;
    if (isAM && hours === 12) hours = 0;
  }

  // 2. Sunucu saat farkı (+2 Saat Offset)
  hours += 2;
  hours = hours % 24;

  return `${datePart} ${String(hours).padStart(2, '0')}:${minutes}`;
}

// Tarih Metnini Sıralama İçin Milisaniyeye Çeviren Fonksiyon
function parseDateForSorting(dateStr) {
  if (!dateStr || dateStr === '-') return 0;
  const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{2,4})\s+(\d{2}):(\d{2})/);
  if (!match) return 0;
  let [, day, month, year, hour, minute] = match;
  if (year.length === 2) year = `20${year}`;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:00`).getTime();
}

// Clear Chrome Locks
function clearChromeLocks() {
  const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  locks.forEach(lock => {
    const lockPath = path.join(CONFIG.userDataPath, lock);
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  });
}

// --- MAIN EXECUTION ---
(async () => {
  let freshLeads = [];
  const sessionIds = new Set(); // 🔹 Aynı çalıştırmadaki duplicate'leri engellemek için Set

  // ESKİ KAYITLARI YÜKLE
  let previousLeads = [];
  if (fs.existsSync('data.json')) {
    try {
      const oldContent = JSON.parse(fs.readFileSync('data.json', 'utf8'));
      previousLeads = oldContent.leads || [];
    } catch (e) {
      console.warn("⚠️ Eski data.json okunamadı:", e.message);
    }
  }

  // ===================================================
  // 1. BÖLÜM: TARAYICI İŞLEMLERİ (Sadece Veri Toplama)
  // ===================================================
  let browser;
  try {
    clearChromeLocks();

    browser = await puppeteer.launch({
      headless: "new",
      executablePath: '/usr/bin/google-chrome',
      userDataDir: CONFIG.userDataPath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        '--lang=de-AT,de',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-extensions',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
        '--disable-breakpad'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(60000);

    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // 🌐 OPTİMİZASYON 1: GELİŞMİŞ AĞ/KAYNAK ENGELLEME
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url().toLowerCase();
      const resourceType = req.resourceType();

      if (
        ['image', 'stylesheet', 'font', 'media'].includes(resourceType) ||
        url.includes('google-analytics') ||
        url.includes('analytics') ||
        url.includes('doubleclick') ||
        url.includes('favicon')
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log("🚀 LSA Inbox sayfasına gidiliyor...");
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2' });

    const pageTitle = await page.title();
    console.log("Sayfa Başlığı:", pageTitle);

    if (/Anmelden|Sign in|YouTube|Error|504|Serverfehler/i.test(pageTitle)) {
      throw new Error(`❌ Oturum açılamadı veya Google engelledi! Başlık: ${pageTitle}`);
    }

    await page.evaluate(async () => {
      for (let i = 0; i < 4; i++) {
        window.scrollBy(0, 300);
        await new Promise(r => setTimeout(r, 200));
      }
    });
    await new Promise(r => setTimeout(r, 1500));

    // TABLO VERİLERİNİ ÇEKME
    const validRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[role="row"], tr'));

      return rows.map((row, idx) => {
        const rawCells = Array.from(row.querySelectorAll('td, div[role="gridcell"]'));
        const cells = rawCells.map(c => c.innerText?.trim() || '').filter(Boolean);

        if (cells.length < 4) return null;
        if (/Gebührenstatus|Kunde|Kundenname/i.test(row.innerText || '')) return null;

        let customerName = cells[0] || '-';
        const jobType = cells[1] || '-';

        if (/Google|Lokale Dienstleistungen|Potenzieller Kunde/i.test(customerName)) {
          customerName = '-';
        }

        if (/^\d+$/.test(customerName) && /^\d+$/.test(jobType)) return null;
        if (/^\d{1,3}$/.test(customerName)) return null;

        let location = cells[3] || '-';
        if (!location || location === '-' || location.length <= 2 || location === jobType || /^\+?\d[\d\s-]{6,}$/.test(location)) {
          location = cells.find((t, i) => 
            i > 1 && 
            t.length > 2 && 
            t !== customerName && 
            t !== jobType && 
            !/^\+?\d[\d\s-]{6,}$/.test(t) && 
            !/^(Kategorie|Direkte|Telefon|Nachricht|Belastet|Wird)/i.test(t) &&
            !/\d{2}\.\d{2}\.\d{2}/.test(t)
          ) || '-';
        }

        const dates = cells.filter(t => /\d{2}\.\d{2}\.\d{2}/.test(t));
        const hasNoCustomerName = !customerName || customerName === '-';
        const isExplicitMessage = /nachricht|message/i.test(row.innerText || '');

        return {
          domIndex: idx,
          phone: customerName,
          jobType,
          location,
          anfrageDate: dates[0] || '-',
          isMessage: isExplicitMessage || hasNoCustomerName
        };
      }).filter(Boolean);
    });

    console.log(`📊 Çekilen Temiz Lead Sayısı: ${validRows.length}`);

    if (validRows.length === 0) {
      throw new Error("❌ Hiç veri bulunamadı! Sayfa yüklenemedi veya Google yapıyı değiştirdi.");
    }

    // MESAJ VE TELEFON ARAMALARINI İŞLEME
    for (const item of validRows) {
      let messageText = "-";
      let finalCustomerName = item.phone;
      let panelPhone = null; // 🔹 Panel açıldığında tespit edilecek telefon numarası

      // 1. Saat Dönüşümü ve Ön-MD5 Üretimi
      const formattedDate = parseTo24HourDate(item.anfrageDate);
      let tempCustomerName = (!finalCustomerName || finalCustomerName.trim() === '-' || finalCustomerName === '') ? 'Müşteri' : finalCustomerName;
      
      const tempLead = {
        Musteri: tempCustomerName,
        Hizmet: item.jobType,
        Konum: item.location,
        Tarih: formattedDate
      };

      const currentMd5 = generateLeadMd5(tempLead);

      // 🔹 AYNİ ÇALIŞTIRMADA DUPLICATE KONTROLÜ (Session Check)
      if (sessionIds.has(currentMd5)) {
        console.log(`⚠️ Aynı çalıştırmada duplicate atlandı: ${tempCustomerName} (${currentMd5})`);
        continue;
      }

      // 🚀 OPTİMİZASYON 2: DÖNGÜ BAŞINDA ESKİ KAYIT (TELEFON VEYA MESAJ) KONTROLÜ
      const existingLead = previousLeads.find(old => old.id === currentMd5);

      if (existingLead) {
        console.log(`⚡ [SKIP] Eski kayıt (Telefon/Mesaj) atlandı: ${existingLead.Musteri} (${currentMd5})`);
        sessionIds.add(currentMd5);
        freshLeads.push(existingLead);
        continue; // 🛑 Tıklama yapılmadan doğrudan bir sonraki kayda geçer!
      }

      // 2. SADECE YENİ MESAJLI KAYITLAR İÇİN TIKLAMA VE DETAY OKUMA
      if (item.isMessage) {
        try {
          console.log(`📩 Yeni mesaj detayı okunuyor (Index: ${item.domIndex})...`);
          await page.evaluate((index) => {
            const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
            const row = rows[index];
            if (row) (row.querySelector('td, div[role="gridcell"]') || row).click();
          }, item.domIndex);

          await new Promise(r => setTimeout(r, 5000));

          const panelData = await page.evaluate(() => {
            let msg = "-";
            let nameInHeader = null;
            let extractedPhone = null;

            // A) Mesaj Metnini Okuma
            const chatBlock = Array.from(document.querySelectorAll('div, section, article'))
                                   .find(el => (el.innerText || '').includes('Unterhaltung'));
            
            if (chatBlock) {
              let text = chatBlock.innerText.split('Unterhaltung').pop();
              msg = text.split('Wird geladen')[0]
                         .split('Audioinhalte')[0]
                         .split('Hier dem Kunden')[0]
                         .replace(/^P\s+|^Potenzieller Kunde\s+|^\d{2}\.\d{2}\.\d{2}\s+/gi, '')
                         .trim() || "NO MESSAGE";
            }

            // B) Üst Panel Header Alanından Telefon ve İsim Taraması
            const headerBar = Array.from(document.querySelectorAll('div, header'))
                                   .find(el => (el.innerText || '').includes('ARCHIVIEREN') || (el.innerText || '').includes('MARKIEREN'));
            if (headerBar) {
              const headerText = headerBar.innerText || '';

              // 🔹 1. Telefon Numarası Taraması (+43, +90, 0660 vb. uluslararası/yerel kalıplar)
              const phoneMatch = headerText.match(/\+?\d[\d\s\/-]{7,}/);
              if (phoneMatch) {
                extractedPhone = phoneMatch[0].trim();
              }

              // 🔹 2. İsim Taraması
              const lines = headerText.split('\n').map(l => l.trim()).filter(Boolean);
              if (lines.length > 0 && !lines[0].includes('ARCHIVIEREN')) {
                const candidate = lines[0].split('|')[0].trim();
                if (!/Google|Lokale|Dienstleistungen|Potenzieller|Anrufer/i.test(candidate)) {
                  nameInHeader = candidate;
                }
              }
            }

            return { msg, nameInHeader, extractedPhone };
          });

          messageText = panelData.msg;
          panelPhone = panelData.extractedPhone;

          if ((finalCustomerName === '-' || !finalCustomerName) && panelData.nameInHeader) {
            finalCustomerName = panelData.nameInHeader;
          }

        } catch (e) {
          console.warn(`[${item.phone}] Mesaj okuma uyarısı:`, e.message);
        }
      }

      // 🔹 İsim bulunamazsa panelden çıkan telefonu, o da yoksa 'Müşteri' kelimesini atar
      if (!finalCustomerName || finalCustomerName.trim() === '-' || finalCustomerName === '') {
        finalCustomerName = panelPhone || 'Müşteri';
      }

      const leadObj = {
        "Musteri": finalCustomerName,
        "Telefon": panelPhone || (item.phone !== '-' && /^\+?\d[\d\s-]{6,}$/.test(item.phone) ? item.phone : null),
        "Hizmet": item.jobType,
        "Konum": item.location,
        "Tarih": formattedDate,
        "Mesaj": messageText,
        "id": currentMd5
      };

      sessionIds.add(currentMd5);
      freshLeads.push(leadObj);
    }

  } catch (error) {
    console.error("💥 Scraper hatası:", error.message);
    process.exitCode = 1;
  } finally {
    if (browser) {
      try {
        console.log("🛑 Tarayıcı kapatılıyor, RAM serbest bırakıldı...");
        await browser.close();
      } catch (_) {}
    }
  }

  // ===================================================
  // 2. BÖLÜM: BİLDİRİM, SIRALAMA VE GİTHUB İŞLEMLERİ
  // ===================================================
  if (freshLeads.length > 0) {
    console.log("⚙️ Veriler işleniyor...");

    const leads = freshLeads.map(newLead => {
      const existing = previousLeads.find(old => old.id === newLead.id);
      
      return {
        ...newLead,
        telegramSent: existing ? (existing.telegramSent || false) : false
      };
    });

    // Tarihe Göre Sıralama
    leads.sort((a, b) => parseDateForSorting(b["Tarih"]) - parseDateForSorting(a["Tarih"]));

    const unsentLeads = leads.filter(l => !l.telegramSent);
    console.log(`🔎 İnceleme Tamamlandı. Bildirim Gitmemiş Yeni Lead Sayısı: ${unsentLeads.length}`);

    const hasNewEntry = leads.some(l => !previousLeads.some(p => p.id === l.id));

    if (unsentLeads.length > 0 || hasNewEntry) {
      
      // TELEGRAM GÖNDERİM KONTROLÜ
      if (SKIP_TELEGRAM) {
        console.log("⏭️ SKIP_TELEGRAM = true (Telegram bildirimi atlanıyor).");
      } else {
        for (const leadToNotify of unsentLeads) {
          const isSuccess = await sendTelegramMessage(leadToNotify);
          if (isSuccess) {
            leadToNotify.telegramSent = true;
            console.log(`📱 Telegram bildirimi gönderildi: ${leadToNotify["Musteri"]} (MD5: ${leadToNotify.id})`);
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      const outputData = {
        updatedAt: new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }),
        leads
      };

      fs.writeFileSync('data.json', JSON.stringify(outputData, null, 2));
      console.log(`💾 data.json tarihe göre sıralandı ve kaydedildi.`);

      // GIT PUSH KONTROLÜ
      if (SKIP_GIT_PUSH) {
        console.log("⏭️ SKIP_GIT_PUSH = true (Git Push atlanıyor).");
      } else {
        try {
          console.log("⏳ GitHub Sync Yapılıyor...");
          execSync('git add data.json', { timeout: 15000 });
          execSync('git commit -m "Auto-update & sort data.json [skip ci]" || true', { timeout: 15000 });
          execSync('git pull origin main --rebase -X ours', { timeout: 20000 });
          execSync('git push origin main', { timeout: 20000 });
          console.log("✅ Git Push Başarılı!");

        } catch (gitErr) {
          console.error("⚠️ Git push hatası:", gitErr.message);
        }
      }
    } else {
      console.log("ℹ️ Yeni müşteri veya gönderilmemiş bildirim yok.");
    }
  }
})();
