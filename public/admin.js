// public/admin.js
(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  function statusClass(s){ return 'status ' + String(s||'').replace(/[^a-z_]/g,''); }

  $('#load').addEventListener('click', async () => {
    const token  = $('#token').value.trim();           // ← ここから送る
    const status = $('#status').value;
    const q      = $('#q').value.trim();

    const url = new URL('/api/reservations', location.origin);
    url.searchParams.set('limit', '200');
    if (status) url.searchParams.set('status', status);
    if (q)      url.searchParams.set('q', q);

    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        // ⚠️ "headers"（複数形）です
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!res.ok) {
        const text = await res.text().catch(()=>'');
        alert(`読み込み失敗: ${res.status}\n${text}`);
        return;
      }

      const rows = await res.json();
      const tbody = $('#tbl tbody');
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td>${r.id}</td>
          <td>${r.created_at||''}</td>
          <td>${r.salon_name||''}</td>
          <td>${r.item||''}</td>
          <td>${r.price||0}</td>
          <td>${r.time_iso||''}</td>
          <td>${r.contact_name||''}</td>
          <td>${r.contact_email||''}</td>
          <td>${r.contact_phone||''}</td>
          <td class="${statusClass(r.status)}">${r.status||''}</td>
          <td>
            <button data-id="${r.id}" data-status="paid">paid</button>
            <button data-id="${r.id}" data-status="reserved">reserved</button>
            <button data-id="${r.id}" data-status="pending_online">pend</button>
          </td>
        </tr>
      `).join('');

      // ステータス更新ボタン
      $$('#tbl button[data-id]').forEach(btn => {
        btn.onclick = async () => {
          const id = btn.dataset.id;
          const newStatus = btn.dataset.status;
          const r = await fetch(`/api/reservations/${id}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${$('#token').value.trim()}`
            },
            body: JSON.stringify({ status: newStatus })
          });
          if (r.ok) $('#load').click();
          else alert('更新失敗: ' + (await r.text().catch(()=>'')));
        };
      });
    } catch (e) {
      alert('通信エラー: ' + e.message);
      console.error(e);
    }
  });
})();
