// shared.js — Utilities loaded on every page (like navbar.js).
// Provides: escHtml, formatUsd, ageFromDob, SPECIES_ICON, footer year.

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function formatUsd(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ageFromDob(dob) {
  if (!dob) return null;
  var birth = new Date(dob);
  var now = new Date();
  var days = Math.max(0, Math.floor((now - birth) / 86400000));
  var years = Math.floor(days / 365);
  var weeks = Math.floor((days % 365) / 7);
  if (years > 0) return years + ' yr' + (years > 1 ? 's' : '') + (weeks > 0 ? ', ' + weeks + ' wk' + (weeks > 1 ? 's' : '') : '');
  if (weeks > 0) return weeks + ' week' + (weeks > 1 ? 's' : '');
  return 'Less than 1 week';
}

var SPECIES_ICON = {
  dog: '&#128054;', cat: '&#128049;', bird: '&#128038;', reptile: '&#129422;',
  'small animal': '&#128057;', fish: '&#128032;', horse: '&#128052;', other: '&#128062;'
};

// Auto-fill footer year on every page
document.addEventListener('DOMContentLoaded', function () {
  var el = document.getElementById('year');
  if (el) el.textContent = new Date().getFullYear();

  var notice = document.getElementById('cookieNotice');
  if (notice) {
    if (localStorage.getItem('cookieNoticeChoice')) {
      notice.style.display = 'none';
    } else {
      notice.querySelectorAll('.cookie-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          localStorage.setItem('cookieNoticeChoice', btn.dataset.choice);
          notice.style.display = 'none';
        });
      });
    }
  }
});
