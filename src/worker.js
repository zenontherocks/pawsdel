// Paws Delivered — Cloudflare Worker (single-file backend)
//
// Entrypoints:
//   • fetch     — handles every HTTP request
//   • scheduled — two cron triggers (see wrangler.toml):
//       */5  * * * *  — expire unpaid pending orders
//       */30 * * * *  — sync listings from pbtmarketplace.com
//
// No user accounts, no on-chain anything. Payment is CashApp only for now,
// confirmed manually by an admin from the console (CashApp has no public
// API to verify an individual payment landed). orders.payment_method plus
// the generic `settings` table are the extension points for adding other
// payment methods later without a schema change.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }
    const response = await env.ASSETS.fetch(request);
    if (url.pathname.startsWith('/admin')) {
      const headers = new Headers(response.headers);
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      return new Response(response.body, { status: response.status, headers });
    }
    if (response.status === 404) {
      const tryUrl = new URL(url.toString());
      if (!tryUrl.pathname.includes('.')) {
        tryUrl.pathname = tryUrl.pathname.replace(/\/$/, '') + '.html';
        const htmlResponse = await env.ASSETS.fetch(new Request(tryUrl.toString()));
        if (htmlResponse.status !== 404) return htmlResponse;
      }
      url.pathname = '/index.html';
      return env.ASSETS.fetch(new Request(url.toString()));
    }
    return response;
  },

  async scheduled(event, env, ctx) {
    if (event.cron === '*/5 * * * *') {
      await expireOrders(env);
    } else if (event.cron === '*/30 * * * *') {
      await syncPbtListings(env);
    }
  }
};

// ── Router ────────────────────────────────────────────────────────────────────

async function handleApi(request, env, url) {
  // Pets
  if (url.pathname === '/api/pets' && request.method === 'GET') {
    return handleListPets(request, env, url);
  }
  const petMatch = url.pathname.match(/^\/api\/pets\/([a-zA-Z0-9-]+)$/);
  if (petMatch && request.method === 'GET') {
    return handleGetPet(request, env, petMatch[1]);
  }
  const petOrderMatch = url.pathname.match(/^\/api\/pets\/([a-zA-Z0-9-]+)\/order$/);
  if (petOrderMatch && request.method === 'POST') {
    return handleCreateOrder(request, env, petOrderMatch[1]);
  }

  // Orders
  const orderMatch = url.pathname.match(/^\/api\/orders\/([a-zA-Z0-9-]+)$/);
  if (orderMatch && request.method === 'GET') {
    return handleGetOrder(request, env, orderMatch[1]);
  }
  const markPaidMatch = url.pathname.match(/^\/api\/orders\/([a-zA-Z0-9-]+)\/mark-paid$/);
  if (markPaidMatch && request.method === 'POST') {
    return handleMarkOrderPaid(request, env, markPaidMatch[1]);
  }

  // Admin: settings
  if (url.pathname === '/api/admin/settings') {
    if (request.method === 'GET') return handleAdminSettingsGet(request, env, url);
    if (request.method === 'PUT') return handleAdminSettingsPut(request, env, url);
  }

  // Admin: seller blacklist
  if (url.pathname === '/api/admin/seller-blacklist') {
    if (request.method === 'GET')  return handleBlacklistGet(request, env, url);
    if (request.method === 'POST') return handleBlacklistAdd(request, env, url);
  }
  const blMatch = url.pathname.match(/^\/api\/admin\/seller-blacklist\/([^/]+)$/);
  if (blMatch && request.method === 'DELETE') {
    return handleBlacklistRemove(request, env, url, blMatch[1]);
  }

  // Admin: orders
  if (url.pathname === '/api/admin/orders' && request.method === 'GET') {
    return handleAdminOrders(request, env, url);
  }
  const confirmMatch = url.pathname.match(/^\/api\/admin\/orders\/([a-zA-Z0-9-]+)\/confirm-payment$/);
  if (confirmMatch && request.method === 'POST') {
    return handleConfirmPayment(request, env, url, confirmMatch[1]);
  }
  const adminOrderMatch = url.pathname.match(/^\/api\/admin\/orders\/([a-zA-Z0-9-]+)$/);
  if (adminOrderMatch && request.method === 'GET') {
    return handleAdminOrderDetail(request, env, url, adminOrderMatch[1]);
  }

  // Admin: debug / manual triggers (TEMPORARY — remove once the worming
  // regex in pbtScrapeDetail is verified against real pbtmarketplace.com
  // markup, same as bitcoin-pets did for its own sex/photo scraping bugs)
  if (url.pathname === '/api/admin/pbt-debug' && request.method === 'GET') {
    return handlePbtDebug(request, env, url);
  }
  if (url.pathname === '/api/admin/pbt-sync-now' && request.method === 'GET') {
    return handlePbtSyncNow(request, env, url);
  }

  return json({ error: 'Not found' }, 404);
}

// ── Admin auth & settings helpers ────────────────────────────────────────────

function checkAdminToken(request, env, url) {
  const token = env.ADMIN_TOKEN;
  if (!token) return false; // no secret configured — deny, don't fail open
  return url.searchParams.get('token') === token;
}

// Fetches a fixed set of settings keys in one query, defaulting missing rows
// to ''. Used everywhere a handler needs one or more `settings` values —
// pricing, CashApp config, company/waybill info, or the scraper's own
// pbtmarketplace.com login (admin-console-configurable, not a Worker secret).
async function getSettingsMap(env, keys) {
  const placeholders = keys.map(() => '?').join(',');
  const rows = await env.DB.prepare(`
    SELECT key, value FROM settings WHERE key IN (${placeholders})
  `).bind(...keys).all();
  const map = {};
  for (const k of keys) map[k] = '';
  for (const row of (rows.results || [])) map[row.key] = row.value;
  return map;
}

// ── Pet handlers ──────────────────────────────────────────────────────────────

async function handleListPets(request, env, url) {
  const species = url.searchParams.get('species') || '';
  const page    = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit   = 24;
  const offset  = (page - 1) * limit;

  const speciesFilter = species ? 'AND p.species = ?' : '';
  const binds = species ? [species, limit + 1, offset] : [limit + 1, offset];
  const countBinds = species ? [species] : [];

  const [rows, countRow, settings] = await Promise.all([
    env.DB.prepare(`
      SELECT p.id, p.name, p.species, p.breed, p.gender, p.price_usd, p.created_at,
             p.date_of_birth, p.weight_lbs,
             pp.url AS photo_url
      FROM pets p
      LEFT JOIN pet_pictures pp ON pp.pet_id = p.id AND pp.is_primary = 1
      WHERE p.status = 'available' ${speciesFilter}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...binds).all(),
    env.DB.prepare(`
      SELECT COUNT(*) AS total FROM pets p WHERE p.status = 'available' ${speciesFilter}
    `).bind(...countBinds).first(),
    getSettingsMap(env, ['markup_usd']),
  ]);

  const markup = parseFloat(settings.markup_usd) || 0;
  const pets = (rows.results || []).map(p => ({ ...p, price_usd: p.price_usd + markup }));
  const hasMore = pets.length > limit;
  return json({ pets: hasMore ? pets.slice(0, limit) : pets, hasMore, page, total: countRow?.total ?? 0 });
}

async function handleGetPet(request, env, id) {
  // Explicit column list, not SELECT * — pbt_url/pbt_seller are internal
  // sourcing info with no buyer-facing purpose and are never exposed.
  // pbt_id itself is shown (dedup/reference id), same as bitcoin-pets.
  const pet = await env.DB.prepare(`
    SELECT id, pbt_id, name, species, breed, date_of_birth, weight_lbs, gender,
           color, vaccinations, worming, registry_name, price_usd, status,
           created_at, updated_at
    FROM pets WHERE id = ?
  `).bind(id).first();

  if (!pet) return json({ error: 'Not found' }, 404);

  const [pics, activeOrder, settings] = await Promise.all([
    env.DB.prepare(
      'SELECT url, is_primary FROM pet_pictures WHERE pet_id = ? ORDER BY is_primary DESC'
    ).bind(id).all(),
    pet.status === 'pending'
      ? env.DB.prepare(
          "SELECT expires_at FROM orders WHERE pet_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1"
        ).bind(id).first()
      : Promise.resolve(null),
    getSettingsMap(env, ['markup_usd']),
  ]);

  const markup = parseFloat(settings.markup_usd) || 0;
  const displayPet = { ...pet, price_usd: pet.price_usd + markup };
  return json({ pet: displayPet, photos: pics.results || [], order_expires_at: activeOrder?.expires_at ?? null });
}

// ── Orders & checkout (CashApp, manual admin confirmation) ──────────────────

function generatePaymentRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'PD-' + s;
}

// Creates a pending order with CashApp payment instructions. Buyer marks it
// "sent" themselves (handleMarkOrderPaid) but that never flips status —
// only an admin's manual confirm (handleConfirmPayment) does, since CashApp
// has no API this Worker can poll to verify a payment actually landed.
async function handleCreateOrder(request, env, petId) {
  const pet = await env.DB.prepare(
    'SELECT id, name, status, price_usd FROM pets WHERE id = ?'
  ).bind(petId).first();

  if (!pet) return json({ error: 'Listing not found' }, 404);
  if (pet.status !== 'available') return json({ error: 'This listing is no longer available' }, 409);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { buyer_name, buyer_email, buyer_phone, buyer_address1, buyer_address2,
          buyer_city, buyer_state, buyer_zip, buyer_country } = body;

  if (!buyer_name || !buyer_email || !buyer_phone || !buyer_address1 ||
      !buyer_city || !buyer_state || !buyer_zip) {
    return json({ error: 'Name, email, phone, and shipping address are required' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer_email)) {
    return json({ error: 'Invalid email address' }, 400);
  }
  const textFields = { buyer_name, buyer_phone, buyer_address1, buyer_address2, buyer_city, buyer_state, buyer_zip };
  for (const [field, value] of Object.entries(textFields)) {
    if (value && value.length > 200) {
      return json({ error: `${field} is too long` }, 400);
    }
  }

  // Atomically claim the pet before doing any further work, so two
  // concurrent checkouts for the same pet can't both pass the earlier
  // status check and each walk away with a valid, independently-payable order.
  const claim = await env.DB.prepare(
    "UPDATE pets SET status='pending', updated_at=datetime('now') WHERE id=? AND status='available'"
  ).bind(petId).run();
  if (!claim.meta || claim.meta.changes === 0) {
    return json({ error: 'This listing is no longer available' }, 409);
  }

  async function releaseClaim() {
    await env.DB.prepare(
      "UPDATE pets SET status='available', updated_at=datetime('now') WHERE id=? AND status='pending'"
    ).bind(petId).run();
  }

  const settings = await getSettingsMap(env, ['cashapp_cashtag', 'cashapp_note', 'markup_usd']);
  if (!settings.cashapp_cashtag) {
    await releaseClaim();
    return json({ error: 'Payment system not configured. Please contact support.' }, 503);
  }
  const markup = parseFloat(settings.markup_usd) || 0;
  const amount_usd = Math.round((pet.price_usd + markup) * 100) / 100;

  const orderId    = crypto.randomUUID();
  const paymentRef = generatePaymentRef();
  // 24h, not bitcoin-pets' 2h — there's no address-reuse risk driving
  // urgency here, and the buyer has to leave the site to pay while an admin
  // has to notice and confirm, so a longer window avoids needless listing churn.
  const expiresAt  = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(`
    INSERT INTO orders (id, pet_id, payment_method, amount_usd, payment_ref, expires_at,
      buyer_name, buyer_email, buyer_phone, buyer_address1, buyer_address2,
      buyer_city, buyer_state, buyer_zip, buyer_country)
    VALUES (?, ?, 'cashapp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    orderId, petId, amount_usd, paymentRef, expiresAt,
    buyer_name.trim(), buyer_email.trim().toLowerCase(), buyer_phone.trim(),
    buyer_address1.trim(), buyer_address2 ? buyer_address2.trim() : null,
    buyer_city.trim(), buyer_state.trim(), buyer_zip.trim(),
    buyer_country || 'US'
  ).run();

  return json({
    order: {
      id: orderId, amount_usd, payment_ref: paymentRef, expires_at: expiresAt,
      pet_name: pet.name, cashapp_cashtag: settings.cashapp_cashtag, cashapp_note: settings.cashapp_note,
    }
  }, 201);
}

async function handleGetOrder(request, env, orderId) {
  const order = await env.DB.prepare(
    'SELECT id, pet_id, payment_method, amount_usd, payment_ref, status, expires_at, marked_paid_at, paid_at FROM orders WHERE id=?'
  ).bind(orderId).first();
  if (!order) return json({ error: 'Order not found' }, 404);

  let cashapp = {};
  if (order.payment_method === 'cashapp' && order.status === 'pending') {
    const settings = await getSettingsMap(env, ['cashapp_cashtag', 'cashapp_note']);
    cashapp = { cashapp_cashtag: settings.cashapp_cashtag, cashapp_note: settings.cashapp_note };
  }
  return json({ order: { ...order, ...cashapp } });
}

// Buyer's own "I've sent payment" acknowledgement — flags the order for the
// admin's payment queue but never changes `status` itself. Idempotent.
async function handleMarkOrderPaid(request, env, orderId) {
  const result = await env.DB.prepare(
    "UPDATE orders SET marked_paid_at=datetime('now') WHERE id=? AND status='pending' AND marked_paid_at IS NULL"
  ).bind(orderId).run();
  if (!result.meta || result.meta.changes === 0) {
    const existing = await env.DB.prepare('SELECT id FROM orders WHERE id=?').bind(orderId).first();
    if (!existing) return json({ error: 'Order not found' }, 404);
    return json({ ok: true, already: true });
  }
  return json({ ok: true });
}

// ── Admin: settings (CashApp config, company/waybill info, PBT login) ───────

const ALLOWED_SETTINGS_KEYS = new Set([
  'cashapp_cashtag', 'cashapp_note',
  'company_name', 'company_address', 'company_city', 'company_state', 'company_zip', 'company_phone',
  'markup_usd',
  'pbt_email', 'pbt_password',
  'admin_notification_email',
]);
// Never echoed back in plaintext once set — GET reports only whether a
// value is present (`<key>_set`), and PUT leaves the stored value alone
// when the submitted value is blank, so re-saving the rest of the form
// doesn't accidentally wipe a configured password.
const SECRET_SETTINGS_KEYS = new Set(['pbt_password']);

async function handleAdminSettingsGet(request, env, url) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of (rows.results || [])) {
    if (SECRET_SETTINGS_KEYS.has(row.key)) {
      out[row.key + '_set'] = !!row.value;
    } else {
      out[row.key] = row.value;
    }
  }
  return json({ settings: out });
}

async function handleAdminSettingsPut(request, env, url) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => ({}));
  const updates = [];
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_SETTINGS_KEYS.has(key)) continue;
    if (SECRET_SETTINGS_KEYS.has(key) && !value) continue; // blank = keep existing
    updates.push([key, String(value)]);
  }
  for (const [key, value] of updates) {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).bind(key, value).run();
  }
  return json({ ok: true, updated: updates.map(([k]) => k) });
}

// ── Admin: seller blacklist ───────────────────────────────────────────────────

async function handleBlacklistGet(request, env, url) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const rows = await env.DB.prepare(
    'SELECT username, added_at FROM seller_blacklist ORDER BY added_at DESC'
  ).all();
  return json({ sellers: rows.results || [] });
}

async function handleBlacklistAdd(request, env, url) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => ({}));
  const username = (body.username || '').trim().toLowerCase();
  if (!username) return json({ error: 'username required' }, 400);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO seller_blacklist (username) VALUES (?)"
  ).bind(username).run();
  // Mark any existing available listings from this seller as ended
  await env.DB.prepare(
    "UPDATE pets SET status='ended', updated_at=datetime('now') WHERE pbt_seller=? AND status='available'"
  ).bind(username).run();
  return json({ ok: true, username });
}

async function handleBlacklistRemove(request, env, url, username) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const u = decodeURIComponent(username).toLowerCase();
  await env.DB.prepare('DELETE FROM seller_blacklist WHERE username=?').bind(u).run();
  return json({ ok: true, username: u });
}

// ── Admin: orders (payment queue, sold history, waybill detail) ─────────────

async function handleAdminOrders(request, env, url) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const status = url.searchParams.get('status') === 'pending' ? 'pending' : 'paid';

  if (status === 'pending') {
    const rows = await env.DB.prepare(`
      SELECT o.id AS order_id, o.created_at, o.expires_at, o.marked_paid_at, o.amount_usd,
             o.payment_ref, o.buyer_name, o.buyer_city, o.buyer_state,
             p.id AS pet_id, p.name AS pet_name, p.breed
      FROM orders o JOIN pets p ON p.id = o.pet_id
      WHERE o.status = 'pending'
      ORDER BY (o.marked_paid_at IS NULL), o.marked_paid_at DESC, o.created_at DESC
    `).all();
    return json({ orders: rows.results || [] });
  }

  const rows = await env.DB.prepare(`
    SELECT o.id AS order_id, o.paid_at, o.amount_usd, o.buyer_name, o.buyer_city, o.buyer_state,
           p.id AS pet_id, p.name AS pet_name, p.breed, p.pbt_id
    FROM orders o JOIN pets p ON p.id = o.pet_id
    WHERE o.status = 'paid'
    ORDER BY o.paid_at DESC
  `).all();
  return json({ orders: rows.results || [] });
}

async function handleConfirmPayment(request, env, url, orderId) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => ({}));
  const note = (body.note || '').trim().slice(0, 500) || null;

  const claim = await env.DB.prepare(
    "UPDATE orders SET status='paid', paid_at=datetime('now'), payment_note=? WHERE id=? AND status='pending'"
  ).bind(note, orderId).run();
  if (!claim.meta || claim.meta.changes === 0) {
    return json({ error: 'Order not found or already resolved' }, 409);
  }

  const order = await env.DB.prepare('SELECT pet_id FROM orders WHERE id=?').bind(orderId).first();
  await env.DB.prepare(
    "UPDATE pets SET status='sold', updated_at=datetime('now') WHERE id=?"
  ).bind(order.pet_id).run();

  await sendOrderPaidEmails(env, orderId);
  return json({ ok: true });
}

async function handleAdminOrderDetail(request, env, url, orderId) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const row = await env.DB.prepare(`
    SELECT o.id AS order_id, o.paid_at, o.amount_usd, o.payment_method,
           o.buyer_name, o.buyer_email, o.buyer_phone,
           o.buyer_address1, o.buyer_address2, o.buyer_city, o.buyer_state, o.buyer_zip, o.buyer_country,
           p.id AS pet_id, p.name AS pet_name, p.breed, p.pbt_id
    FROM orders o JOIN pets p ON p.id = o.pet_id
    WHERE o.id = ? AND o.status = 'paid'
  `).bind(orderId).first();
  if (!row) return json({ error: 'Not found' }, 404);
  return json({ order: row });
}

// TEMPORARY debug route — re-fetches one PBT listing's raw detail HTML and
// returns snippets around "sex"/"vaccin"/"worm"/"deworm" plus <img> tags, so
// the worming-extraction regex in pbtScrapeDetail (currently a best-effort
// guess at the class names) can be verified against real markup. Remove
// once confirmed correct.
async function handlePbtDebug(request, env, url) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const pbtId = url.searchParams.get('pbt_id');
  if (!pbtId) return json({ error: 'pbt_id required' }, 400);

  const pet = await env.DB.prepare('SELECT pbt_url FROM pets WHERE pbt_id = ?').bind(pbtId).first();
  if (!pet?.pbt_url) return json({ error: 'Unknown pbt_id' }, 404);

  const cookie = await pbtLogin(env);
  if (!cookie) return json({ error: 'PBT login failed' }, 502);

  const r = await fetch(pet.pbt_url, { headers: { Cookie: cookie } });
  if (!r.ok) return json({ error: `Fetch failed: ${r.status}` }, 502);
  const html = await r.text();

  function snippetsFor(keyword, max = 10) {
    const out = [];
    const re = new RegExp(keyword, 'gi');
    let m;
    while ((m = re.exec(html)) !== null && out.length < max) {
      out.push(html.slice(Math.max(0, m.index - 250), m.index + 150));
    }
    return out;
  }

  const imgTags = [];
  const imgRe = /<img\b[^>]*>/gi;
  let im;
  while ((im = imgRe.exec(html)) !== null && imgTags.length < 15) imgTags.push(im[0]);

  return json({
    pbt_url: pet.pbt_url,
    html_length: html.length,
    sexSnippets: snippetsFor('sex'),
    vaccineSnippets: snippetsFor('vaccin'),
    wormSnippets: snippetsFor('worm|deworm'),
    imgTags,
  });
}

// TEMPORARY debug route — runs the PBT sync immediately (instead of waiting
// for the */30 cron) and returns its stats. Useful during development and
// after changing scraper field extraction. Remove alongside handlePbtDebug
// once the scraper is confirmed stable.
async function handlePbtSyncNow(request, env, url) {
  if (!checkAdminToken(request, env, url)) return json({ error: 'Unauthorized' }, 401);
  const stats = await syncPbtListings(env);
  return json({ stats });
}

// ── Cron: order expiry ────────────────────────────────────────────────────────

async function expireOrders(env) {
  const now = new Date().toISOString();
  const expired = await env.DB.prepare(
    "SELECT id, pet_id FROM orders WHERE status='pending' AND expires_at <= ?"
  ).bind(now).all();
  for (const o of (expired.results || [])) {
    await env.DB.prepare("UPDATE orders SET status='expired' WHERE id=?").bind(o.id).run();
    await env.DB.prepare(
      "UPDATE pets SET status='available', updated_at=datetime('now') WHERE id=? AND status='pending'"
    ).bind(o.pet_id).run();
  }
}

// ── Email (Resend) ────────────────────────────────────────────────────────────

async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) return;
  const senderEmail = env.RESEND_SENDER_EMAIL || 'orders@pawsdelivered.com';
  const senderName  = env.RESEND_SENDER_NAME  || 'Paws Delivered';
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${senderName} <${senderEmail}>`,
        to: [to],
        subject,
        html,
      }),
    });
  } catch { /* email is best-effort; never block order processing */ }
}

async function sendOrderPaidEmails(env, orderId) {
  const order = await env.DB.prepare(
    `SELECT o.*, p.name AS pet_name, p.breed, p.species
     FROM orders o JOIN pets p ON p.id = o.pet_id
     WHERE o.id = ?`
  ).bind(orderId).first();
  if (!order) return;

  const addressLine = [order.buyer_address1, order.buyer_address2].filter(Boolean).join(', ');
  const listingLink = `https://pawsdelivered.com/pet?id=${order.pet_id}`;

  const buyerHtml = `
    <h2>Your Paws Delivered order is confirmed</h2>
    <p>Thanks for your order, ${escapeHtml(order.buyer_name)}! Your CashApp payment has been confirmed.</p>
    <h3>Order Summary</h3>
    <ul>
      <li><strong>Pet:</strong> ${escapeHtml(order.pet_name)} (${escapeHtml(order.breed || order.species)})</li>
      <li><strong>Listing:</strong> <a href="${escapeHtml(listingLink)}">${escapeHtml(listingLink)}</a></li>
      <li><strong>Price:</strong> $${order.amount_usd.toFixed(2)}</li>
    </ul>
    <h3>Shipping To</h3>
    <p>${escapeHtml(order.buyer_name)}<br>
       ${escapeHtml(addressLine)}<br>
       ${escapeHtml(order.buyer_city)}, ${escapeHtml(order.buyer_state)} ${escapeHtml(order.buyer_zip)}<br>
       ${escapeHtml(order.buyer_country)}</p>
    <p>We'll be in touch with delivery updates. Thanks for choosing Paws Delivered!</p>
  `;

  const adminHtml = `
    <h2>New confirmed order</h2>
    <h3>Pet</h3>
    <ul>
      <li><strong>Name:</strong> ${escapeHtml(order.pet_name)}</li>
      <li><strong>Breed/Species:</strong> ${escapeHtml(order.breed || order.species)}</li>
      <li><strong>Price:</strong> $${order.amount_usd.toFixed(2)}</li>
      <li><strong>Pet ID:</strong> ${escapeHtml(order.pet_id)}</li>
    </ul>
    <h3>Buyer</h3>
    <ul>
      <li><strong>Name:</strong> ${escapeHtml(order.buyer_name)}</li>
      <li><strong>Email:</strong> ${escapeHtml(order.buyer_email)}</li>
      <li><strong>Phone:</strong> ${escapeHtml(order.buyer_phone)}</li>
      <li><strong>Address:</strong> ${escapeHtml(addressLine)}, ${escapeHtml(order.buyer_city)}, ${escapeHtml(order.buyer_state)} ${escapeHtml(order.buyer_zip)}, ${escapeHtml(order.buyer_country)}</li>
    </ul>
    <h3>Payment</h3>
    <ul>
      <li><strong>Order ID:</strong> ${escapeHtml(order.id)}</li>
      <li><strong>Payment Ref:</strong> ${escapeHtml(order.payment_ref)}</li>
      <li><strong>Method:</strong> ${escapeHtml(order.payment_method)}</li>
    </ul>
  `;

  await sendEmail(env, {
    to: order.buyer_email,
    subject: `Your Paws Delivered order is confirmed — ${order.pet_name}`,
    html: buyerHtml,
  });
  // Optional: only sent if an admin notification address is configured
  // (admin-console Settings page, not a Worker secret — same reasoning as
  // the PBT login: nothing sensitive about an email address).
  const { admin_notification_email } = await getSettingsMap(env, ['admin_notification_email']);
  if (admin_notification_email) {
    await sendEmail(env, {
      to: admin_notification_email,
      subject: `New confirmed order — ${order.pet_name} ($${order.amount_usd.toFixed(2)})`,
      html: adminHtml,
    });
  }
}

// ── Cron: PBT listing sync ────────────────────────────────────────────────────

async function syncPbtListings(env) {
  const stats = {
    pages: 0, listings_found: 0, backfill_candidates: 0,
    backfill_attempted: 0, backfill_ok: 0, backfill_err: 0, new_inserted: 0,
    backfill_err_samples: [],
  };

  const creds = await getSettingsMap(env, ['pbt_email', 'pbt_password']);
  if (!creds.pbt_email || !creds.pbt_password) {
    stats.error = 'PBT credentials not configured — set them in the admin Settings page';
    return stats;
  }

  const cookie = await pbtLogin(env);
  if (!cookie) { stats.error = 'PBT login failed'; return stats; }

  // Collect all listing IDs from browse pages
  const seen = new Set();
  const listings = [];
  let page = 1;
  while (true) {
    const pageListings = await pbtScrapeBrowse(cookie, page);
    stats.pages++;
    if (pageListings.length === 0) break;
    for (const l of pageListings) {
      if (!seen.has(l.id)) { seen.add(l.id); listings.push(l); }
    }
    // Stop when we hit an empty page (past the last page) or a safety cap
    if (page >= 100) break;
    page++;
  }
  stats.listings_found = listings.length;

  // Load seller blacklist
  const blRows = await env.DB.prepare('SELECT username FROM seller_blacklist').all();
  const blacklist = new Set((blRows.results || []).map(r => r.username));

  // Mark listings no longer on PBT as ended (unless already sold/pending)
  // Also end any available listings from blacklisted sellers
  const pbtIds = listings.map(l => l.id);
  const availableRows = await env.DB.prepare(
    "SELECT pbt_id, pbt_seller FROM pets WHERE status = 'available'"
  ).all();
  for (const row of (availableRows.results || [])) {
    const offPbt = pbtIds.length > 0 && !pbtIds.includes(row.pbt_id);
    const blacklisted = row.pbt_seller && blacklist.has(row.pbt_seller);
    if (offPbt || blacklisted) {
      await env.DB.prepare(
        "UPDATE pets SET status='ended', updated_at=datetime('now') WHERE pbt_id=?"
      ).bind(row.pbt_id).run();
    }
  }

  // Find listings needing a backfill detail scrape: missing photos, breed, gender, or seller
  const backfillRows = await env.DB.prepare(`
    SELECT p.pbt_id FROM pets p
    LEFT JOIN pet_pictures pp ON pp.pet_id = p.id
    WHERE p.status = 'available'
    GROUP BY p.id
    HAVING COUNT(pp.id) = 0 OR p.gender = 'unknown' OR p.breed IS NULL OR p.pbt_seller IS NULL
  `).all();
  const backfillIds = new Set((backfillRows.results || []).map(r => r.pbt_id));
  stats.backfill_candidates = backfillIds.size;

  const allRows = await env.DB.prepare('SELECT pbt_id FROM pets').all();
  const existingIds = new Set((allRows.results || []).map(r => r.pbt_id));

  for (const { id, slug, price_usd } of listings) {
    if (existingIds.has(id)) {
      // Already in DB — update price from browse page if we got one
      if (price_usd && price_usd > 0) {
        try {
          await env.DB.prepare(
            "UPDATE pets SET price_usd=?, status = CASE WHEN status = 'ended' THEN 'available' ELSE status END, updated_at=datetime('now') WHERE pbt_id=?"
          ).bind(price_usd, id).run();
        } catch { /* ignore */ }
      }
      // Re-fetch detail page to backfill missing fields/photos
      if (backfillIds.has(id)) {
        stats.backfill_attempted++;
        try {
          const detail = await pbtScrapeDetail(cookie, id, slug, stats.backfill_err_samples);
          if (detail) {
            stats.backfill_ok++;
            // Skip if seller is now blacklisted
            if (detail.pbt_seller && blacklist.has(detail.pbt_seller)) {
              await env.DB.prepare(
                "UPDATE pets SET status='ended', updated_at=datetime('now') WHERE pbt_id=?"
              ).bind(id).run();
              continue;
            }
            const petRow = await env.DB.prepare('SELECT id FROM pets WHERE pbt_id=?').bind(id).first();
            if (petRow) {
              // Fill in blanks only — don't overwrite existing values
              await env.DB.prepare(`
                UPDATE pets SET
                  breed         = CASE WHEN breed IS NULL AND ? IS NOT NULL THEN ? ELSE breed END,
                  gender        = CASE WHEN gender = 'unknown' AND ? != 'unknown' THEN ? ELSE gender END,
                  pbt_seller    = COALESCE(pbt_seller, ?),
                  updated_at    = datetime('now')
                WHERE id = ?
              `).bind(
                detail.breed, detail.breed,
                detail.gender, detail.gender,
                detail.pbt_seller,
                petRow.id
              ).run();
              // Only insert photos if this pet currently has none
              const photoCount = await env.DB.prepare(
                'SELECT COUNT(*) AS n FROM pet_pictures WHERE pet_id=?'
              ).bind(petRow.id).first();
              if ((photoCount?.n ?? 0) === 0 && detail.images?.length) {
                for (let i = 0; i < detail.images.length; i++) {
                  await env.DB.prepare(
                    'INSERT OR IGNORE INTO pet_pictures (id, pet_id, url, is_primary) VALUES (?, ?, ?, ?)'
                  ).bind(crypto.randomUUID(), petRow.id, detail.images[i], i === 0 ? 1 : 0).run();
                }
              }
            }
          } else {
            stats.backfill_err++;
          }
        } catch (e) {
          stats.backfill_err++;
          if (stats.backfill_err_samples.length < 8) {
            stats.backfill_err_samples.push({ exception: String(e).slice(0, 150) });
          }
        }
      }
      continue;
    }
    try {
      const detail = await pbtScrapeDetail(cookie, id, slug);
      if (!detail) continue;
      if (detail.pbt_seller && blacklist.has(detail.pbt_seller)) continue;
      await syncPbtListings_upsert(env, detail);
      stats.new_inserted++;
    } catch { /* skip individual failures — will retry next sync */ }
  }

  return stats;
}

async function pbtLogin(env) {
  const creds = await getSettingsMap(env, ['pbt_email', 'pbt_password']);
  if (!creds.pbt_email || !creds.pbt_password) return null;

  // No CSRF token; form fields are `username` and `password` (not Email/Password)
  const body = new URLSearchParams({
    username: creds.pbt_email,
    password: creds.pbt_password,
    returnUrl: '',
    rememberMe: 'false',
  });

  try {
    const r = await fetch('https://pbtmarketplace.com/Account/LogOn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    });
    const raw = r.headers.get('set-cookie') || '';
    const m = raw.match(/\.AspNet\.ApplicationCookie=([^;]+)/);
    return m ? `.AspNet.ApplicationCookie=${m[1]}` : null;
  } catch { return null; }
}

async function pbtScrapeBrowse(cookie, page) {
  try {
    const url = page > 1
      ? `https://pbtmarketplace.com/Browse?page=${page}`
      : 'https://pbtmarketplace.com/Browse';
    const r = await fetch(url, { headers: { Cookie: cookie } });
    if (!r.ok) return [];
    const html = await r.text();
    const seen = new Set();
    const listings = [];
    const re = /href="\/Listing\/Details\/(\d+)\/([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      // Extract price from card HTML; price lives in <span class="NumberPart">700.00</span>
      const cardHtml = html.slice(m.index, m.index + 1200);
      const priceM = cardHtml.match(/class="NumberPart">([\d,]+(?:\.\d{1,2})?)</);
      const price_usd = priceM ? parseFloat(priceM[1].replace(/,/g, '')) : null;
      listings.push({ id: m[1], slug: m[2], price_usd: price_usd && price_usd > 0 ? price_usd : null });
    }
    return listings;
  } catch { return []; }
}

async function pbtScrapeDetail(cookie, pbtId, slug, errBag) {
  const r = await fetch(
    `https://pbtmarketplace.com/Listing/Details/${pbtId}/${slug}`,
    { headers: { Cookie: cookie } }
  );
  if (!r.ok) {
    if (errBag && errBag.length < 8) {
      const body = await r.text().catch(() => '');
      errBag.push({ status: r.status, preview: body.slice(0, 150) });
    }
    return null;
  }
  const html = await r.text();

  // Helper: extract text content from first element with a given class.
  // Tolerant of extra classes on the element and nested markup (icons, links)
  // inside the value, since not every field is a bare text node.
  function extract(cls) {
    const openMatch = html.match(new RegExp(`<(\\w+)[^>]*\\bclass="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'i'));
    if (!openMatch) return null;
    const tag = openMatch[1];
    const rest = html.slice(openMatch.index + openMatch[0].length);
    const closeMatch = rest.match(new RegExp(`<\\/${tag}>`, 'i'));
    const inner = closeMatch ? rest.slice(0, closeMatch.index) : rest.slice(0, 300);
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text || null;
  }

  // Price: use buy-now price from data-price attribute (the fixed sale price)
  const priceMatch = html.match(/data-price="([\d.]+)"/);
  if (!priceMatch) {
    if (errBag && errBag.length < 8) errBag.push({ status: r.status, reason: 'no_price', preview: html.slice(0, 150) });
    return null; // can't list without a price
  }
  const price_usd = parseFloat(priceMatch[1]);
  if (!price_usd || price_usd <= 0) {
    if (errBag && errBag.length < 8) errBag.push({ status: r.status, reason: 'bad_price' });
    return null;
  }

  const ageStr    = extract('listing-details-age');
  const breedRaw  = extract('listing-details-breed');
  const breed     = breedRaw && !breedRaw.includes('Unlisted') ? breedRaw : null;
  const registry  = extract('listing-details-registry');
  const weightStr = extract('listing-details-weight');
  const color     = extract('listing-details-color');

  // Gender: from class content, fall back to slug
  const sexRaw = extract('listing-details-sex');
  let gender = 'unknown';
  if (sexRaw) {
    if (/female/i.test(sexRaw)) gender = 'female';
    else if (/male/i.test(sexRaw)) gender = 'male';
  } else if (/-female/i.test(slug)) { gender = 'female'; }
  else if (/-male/i.test(slug)) { gender = 'male'; }

  // Species: feline category or cat-breed keywords → cat, else dog
  const isFeline = /feline|kitten|siamese|persian|maine.?coon|ragdoll|bengal/i.test(html);
  const species = isFeline ? 'cat' : 'dog';

  // Name: humanize the slug (strip trailing -female/-male, capitalize words)
  const nameParts = slug
    .replace(/-female$|-male$/i, '')
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1));
  const name = nameParts.join(' ') || slug;

  // Date of birth: compute from "9 Weeks 4 Days" age string
  const date_of_birth = pbtAgeToDateOfBirth(ageStr);

  // Weight in lbs from "2 lbs 9 oz"
  const weight_lbs = pbtWeightToLbs(weightStr);

  // Images: get fullsize S3 URLs; first is primary
  const images = [];
  const imgRe = /<img\s[^>]*src="(https:\/\/pbt-upload-production\.s3[^"]+_fullsize\.jpg)"[^>]*>/g;
  let im;
  while ((im = imgRe.exec(html)) !== null) {
    images.push(im[1]);
  }

  // Vaccinations: collect vaccine name + administered date pairs
  const vaccines = [];
  const vaccineRe = /class="vaccine-name">([^<]+)<[\s\S]*?class="vaccine-administered-date">([^<]+)</g;
  let vm;
  while ((vm = vaccineRe.exec(html)) !== null) {
    vaccines.push(`${vm[1].trim()} (${vm[2].trim()})`);
  }
  const vaccinations = vaccines.length > 0 ? vaccines.join('\n') : null;

  // Worming/deworming records — same paired name+date pattern as vaccines.
  // BEST-EFFORT: these class names are unconfirmed against real markup.
  // Verify via GET /api/admin/pbt-debug (wormSnippets) against a live
  // listing and correct them once confirmed, same as bitcoin-pets actually
  // had to do for its sex-field and photo-scraping extraction.
  const worms = [];
  const wormRe = /class="dewormer-name">([^<]+)<[\s\S]*?class="dewormer-administered-date">([^<]+)</g;
  let wm;
  while ((wm = wormRe.exec(html)) !== null) {
    worms.push(`${wm[1].trim()} (${wm[2].trim()})`);
  }
  const worming = worms.length > 0 ? worms.join('\n') : null;

  // Seller: extract username from /Member/Profile/{username} link
  const sellerM = html.match(/href="\/Member\/Profile\/([^"/?]+)"/i);
  const pbt_seller = sellerM ? sellerM[1].toLowerCase() : null;

  return {
    pbt_id: pbtId,
    pbt_url: `https://pbtmarketplace.com/Listing/Details/${pbtId}/${slug}`,
    name, species, breed, gender, color,
    date_of_birth, weight_lbs,
    registry_name: registry || null,
    price_usd,
    vaccinations, worming,
    images,
    pbt_seller,
  };
}

async function syncPbtListings_upsert(env, listing) {
  const existing = await env.DB.prepare(
    'SELECT id FROM pets WHERE pbt_id = ?'
  ).bind(listing.pbt_id).first();

  if (existing) {
    // Update price only. Never force status back to 'available' here —
    // this listing may already be 'sold' or 'pending' on our own site even
    // though it's still visible on PBT's, so only revive an 'ended' one.
    await env.DB.prepare(
      "UPDATE pets SET price_usd=?, status = CASE WHEN status = 'ended' THEN 'available' ELSE status END, updated_at=datetime('now') WHERE pbt_id=?"
    ).bind(listing.price_usd, listing.pbt_id).run();
    return;
  }

  // New listing: insert pet + pictures
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO pets (id, pbt_id, pbt_url, name, species, breed, date_of_birth, weight_lbs,
      gender, color, vaccinations, worming, registry_name, price_usd, pbt_seller)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, listing.pbt_id, listing.pbt_url, listing.name, listing.species,
    listing.breed, listing.date_of_birth, listing.weight_lbs,
    listing.gender, listing.color, listing.vaccinations, listing.worming,
    listing.registry_name, listing.price_usd, listing.pbt_seller || null
  ).run();

  for (let i = 0; i < listing.images.length; i++) {
    await env.DB.prepare(
      'INSERT INTO pet_pictures (id, pet_id, url, is_primary) VALUES (?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), id, listing.images[i], i === 0 ? 1 : 0).run();
  }
}

// ── PBT parsing helpers ───────────────────────────────────────────────────────

function pbtAgeToDateOfBirth(ageStr) {
  if (!ageStr) return null;
  let days = 0;
  const yr  = ageStr.match(/(\d+)\s*year/i);
  const mo  = ageStr.match(/(\d+)\s*month/i);
  const wk  = ageStr.match(/(\d+)\s*week/i);
  const dy  = ageStr.match(/(\d+)\s*day/i);
  if (yr) days += parseInt(yr[1]) * 365;
  if (mo) days += parseInt(mo[1]) * 30;
  if (wk) days += parseInt(wk[1]) * 7;
  if (dy) days += parseInt(dy[1]);
  if (days === 0) return null;
  return new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
}

function pbtWeightToLbs(weightStr) {
  if (!weightStr) return null;
  const lbsM = weightStr.match(/(\d+)\s*lbs?/i);
  const ozM  = weightStr.match(/(\d+)\s*oz/i);
  let lbs = lbsM ? parseFloat(lbsM[1]) : 0;
  if (ozM) lbs += parseFloat(ozM[1]) / 16;
  return lbs > 0 ? Math.round(lbs * 100) / 100 : null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
