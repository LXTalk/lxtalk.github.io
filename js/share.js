// 他のアプリの「共有」から来た内容を受け取り、送信先(友達・グループ)を選ぶ画面
// ユーザー入力(表示名など)は必ず textContent で描画する(XSS対策)
const $ = (sel, root = document) => root.querySelector(sel);
const INBOX = 'share-inbox';
const MAX_AGE_MS = 10 * 60 * 1000;

// Service Worker が置いた共有内容を読み取り、すぐに削除する。なければ null
export async function readInbox() {
  if (!('caches' in window)) return null;
  try {
    const c = await caches.open(INBOX);
    const res = await c.match('/share-inbox/meta');
    if (!res) return null;
    const meta = await res.json();
    if (!meta || Date.now() - meta.at > MAX_AGE_MS) return null;
    const files = [];
    for (const m of meta.files || []) {
      const r = await c.match('/share-inbox/f/' + m.i);
      if (r) files.push(new File([await r.blob()], String(m.name || 'file'), { type: m.type || 'application/octet-stream' }));
    }
    const text = typeof meta.text === 'string' ? meta.text : '';
    return text || files.length ? { text, files } : null;
  } catch { return null; }
  finally { try { await caches.delete(INBOX); } catch { /* 無視 */ } }
}

export function createShare({ supabase, onPick, onCancel }) {
  let wired = false;

  function avatar(p) {
    const initial = Array.from(p.display_name || '?')[0] || '?';
    const fallback = () => { const s = document.createElement('span'); s.className = 'avatar'; s.textContent = initial; return s; };
    if (!p.avatar_path) return fallback();
    const img = document.createElement('img');
    img.className = 'avatar'; img.alt = '';
    img.src = supabase.storage.from('avatars').getPublicUrl(p.avatar_path).data.publicUrl;
    img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
    return img;
  }

  function row(p, sub, target) {
    const li = document.createElement('li');
    li.className = 'row clickable';
    const names = document.createElement('div');
    names.className = 'names';
    const dn = document.createElement('div'); dn.className = 'dn'; dn.textContent = p.display_name;
    const uid = document.createElement('div'); uid.className = 'uid'; uid.textContent = sub;
    names.append(dn, uid);
    li.append(avatar(p), names);
    li.addEventListener('click', () => onPick(target));
    return li;
  }

  function fill(listSel, emptySel, nodes) {
    $(listSel).replaceChildren(...nodes);
    $(emptySel).hidden = nodes.length > 0;
  }

  async function show(me, payload) {
    if (!wired) { wired = true; $('#share-back').addEventListener('click', onCancel); }
    const what = [];
    if (payload && payload.text) what.push('テキスト');
    if (payload && payload.files && payload.files.length) what.push(`ファイル${payload.files.length}件`);
    $('#share-what').textContent = what.length ? `${what.join('と')}を共有` : '';
    const [fr, gr] = await Promise.all([supabase.rpc('get_friends'), supabase.rpc('get_groups')]);
    fill('#share-friends', '#share-friends-empty', (fr.data || []).filter((f) => f.conversation_id)
      .map((f) => row(f, '@' + f.user_id, f)));
    fill('#share-groups', '#share-groups-empty', (gr.data || []).map((g) => row({ display_name: g.name, avatar_path: g.avatar_path }, `${g.member_count}人`,
      { type: 'group', conversation_id: g.conversation_id, display_name: g.name, member_count: g.member_count, role: g.role, avatar_path: g.avatar_path || null })));
  }

  return { show };
}
