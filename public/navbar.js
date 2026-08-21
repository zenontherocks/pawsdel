(function () {
  const style = document.createElement('style');
  style.textContent = [
    'nav{background:#1a1a1a;padding:0 2rem;display:flex;align-items:center;justify-content:space-between;height:60px;position:sticky;top:0;z-index:100;}',
    '.nav-logo{font-size:1.3rem;font-weight:700;color:#4f8fc0;text-decoration:none;letter-spacing:-0.5px;}',
    '.nav-logo span{color:#fff;}',
    '.nav-tagline{font-size:0.7rem;color:#777;font-style:italic;white-space:nowrap;margin-left:0.6rem;}',
    '.nav-links{list-style:none;display:flex;gap:0.25rem;align-items:center;}',
    '.nav-links a{color:#ccc;text-decoration:none;font-size:0.9rem;padding:0.4rem 0.75rem;border-radius:8px;transition:color 0.15s,background 0.15s;}',
    '.nav-links a:hover{color:#fff;background:#2e2e2e;}',
    '.nav-toggle{display:none;flex-direction:column;gap:5px;cursor:pointer;padding:0.4rem;background:none;border:none;}',
    '.nav-toggle span{display:block;width:22px;height:2px;background:#fff;border-radius:2px;}',
    '.nav-theme-toggle{background:#2e2e2e;border:none;color:#fff;font-size:0.95rem;line-height:1;padding:0.45rem 0.6rem;border-radius:8px;cursor:pointer;margin-left:0.5rem;transition:background 0.15s;font-family:inherit;}',
    '.nav-theme-toggle:hover{background:#3a3a3a;}',
    '@media(max-width:640px){',
    '  .nav-tagline{display:none;}',
    '  nav{height:auto!important;min-height:56px;position:relative;padding:0 1rem;}',
    '  .nav-toggle{display:flex;}',
    '  .nav-links{display:none;position:absolute;top:100%;left:0;right:0;flex-direction:column;background:#1a1a1a;padding:0.5rem 1rem 1rem;gap:0;border-top:1px solid #2e2e2e;z-index:99;}',
    '  .nav-links.open{display:flex;}',
    '  .nav-links li{width:100%;}',
    '  .nav-links a{display:block;padding:0.75rem 0.5rem;font-size:1rem;}',
    '  .nav-theme-toggle{margin:0.5rem 0.5rem 0;}',
    '}',
  ].join('\n');
  document.head.appendChild(style);

  // Theme preference stored in localStorage; applied immediately (before
  // DOMContentLoaded) so the page never flashes the wrong theme first.
  // Defaults to light for first-time visitors who haven't set a preference.
  window.PD_THEME = localStorage.getItem('pd_theme') || 'light';
  document.documentElement.setAttribute('data-theme', window.PD_THEME);

  function setTheme(t) {
    window.PD_THEME = t;
    localStorage.setItem('pd_theme', t);
    document.documentElement.setAttribute('data-theme', t);
    document.querySelectorAll('.nav-theme-toggle').forEach(b => {
      b.textContent = t === 'dark' ? '☀️' : '🌙';
      b.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    });
    window.dispatchEvent(new CustomEvent('pd:theme', { detail: t }));
  }

  document.addEventListener('DOMContentLoaded', function () {
    const nav = document.createElement('nav');
    nav.innerHTML =
      '<a href="/" class="nav-logo">Paws<span>Delivered</span></a>' +
      '<span class="nav-tagline">Delivered with care</span>' +
      '<button class="nav-toggle" aria-label="Toggle menu" onclick="this.closest(\'nav\').querySelector(\'.nav-links\').classList.toggle(\'open\')"><span></span><span></span><span></span></button>' +
      '<ul class="nav-links">' +
        '<li><a href="/browse">Browse Pets</a></li>' +
        '<li><a href="/how-it-works">How It Works</a></li>' +
        '<li><a href="/about">About</a></li>' +
        '<li><a href="/contact">Contact</a></li>' +
        '<li><button class="nav-theme-toggle" id="navThemeToggle" type="button"></button></li>' +
      '</ul>';
    document.body.insertAdjacentElement('afterbegin', nav);

    const themeBtn = nav.querySelector('#navThemeToggle');
    themeBtn.textContent = window.PD_THEME === 'dark' ? '☀️' : '🌙';
    themeBtn.setAttribute('aria-label', window.PD_THEME === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    themeBtn.addEventListener('click', () => setTheme(window.PD_THEME === 'dark' ? 'light' : 'dark'));
  });
}());
