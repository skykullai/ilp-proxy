const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());

// ── Launch a single shared browser instance ────────────────────────────────
let browser;
(async () => {
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  console.log('Browser ready');
})();

// ── Helper: fetch fully-rendered HTML + all img srcs via browser ───────────
async function fetchRenderedHtml(permitId) {
  const url = `https://ilp.mizoram.gov.in/pass-verification/${permitId}`;
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('body', { timeout: 10000 });

    const imgSrcs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img')).map(img => img.src)
    );

    const html = await page.content();
    return { html, url, imgSrcs };
  } finally {
    await page.close();
  }
}

// ── Fetch image as base64 using the browser's session cookies ─────────────
async function fetchImageAsBase64(imageUrl) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    await page.goto('https://ilp.mizoram.gov.in/', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    const result = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) return { error: `HTTP ${resp.status}` };
        const contentType = resp.headers.get('content-type') || 'image/jpeg';
        const buffer = await resp.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        return { base64, contentType };
      } catch (e) {
        return { error: e.message };
      }
    }, imageUrl);

    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    await page.close();
  }
}

// ── Pick the passport photo from DOM img list ─────────────────────────────
function pickPhoto(imgSrcs) {
  if (!imgSrcs || imgSrcs.length === 0) return null;

  for (const src of imgSrcs) {
    if (src.includes('applicant-passport-size-photo') || src.includes('/storage/')) {
      return src;
    }
  }

  const skip = ['logo', 'flag', 'icon', 'banner', 'header', 'footer', 'emblem', 'coat'];
  for (const src of imgSrcs) {
    const lower = src.toLowerCase();
    if (skip.some(s => lower.includes(s))) continue;
    if (lower.includes('upload') || lower.includes('photo') ||
        lower.includes('applicant') || lower.includes('image') ||
        lower.match(/\.(jpg|jpeg|png|webp)/)) {
      return src;
    }
  }

  return null;
}

// ── Parse the rendered HTML for text fields ───────────────────────────────
function parseHtml(html) {
  const text = html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  const parts = text.split('|').map(s => s.trim()).filter(Boolean);

  const findAfter = (label) => {
    const idx = parts.findIndex(p => p.toLowerCase() === label.toLowerCase());
    if (idx === -1 || idx + 1 >= parts.length) return null;
    return parts[idx + 1];
  };

  const rawField = (label) => {
    const rx = new RegExp(label + '[\\s\\S]{0,300}?<[^>]+>([^<]{2,100})<', 'i');
    const m = rx.exec(html);
    return m ? m[1].trim() : null;
  };

  let passType = 'REGULAR PASS';
  const ptMatch = html.match(/(REGULAR PASS|PROTECTED AREA PERMIT|SPECIAL PERMIT)/i);
  if (ptMatch) passType = ptMatch[1].toUpperCase();

  const get = (label, ...aliases) => {
    for (const l of [label, ...aliases]) {
      const v = findAfter(l) || rawField(l);
      if (v && v.length > 1 && v.length < 200) return v;
    }
    return null;
  };

  return {
    passType,
    name:              get('Name'),
    issuedDate:        get('Issued Date', 'Issue Date', 'Date of Issue'),
    status:            get('Status'),
    validity:          get('Validity', 'Valid Till', 'Valid Upto'),
    transactionId:     get('Transaction Fee ID', 'Transaction ID'),
    transactionAmount: get('Transaction Fee Amount', 'Amount'),
  };
}

// ── /ilp/:permitId ────────────────────────────────────────────────────────
app.get('/ilp/:permitId', async (req, res) => {
  const permitId = req.params.permitId.trim().toUpperCase();
  try {
    const { html, url, imgSrcs } = await fetchRenderedHtml(permitId);
    const fields      = parseHtml(html);
    const rawPhotoUrl = pickPhoto(imgSrcs);

    if (!fields.name) {
      return res.status(404).json({ error: 'Permit not found. Check the ID and try again.' });
    }

    let photoUrl = null;
    if (rawPhotoUrl) {
      try {
        const { base64, contentType } = await fetchImageAsBase64(rawPhotoUrl);
        photoUrl = `data:${contentType};base64,${base64}`;
      } catch (imgErr) {
        console.warn('Photo fetch failed, falling back to raw URL:', imgErr.message);
        photoUrl = rawPhotoUrl;
      }
    }

    res.json({
      permitId,
      govtUrl:           url,
      passType:          fields.passType,
      name:              fields.name,
      issuedDate:        fields.issuedDate        || '',
      status:            fields.status            || '',
      validity:          fields.validity          || '',
      transactionId:     fields.transactionId     || null,
      transactionAmount: fields.transactionAmount || null,
      photoUrl,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Failed to fetch: ${err.message}` });
  }
});

// ── /photo — proxy a govt image URL ──────────────────────────────────────
app.get('/photo', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith('https://ilp.mizoram.gov.in/')) {
    return res.status(400).json({ error: 'Invalid or missing url parameter' });
  }
  try {
    const { base64, contentType } = await fetchImageAsBase64(url);
    const buf = Buffer.from(base64, 'base64');
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (err) {
    console.error('Photo proxy error:', err.message);
    res.status(502).json({ error: `Could not fetch image: ${err.message}` });
  }
});

// ── /imgdebug/:permitId ───────────────────────────────────────────────────
app.get('/imgdebug/:permitId', async (req, res) => {
  const permitId = req.params.permitId.trim().toUpperCase();
  try {
    const { imgSrcs } = await fetchRenderedHtml(permitId);
    res.json({ total: imgSrcs.length, images: imgSrcs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /debug/:permitId ──────────────────────────────────────────────────────
app.get('/debug/:permitId', async (req, res) => {
  const permitId = req.params.permitId.trim().toUpperCase();
  try {
    const { html } = await fetchRenderedHtml(permitId);
    res.send(html);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(3000, () => console.log('ILP proxy running on port 3000'));
