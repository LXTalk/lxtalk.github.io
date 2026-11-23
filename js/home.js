// ログイン後のホーム(友達・申請・検索・プロフィール)
// ユーザー入力(表示名など)は必ず textContent で描画し、innerHTML は使わない(XSS対策)
import { uuid } from './uuid.js';
import { fmtDate } from './format.js';
import { createGroupUI } from './group.js';
import { AVATAR_MAX_BYTES, AVATAR_TYPES, toAvatarBlob } from './avatar.js';
import { normalizeUserId, validateUserId, validateDisplayName } from './validate.js';

const $ = (sel, root = document) => root.querySelector(sel);
const GENERIC_ERR = '通信エラー';
const TITLES = { friends: '友達', groups: 'グループ', requests: '友達申請', add: '友達を追加', me: 'プロフィール' };

export function createHome({ supabase, toast, onLogout, onOpenChat, push }) {
  let me = null; // { id, user_id, display_name, avatar_path }
  let channel = null;
  let refreshTimer = null;
  let wired = false;
  let groupChannel = null;
  const groupUI = createGroupUI({ supabase, toast });

  // ---------- 描画ヘルパー ----------
  function avatarUrl(path) {
    return supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  }

  function avatarNode(p, large = false) {
    const initial = Array.from(p.display_name || '?')[0] || '?';
    const makeFallback = () => {
      const s = document.createElement('span');
      s.className = 'avatar' + (large ? ' lg' : '');
      s.textContent = initial;
      return s;
    };
    if (!p.avatar_path) return makeFallback();
    const img = document.createElement('img');
    img.className = 'avatar' + (large ? ' lg' : '');
    img.alt = '';
    img.loading = 'lazy';
    img.src = avatarUrl(p.avatar_path);
    img.addEventListener('error', () => img.replaceWith(makeFallback()), { once: true });
    return img;
  }

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn-sm' + (cls ? ' ' + cls : '');
    b.textContent = label;
    if (onClick) b.addEventListener('click', () => onClick(b));
    return b;
  }

  function rowNode(p, actions = [], sub) {
    const li = document.createElement('li');
    li.className = 'row';
    li.appendChild(avatarNode(p));
    const names = document.createElement('div');
    names.className = 'names';
    const dn = document.createElement('div');
    dn.className = 'dn';
    dn.textContent = p.display_name;
    const uid = document.createElement('div');
    uid.className = 'uid';
    uid.textContent = sub ?? '@' + p.user_id;
    names.append(dn, uid);
    li.appendChild(names);
    if (actions.length) {
      const box = document.createElement('div');
      box.className = 'actions';
      actions.forEach((a) => box.appendChild(a));
      li.appendChild(box);
    }
    return li;
  }

  function fill(listId, emptyId, nodes) {
    const ul = $(listId);
    ul.replaceChildren(...nodes);
    if (emptyId) $(emptyId).hidden = nodes.length > 0;
  }

  // 下から出る確認シート(<dialog>)
  function openSheet(title, actions) {
    const dlg = $('#sheet');
    $('#sheet-title').textContent = title;
    const box = $('#sheet-actions');
    box.replaceChildren();
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      if (a.danger) b.className = 'danger';
      b.addEventListener('click', () => { dlg.close(); a.run?.(); });
      box.appendChild(b);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'キャンセル';
    cancel.addEventListener('click', () => dlg.close());
    box.appendChild(cancel);
    dlg.showModal();
  }

  // ---------- データ取得・描画 ----------
  async function loadFriends() {
    const { data, error } = await supabase.rpc('get_friends');
    if (error) return toast(GENERIC_ERR);
    fill('#friends-list', '#friends-empty', (data || []).map((f) => {
      const menu = button('…', '', () => friendMenu(f));
      menu.setAttribute('aria-label', 'メニュー');
      const li = rowNode(f, [menu], '@' + f.user_id + (f.joined_at ? ` ・ ${fmtDate(f.joined_at)}に登録` : ''));
      if (f.conversation_id) {
        li.classList.add('clickable');
        li.addEventListener('click', (e) => { if (!e.target.closest('button')) onOpenChat(f, { ...me }); });
      }
      return li;
    }));
  }

  async function loadGroups() {
    const { data, error } = await supabase.rpc('get_groups');
    if (error) return toast(GENERIC_ERR);
    groups = data || [];
    fill('#groups-list', '#groups-empty', groups.map((g) => {
      const li = rowNode({ display_name: g.name, avatar_path: g.avatar_path }, [], `${g.member_count}人`);
      li.classList.add('clickable');
      li.addEventListener('click', () => onOpenChat(toGroupObj(g), { ...me }));
      return li;
    }));
  }
  let groups = [];
  const toGroupObj = (g) => ({ type: 'group', conversation_id: g.conversation_id, display_name: g.name, member_count: g.member_count, role: g.role, avatar_path: g.avatar_path || null });

  function friendMenu(f) {
    openSheet(`${f.display_name} (@${f.user_id})`, [
      { label: 'ブロックする', danger: true, run: () => confirmBlock(f) },
      { label: '友達を削除する', danger: true, run: () => confirmRemove(f) },
    ]);
  }

  function confirmRemove(f) {
    openSheet('友達を削除しますか?相手には通知されません。再びチャットするには、もう一度友達申請が必要です。', [
      { label: '削除する', danger: true, run: async () => {
        const { data, error } = await supabase.rpc('remove_friend', { p_user_id: f.user_id });
        if (error || data !== true) toast(GENERIC_ERR); else toast('友達を削除しました');
        refreshAll();
      } },
    ]);
  }

  function confirmBlock(p) {
    openSheet(`${p.display_name} さんをブロックしますか?相手には通知されません。`, [
      { label: 'ブロックする', danger: true, run: async () => {
        const { data, error } = await supabase.rpc('block_user', { p_user_id: p.user_id });
        if (error || data !== true) toast(GENERIC_ERR); else toast('ブロックしました');
        refreshAll();
      } },
    ]);
  }

  async function loadRequests() {
    const { data, error } = await supabase.rpc('get_requests');
    if (error) return toast(GENERIC_ERR);
    const incoming = (data || []).filter((r) => r.direction === 'incoming');
    const outgoing = (data || []).filter((r) => r.direction === 'outgoing');

    fill('#req-in', '#req-in-empty', incoming.map((r) => rowNode(r, [
      button('承認', 'accent', (b) => respond(r.id, true, b)),
      button('拒否', '', (b) => respond(r.id, false, b)),
    ])));
    fill('#req-out', '#req-out-empty', outgoing.map((r) => rowNode(r, [
      button('取り消す', '', async (b) => {
        b.disabled = true;
        const { data: ok, error: e } = await supabase.rpc('cancel_friend_request', { p_request_id: r.id });
        if (e || ok !== true) toast(GENERIC_ERR); else toast('申請を取り消しました');
        refreshAll();
      }),
    ])));

    const badge = $('#badge-req');
    badge.textContent = String(incoming.length);
    badge.hidden = incoming.length === 0;
  }

  async function respond(id, accept, btn) {
    btn.disabled = true;
    const { data, error } = await supabase.rpc('respond_friend_request', { p_request_id: id, p_accept: accept });
    if (error || data !== true) toast(GENERIC_ERR);
    else toast(accept ? '友達になりました' : '申請を拒否しました');
    refreshAll();
  }

  async function loadBlocks() {
    const { data, error } = await supabase.rpc('get_blocks');
    if (error) return;
    fill('#block-list', '#block-empty', (data || []).map((b) => rowNode(b, [
      button('解除', '', async (btn) => {
        btn.disabled = true;
        const { data: ok, error: e } = await supabase.rpc('unblock_user', { p_user_id: b.user_id });
        if (e || ok !== true) toast(GENERIC_ERR); else toast('ブロックを解除しました');
        refreshAll();
      }),
    ])));
  }

  function refreshAll() {
    return Promise.all([loadFriends(), loadGroups(), loadRequests(), loadBlocks()]);
  }

  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshAll, 300);
  }

  // ---------- 検索 ----------
  async function onSearch(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const err = $('.error', form);
    const id = normalizeUserId(new FormData(form).get('q'));
    err.textContent = '';
    $('#search-result').replaceChildren();
    $('#search-empty').hidden = true;

    const v = validateUserId(id);
    if (v) { err.textContent = v; return; }

    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const { data, error } = await supabase.rpc('search_user', { p_user_id: id });
      if (error) {
        err.textContent = String(error.message || '').includes('rate_limited')
          ? '検索が多すぎます。しばらくしてからお試しください' : GENERIC_ERR;
        return;
      }
      const hit = (data || [])[0];
      if (!hit) { $('#search-empty').hidden = false; return; }
      $('#search-result').replaceChildren(searchRow(hit));
    } finally {
      btn.disabled = false;
    }
  }

  function searchRow(hit) {
    const status = (text) => { const b = button(text, ''); b.disabled = true; return b; };
    let action;
    switch (hit.relation) {
      case 'self': action = status('あなた'); break;
      case 'friend': action = status('友達'); break;
      case 'pending_out': action = status('申請中'); break;
      case 'pending_in': action = button('申請を確認', 'accent', () => switchTab('requests')); break;
      case 'blocked': action = button('ブロック解除', '', async (b) => {
        b.disabled = true;
        const { data, error } = await supabase.rpc('unblock_user', { p_user_id: hit.user_id });
        if (error || data !== true) toast(GENERIC_ERR); else toast('ブロックを解除しました');
        refreshAll();
        $('#search-result').replaceChildren(rowNode(hit, [status('解除済み')]));
      }); break;
      default: action = button('友達申請', 'accent', async (b) => {
        b.disabled = true;
        // ブロック・存在しない・重複などの失敗は区別せず、すべて「通信エラー」と表示する
        const { data, error } = await supabase.rpc('send_friend_request', { p_user_id: hit.user_id });
        if (error || data !== true) { toast(GENERIC_ERR); b.disabled = false; return; }
        toast('友達申請を送信しました');
        b.textContent = '申請中';
        refreshAll();
      });
    }
    return rowNode(hit, [action]);
  }

  // ---------- プロフィール ----------
  function renderMe() {
    $('#btn-avatar').replaceChildren(avatarNode(me, true));
    $('#me-userid').textContent = '@' + me.user_id;
    $('#me-joined').textContent = me.created_at ? `${fmtDate(me.created_at)}に登録(友達に公開されます)` : '';
    $('#form-profile [name=display_name]').value = me.display_name;
  }

  async function onSaveProfile(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const err = $('.error', form);
    const name = String(new FormData(form).get('display_name')).trim();
    err.textContent = '';
    const v = validateDisplayName(name);
    if (v) { err.textContent = v; return; }

    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const { data, error } = await supabase.from('profiles')
        .update({ display_name: name }).eq('id', me.id).select('display_name').single();
      if (error || !data) { err.textContent = '保存できませんでした'; return; }
      me.display_name = data.display_name;
      renderMe();
      toast('保存しました');
    } finally {
      btn.disabled = false;
    }
  }

  async function onPickAvatar(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!AVATAR_TYPES.includes(file.type)) return toast('JPEG・PNG・WebP の画像を選んでください');
    if (file.size > AVATAR_MAX_BYTES) return toast('画像は10MB以下にしてください');

    let processed;
    try { processed = await toAvatarBlob(file); }
    catch { return toast('画像を読み込めませんでした'); }

    const path = `${me.id}/${uuid()}.${processed.ext}`;
    const up = await supabase.storage.from('avatars')
      .upload(path, processed.blob, { contentType: processed.blob.type, upsert: false });
    if (up.error) return toast('アイコンを保存できませんでした');

    const old = me.avatar_path;
    const { error } = await supabase.from('profiles').update({ avatar_path: path }).eq('id', me.id);
    if (error) {
      await supabase.storage.from('avatars').remove([path]);
      return toast('アイコンを保存できませんでした');
    }
    me.avatar_path = path;
    renderMe();
    toast('アイコンを変更しました');
    if (old) supabase.storage.from('avatars').remove([old]); // 古い画像は削除(失敗しても影響なし)
  }


  // ---------- 通知設定 ----------
  const PUSH_TEXT = {
    'needs-install': 'iPhoneでは、共有ボタンから「ホーム画面に追加」してアプリとして開くと、通知を受け取れます。',
    denied: '通知がブロックされています。ブラウザ(端末)の設定でLXTalkの通知を許可してください。',
    off: 'このデバイスで、新着メッセージや友達申請を通知で受け取れます。通知には送信者名のみが表示され、メッセージの内容は表示されません。',
    on: 'このデバイスの通知はオンです。通知には送信者名のみが表示されます。',
  };
  const bannerKey = () => `lx-push-banner-${me ? me.id : ''}`;
  const getFlag = () => { try { return localStorage.getItem(bannerKey()); } catch { return null; } };
  const setFlag = () => { try { localStorage.setItem(bannerKey(), '1'); } catch { /* 無視 */ } };

  async function renderPush() {
    const box = $('#push-box');
    if (!push) { box.hidden = true; return; }
    const st = await push.state();
    if (st === 'unsupported') { box.hidden = true; return; }
    box.hidden = false;
    $('#push-text').textContent = PUSH_TEXT[st];
    const b = $('#btn-push');
    b.hidden = !(st === 'on' || st === 'off');
    b.textContent = st === 'on' ? '通知をオフにする' : '通知をオンにする';
    b.dataset.state = st;
  }

  async function onTogglePush() {
    const b = $('#btn-push');
    b.disabled = true;
    try {
      if (b.dataset.state === 'on') await push.disable();
      else {
        const r = await push.enable();
        if (r === 'denied') toast('通知が許可されませんでした');
      }
    } catch { toast(GENERIC_ERR); }
    b.disabled = false;
    await renderPush();
  }

  async function maybeBanner() {
    const ban = $('#push-banner');
    ban.hidden = true;
    if (!push || getFlag()) return;
    if (!push.supported() || (typeof Notification !== 'undefined' && Notification.permission !== 'default')) return;
    if ((await push.state()) === 'off') ban.hidden = false;
  }

  // ---------- タブ ----------
  function switchTab(name) {
    for (const t of Object.keys(TITLES)) {
      $(`#pane-${t}`).hidden = t !== name;
    }
    document.querySelectorAll('.tabbar button').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === name));
    $('#home-title').textContent = TITLES[name];
    if (name !== 'me') window.scrollTo(0, 0);
  }

  function wire() {
    if (wired) return;
    wired = true;
    document.querySelectorAll('.tabbar button').forEach((b) =>
      b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('#btn-new-group').addEventListener('click', () => groupUI.openCreate({
      onCreated: (convId, name, n) => {
        toast('グループを作成しました');
        refreshAll();
        onOpenChat({ type: 'group', conversation_id: convId, display_name: name, member_count: n, role: 'owner' }, { ...me });
      } }));
    $('#form-search').addEventListener('submit', onSearch);
    $('#form-profile').addEventListener('submit', onSaveProfile);
    $('#btn-avatar').addEventListener('click', () => $('#file-avatar').click());
    $('#file-avatar').addEventListener('change', onPickAvatar);
    $('#btn-logout').addEventListener('click', () => onLogout());
    $('#btn-push').addEventListener('click', onTogglePush);
    $('#push-banner-no').addEventListener('click', () => { setFlag(); $('#push-banner').hidden = true; });
    $('#push-banner-yes').addEventListener('click', async () => {
      setFlag(); $('#push-banner').hidden = true;
      try { await push.enable(); } catch { toast(GENERIC_ERR); }
      renderPush();
    });
    document.addEventListener('visibilitychange', () => {
      if (me && document.visibilityState === 'visible') refreshSoon();
    });
  }

  return {
    mount(profile) {
      wire();
      me = { ...profile };
      renderMe();
      switchTab('friends');
      refreshAll();
      renderPush();
      maybeBanner();
      if (channel) supabase.removeChannel(channel);
      // 友達申請の受信・承認をリアルタイムに反映(RLSにより自分に関係する行のみ届く)
      channel = supabase.channel('lx-friend-requests')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'friend_requests' }, refreshSoon)
        .subscribe();
      // グループへの追加・削除・退出を反映(自分の参加行の変化のみ届く)
      if (groupChannel) supabase.removeChannel(groupChannel);
      groupChannel = supabase.channel('lx-groups-' + me.id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members', filter: `user_id=eq.${me.id}` }, refreshSoon)
        .subscribe();
    },
    refresh() { return refreshAll(); },
    getMe() { return me ? { ...me } : null; },
    goTab(name) { if (TITLES[name]) switchTab(name); },
    async friendByConv(convId) {
      const { data } = await supabase.rpc('get_friends');
      const f = (data || []).find((x) => x.conversation_id === convId);
      if (f) return f;
      const g = await supabase.rpc('get_groups');
      const hit = (g.data || []).find((x) => x.conversation_id === convId);
      return hit ? toGroupObj(hit) : null;
    },
    unmount() {
      clearTimeout(refreshTimer);
      if (channel) { supabase.removeChannel(channel); channel = null; }
      if (groupChannel) { supabase.removeChannel(groupChannel); groupChannel = null; }
      groupUI.close();
      me = null;
      $('#push-banner').hidden = true;
      for (const id of ['#friends-list', '#groups-list', '#req-in', '#req-out', '#search-result', '#block-list']) {
        $(id).replaceChildren();
      }
      $('#form-search').reset();
    },
  };
}
