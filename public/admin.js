// backend/public/admin.js
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }

async function loadRows(){
  const token  = document.getElementById('token').value.trim();
  const status = document.getElementById('status').value;
  const q      = document.getElementById('q').value.trim();

  const qs = new URLSearchParams();
  if (status && status !== 'all') qs.set('status', status);
  if (q) qs.set('q', q);
  qs.set('limit', '200');
const headers = new Headers();
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json');

  const res = await fetch(url, { headers });
  const res = await fetch(`/api/reservations?${qs.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  if (!res.ok) {
    alert(`読み込み失敗: ${res.status} ${res.statusText}`);
    return;
  }
  const rows = await res.json();

  const tbody = document.querySelector('#list tbody');
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${esc(r.id)}</td>
      <td>${esc(r.time_iso || '')}</td>
      <td>${esc(r.salon_name || '')}</td>
      <td>${esc(r.item || '')}</td>
      <td>${esc(r.price ?? '')}</td>
      <td>${esc(r.reserve_time || '')}</td>
      <td>${esc(r.contact_name || '')}</td>
      <td>${esc(r.contact_email || '')}</td>
      <td>${esc(r.contact_phone || '')}</td>
      <td>${esc(r.status || '')}</td>
      <td>-</td>
    </tr>
  `).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('load').addEventListener('click', loadRows);
  // Enterでも読み込めるように
  document.getElementById('q').addEventListener('keydown', e => {
    if(e.key === 'Enter') loadRows();
  });
});
