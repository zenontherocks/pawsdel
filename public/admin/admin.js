// admin.js — shared shell for the admin console.
//
// bitcoin-pets' admin pages each independently re-prompt for the admin
// token and don't carry it between pages/links. This fixes that: the token
// is captured once (from ?token= or a gate prompt), persisted to
// sessionStorage (clears on tab close, survives reloads), and every nav
// link + adminFetch() call carries it automatically.
(function () {
  const TOKEN_KEY = 'pd_admin_token';

  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) sessionStorage.setItem(TOKEN_KEY, urlToken);

  window.adminToken = function () {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  };

  window.adminSetToken = function (t) {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  };

  window.adminUrl = function (path) {
    const t = adminToken();
    if (!t) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}token=${encodeURIComponent(t)}`;
  };

  window.adminFetch = function (path, opts) {
    return fetch(adminUrl(path), opts);
  };

  window.escHtml = window.escHtml || function (s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  // Renders a "paste your token" prompt into containerEl and calls onReady()
  // once a token is available (either already present, or just entered).
  // Every admin page's data loader should call this before its first fetch.
  window.adminTokenGate = function (containerEl, onReady) {
    if (adminToken()) { onReady(); return; }
    containerEl.innerHTML = `
      <div class="admin-card">
        <h2>Enter Admin Token</h2>
        <p class="admin-muted">Paste the admin token to continue. It's remembered for the rest of this browser tab.</p>
        <div class="admin-token-row">
          <input type="password" id="gateTokenInput" placeholder="Paste your ADMIN_TOKEN here" autocomplete="off" />
          <button class="admin-btn admin-btn-primary" id="gateTokenBtn">Continue</button>
        </div>
      </div>`;
    const submit = () => {
      const val = document.getElementById('gateTokenInput').value.trim();
      if (!val) return;
      adminSetToken(val);
      location.reload();
    };
    document.getElementById('gateTokenBtn').addEventListener('click', submit);
    document.getElementById('gateTokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  };

  // If a fetch comes back 401 (token missing/wrong), clear it and show the
  // gate again rather than leaving the page stuck on a silent failure.
  window.adminHandleUnauthorized = function (containerEl) {
    adminSetToken('');
    adminTokenGate(containerEl, () => {});
  };

  const NAV_ITEMS = [
    { href: '/admin/', label: 'Dashboard' },
    { href: '/admin/orders.html', label: 'Orders' },
    { href: '/admin/seller-blacklist.html', label: 'Seller Blacklist' },
    { href: '/admin/settings.html', label: 'Settings' },
  ];

  function injectSharedStyles() {
    const style = document.createElement('style');
    style.textContent = [
      '*,*::before,*::after{box-sizing:border-box;}',
      'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f4f4f4;color:#1a1a1a;margin:0;}',
      '.admin-nav{background:#1a1a1a;padding:0 1.5rem;display:flex;align-items:center;justify-content:space-between;height:56px;flex-wrap:wrap;}',
      '.admin-nav-logo{color:#fff;font-weight:800;font-size:1.05rem;text-decoration:none;margin-right:1.5rem;}',
      '.admin-nav-links{list-style:none;display:flex;gap:0.15rem;margin:0;padding:0;flex:1;flex-wrap:wrap;}',
      '.admin-nav-links a{color:#ccc;text-decoration:none;font-size:0.85rem;padding:0.4rem 0.75rem;border-radius:6px;}',
      '.admin-nav-links a:hover{color:#fff;background:#2e2e2e;}',
      '.admin-nav-links a.active{color:#fff;background:rgba(44,95,138,0.55);}',
      '.admin-nav-clear{background:none;border:1px solid #555;color:#ccc;font-size:0.78rem;padding:0.35rem 0.75rem;border-radius:6px;cursor:pointer;font-family:inherit;}',
      '.admin-nav-clear:hover{border-color:#fff;color:#fff;}',
      '.admin-container{max-width:900px;margin:0 auto;padding:2rem 1rem;}',
      '.admin-card{background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.07);padding:1.5rem;margin-bottom:1.5rem;}',
      '.admin-card h2{font-size:1rem;font-weight:700;margin:0 0 1rem;}',
      '.admin-muted{font-size:0.85rem;color:#888;}',
      '.admin-token-row{display:flex;gap:0.5rem;}',
      '.admin-token-row input{flex:1;padding:0.55rem 0.75rem;border:1.5px solid #ddd;border-radius:6px;font-size:0.9rem;font-family:monospace;}',
      '.admin-token-row input:focus{outline:none;border-color:#2C5F8A;}',
      '.admin-btn{padding:0.55rem 1.25rem;border:none;border-radius:6px;font-size:0.9rem;font-weight:600;cursor:pointer;font-family:inherit;}',
      '.admin-btn-primary{background:#2C5F8A;color:#fff;}',
      '.admin-btn-primary:hover{background:#234A6D;}',
      '.admin-btn-danger{background:#fee2e2;color:#b91c1c;}',
      '.admin-btn-danger:hover{background:#fecaca;}',
      '.admin-btn-dark{background:#1a1a1a;color:#fff;}',
      '.admin-btn-dark:hover{background:#333;}',
      '.admin-btn:disabled{opacity:0.5;cursor:not-allowed;}',
      '.admin-table{width:100%;border-collapse:collapse;}',
      '.admin-table th,.admin-table td{text-align:left;padding:0.6rem 0.5rem;border-bottom:1px solid #f0f0f0;font-size:0.85rem;}',
      '.admin-table th{color:#666;font-weight:600;}',
      '.admin-empty{color:#999;font-size:0.875rem;padding:0.75rem 0.5rem;}',
      '.admin-msg{font-size:0.8rem;padding:0.5rem 0.75rem;border-radius:6px;margin-top:0.75rem;}',
      '.admin-msg-ok{background:#dcfce7;color:#166534;}',
      '.admin-msg-err{background:#fee2e2;color:#991b1b;}',
      '.admin-field{display:flex;flex-direction:column;gap:0.3rem;margin-bottom:0.9rem;}',
      '.admin-field label{font-size:0.82rem;font-weight:600;color:#444;}',
      '.admin-field input,.admin-field textarea{padding:0.55rem 0.75rem;border:1.5px solid #ddd;border-radius:6px;font-size:0.9rem;font-family:inherit;}',
      '.admin-field input:focus,.admin-field textarea:focus{outline:none;border-color:#2C5F8A;}',
      '.admin-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;}',
      '.admin-stat{background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.07);padding:1.25rem;text-align:center;}',
      '.admin-stat-value{font-size:1.8rem;font-weight:800;color:#2C5F8A;}',
      '.admin-stat-label{font-size:0.8rem;color:#888;margin-top:0.25rem;}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function injectNav() {
    const nav = document.createElement('div');
    nav.className = 'admin-nav';
    const path = location.pathname;
    const linksHtml = NAV_ITEMS.map(item => {
      const isActive = path === item.href || (item.href === '/admin/' && path === '/admin/index.html');
      return `<a href="${adminUrl(item.href)}" class="${isActive ? 'active' : ''}">${item.label}</a>`;
    }).join('');
    nav.innerHTML =
      `<a href="${adminUrl('/admin/')}" class="admin-nav-logo">Paws Delivered — Admin</a>` +
      `<ul class="admin-nav-links">${linksHtml}</ul>` +
      `<button class="admin-nav-clear" id="adminClearToken" type="button">Clear Token</button>`;
    document.body.insertAdjacentElement('afterbegin', nav);

    document.getElementById('adminClearToken').addEventListener('click', () => {
      adminSetToken('');
      location.href = '/admin/';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    injectSharedStyles();
    injectNav();
  });
})();
