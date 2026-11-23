// チャット画面(1対1)。ユーザー入力は必ず textContent で描画する(XSS対策)
import { labelFromName, mediaKind, describeFile, formatSize } from './filetype.js';
import { uuid } from './uuid.js';
import { fmtDate } from './format.js';
import { createGroupUI } from './group.js';

const $ = (sel, root = document) => root.querySelector(sel);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PAGE = 50;
const COLS = 'id, conversation_id, sender_id, kind, body, reply_to, edited_at, deleted_at, created_at, '
  + 'attachments(id, storage_path, type_label, original_name, size_bytes, file_deleted_at)';

export function createChat({ supabase, toast, onClose, onGroupsChanged = () => {} }) {
  const groupUI = createGroupUI({ supabase, toast });
  let me = null;      // { id, ... }
  let friend = null;  // 友達 { user_id, display_name, avatar_path, conversation_id } またはグループ { type:'group', conversation_id, display_name, role }
  let isGroup = false;
  let members = new Map(); // グループ: member_id(uuid) → { user_id, display_name, role, is_member }
  let typers = new Map();  // グループ: 入力中の相手 uuid → 消去タイマー
  let membersLoading = null;
  let replyingTo = null;   // 返信先に選んだメッセージ
  let refs = new Map();    // 返信先として表示する、読み込み済みの一覧にない古いメッセージ
  let convId = null;
  let messages = new Map();
  let hasMore = false;
  let editingId = null;
  let channel = null;       // メッセージ・既読の変化(DBのRealtime)
  let typingChannel = null; // 入力中(broadcast)。別チャンネルにして、失敗してもメッセージ受信に影響させない
  let wired = false;
  let busy = false;
  let reads = new Map();   // 参加者(自分以外) user_id → last_read_at
  let typingTimer = null;
  let lastTypingSent = 0;
  let markTimer = null;
  let readsTimer = null;
  let lastMark = 0;

  // ---------- 描画 ----------
  const pad = (n) => String(n).padStart(2, '0');
  const timeOf = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const dayLabel = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}月${d.getDate()}日`; };

  function sorted() {
    return [...messages.values()].sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // 自分のメッセージを読んだ相手の人数(相手の last_read_at がメッセージ作成以降)
  function readCount(m) {
    let n = 0;
    const mt = Date.parse(m.created_at);
    for (const t of reads.values()) if (t && Date.parse(t) >= mt) n++;
    return n;
  }

  // ---------- グループ ----------
  function nameOf(uuidv) {
    if (uuidv === me.id) return 'あなた';
    if (!isGroup) return friend ? friend.display_name : '相手';
    const m = members.get(uuidv);
    return m ? m.display_name : '退出したメンバー';
  }
  function systemText(m) {
    const who = nameOf(m.sender_id);
    const b = String(m.body || '');
    if (b === 'created') return `${who}がグループを作成しました`;
    if (b === 'left') return `${who}が退出しました`;
    if (b.startsWith('added:')) return `${who}が${nameOf(b.slice(6))}を追加しました`;
    if (b.startsWith('removed:')) return `${who}が${nameOf(b.slice(8))}を削除しました`;
    if (b === 'icon') return `${who}がグループのアイコンを変更しました`;
    if (b.startsWith('renamed:')) return `${who}がグループ名を「${b.slice(8)}」に変更しました`;
    return '';
  }
  function activeCount() { let n = 0; for (const v of members.values()) if (v.is_member) n++; return n; }
  function renderHeadSub() {
    if (isGroup) $('#chat-sub').textContent = `${activeCount()}人`;
  }
  async function loadMembers() {
    if (!isGroup) return;
    const cid = convId;
    const { data, error } = await supabase.rpc('get_group_members', { p_conversation_id: cid });
    if (cid !== convId || error) return;
    members = new Map((data || []).map((r) => [r.member_id, r]));
    renderHeadSub();
  }
  // 知らない送信者や、メンバー構成が変わるシステムメッセージが来たらメンバー表を取り直す
  function needsMembers(m) {
    if (!isGroup) return false;
    if (m.kind === 'system') return true;
    return m.sender_id !== me.id && !members.has(m.sender_id);
  }
  async function refreshMembers() {
    if (!membersLoading) membersLoading = loadMembers().finally(() => { membersLoading = null; });
    await membersLoading;
  }
  // 他の人が名前・アイコンを変えたとき、ヘッダーに反映する
  async function refreshGroupHead() {
    if (!isGroup) return;
    const cid = convId;
    const { data } = await supabase.rpc('get_groups');
    if (cid !== convId) return;
    const g = (data || []).find((x) => x.conversation_id === cid);
    if (!g) return;
    friend.display_name = g.name;
    friend.avatar_path = g.avatar_path || null;
    friend.role = g.role;
    $('#chat-title').textContent = g.name;
    $('#chat-head-avatar').replaceChildren(headAvatar(friend));
    onGroupsChanged();
  }
  function groupGone() {
    toast('このグループは利用できなくなりました');
    close();
    onClose();
    onGroupsChanged();
  }
  function openGroupInfo() {
    if (!isGroup || !convId) return;
    groupUI.openInfo({
      group: friend, members: [...members.values()], meId: me.id,
      onChanged: (ch) => {
        if (ch && ch.name) { $('#chat-title').textContent = ch.name; }
        if (ch && 'avatar_path' in ch) $('#chat-head-avatar').replaceChildren(headAvatar(friend));
        onGroupsChanged();
        refreshMembers().then(loadLatest);
      },
      onGone: () => { close(); onClose(); onGroupsChanged(); },
    });
  }

  // ---------- 返信 ----------
  // 返信先が読み込み済みの一覧にない(古い)場合は、まとめて取得する
  async function loadRefs(rows) {
    const need = [...new Set(rows.map((r) => r.reply_to).filter((id) => id && !messages.has(id) && !refs.has(id)))];
    if (!need.length) return;
    const cid = convId;
    const { data } = await supabase.from('messages').select(COLS).in('id', need);
    if (cid !== convId) return;
    for (const r of data || []) if (r.conversation_id === cid) refs.set(r.id, r);
  }
  function snippet(t) {
    if (t.deleted_at) return 'このメッセージは削除されました';
    if (t.kind === 'file') { const a = (t.attachments || [])[0]; return '📎 ' + (a ? a.original_name : 'ファイル'); }
    const x = String(t.body || '').replace(/\s+/g, ' ').trim();
    return x.length > 60 ? x.slice(0, 60) + '…' : x;
  }
  function quoteFor(m) {
    const t = messages.get(m.reply_to) || refs.get(m.reply_to);
    const q = el('button', 'quote');
    q.type = 'button';
    if (!t) { q.classList.add('gone'); q.textContent = '元のメッセージを表示できません'; q.disabled = true; return q; }
    q.appendChild(el('span', 'q-name', nameOf(t.sender_id)));
    q.appendChild(el('span', 'q-text' + (t.deleted_at ? ' gone' : ''), snippet(t)));
    q.setAttribute('aria-label', '返信元のメッセージ');
    q.addEventListener('click', () => jumpTo(t.id));
    return q;
  }
  function jumpTo(id) {
    const row = $('#chat-list').querySelector(`.msg[data-id="${id}"]`);
    if (!row) return toast('元のメッセージは、さかのぼって読み込むと表示されます');
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1200);
  }
  function startReply(m) {
    replyingTo = m;
    $('#chat-reply-name').textContent = nameOf(m.sender_id) + 'に返信';
    $('#chat-reply-text').textContent = snippet(m);
    $('#chat-reply-bar').hidden = false;
    $('#chat-input').focus();
  }
  function cancelReply() {
    replyingTo = null;
    $('#chat-reply-bar').hidden = true;
  }

  function bubbleFor(m) {
    if (m.kind === 'system') return el('div', 'sys', systemText(m));
    const mine = m.sender_id === me.id;
    const row = el('div', 'msg ' + (mine ? 'mine' : 'theirs'));
    row.dataset.id = m.id;
    const bubble = el('div', 'bubble');
    const att = (m.attachments || [])[0];

    if (m.deleted_at) {
      bubble.classList.add('deleted');
      bubble.textContent = 'このメッセージは削除されました';
    } else if (m.kind === 'file' && att) {
      bubble.classList.add('file');
      bubble.appendChild(el('div', 'file-title', describeFile(labelFromName(att.original_name))));
      bubble.appendChild(el('div', 'file-name', `${att.original_name}(${formatSize(att.size_bytes)})`));
      if (att.file_deleted_at) {
        bubble.appendChild(el('div', 'file-note', '保存期間が終了したため、ダウンロードできません'));
      } else {
        const acts = el('div', 'file-actions');
        const kind = mediaKind(att.original_name);
        if (kind) {
          const v = el('button', 'btn-sm', kind === 'image' ? '開く' : '再生');
          v.type = 'button';
          v.addEventListener('click', () => preview(att, kind));
          acts.appendChild(v);
        }
        const b = el('button', 'btn-sm', 'ダウンロード');
        b.type = 'button';
        b.addEventListener('click', () => download(att, b));
        acts.appendChild(b);
        bubble.appendChild(acts);
      }
    } else if (m.reply_to) {
      bubble.appendChild(el('div', 'btext', m.body ?? ''));
    } else {
      bubble.textContent = m.body ?? '';
    }
    if (m.reply_to && !m.deleted_at) bubble.prepend(quoteFor(m));

    const meta = el('div', 'meta');
    if (mine && !m.deleted_at) {
      const n = readCount(m);
      if (n > 0) meta.appendChild(el('span', 'read', reads.size > 1 ? `既読 ${n}` : '既読'));
    }
    if (m.edited_at && !m.deleted_at) meta.appendChild(el('span', '', '編集済み'));
    meta.appendChild(el('span', '', timeOf(m.created_at)));
    if (!m.deleted_at) {
      const more = el('button', 'more', '⋯');
      more.type = 'button';
      more.setAttribute('aria-label', 'メッセージの操作');
      more.addEventListener('click', () => messageMenu(m));
      meta.prepend(more);
    }
    const wrap = el('div', 'bwrap');
    if (isGroup && !mine) wrap.appendChild(el('div', 'sender', nameOf(m.sender_id)));
    wrap.append(bubble, meta);
    row.appendChild(wrap);
    return row;
  }

  function render({ keepBottom = true } = {}) {
    if (replyingTo) {
      const cur = messages.get(replyingTo.id) || refs.get(replyingTo.id);
      if (cur && cur.deleted_at) { cancelReply(); toast('返信先のメッセージが削除されました'); }
    }
    const list = $('#chat-list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const prevHeight = list.scrollHeight;
    const nodes = [];
    if (hasMore) {
      const more = el('button', 'btn-sm older', '以前のメッセージを表示');
      more.type = 'button';
      more.addEventListener('click', loadOlder);
      nodes.push(more);
    }
    let lastDay = '';
    for (const m of sorted()) {
      const k = dayKey(m.created_at);
      if (k !== lastDay) { nodes.push(el('div', 'day', dayLabel(m.created_at))); lastDay = k; }
      nodes.push(bubbleFor(m));
    }
    if (nodes.length === 0) nodes.push(el('p', 'muted center', 'まだメッセージはありません'));
    list.replaceChildren(...nodes);
    if (keepBottom && nearBottom) list.scrollTop = list.scrollHeight;
    else list.scrollTop += list.scrollHeight - prevHeight;
  }

  // ---------- 取得 ----------
  function merge(rows) {
    for (const r of rows) messages.set(r.id, r);
  }

  async function loadLatest() {
    const { data, error } = await supabase.from('messages').select(COLS)
      .eq('conversation_id', convId).order('created_at', { ascending: false }).limit(PAGE);
    if (error) return toast('通信エラー');
    merge(data || []);
    hasMore = (data || []).length === PAGE;
    await Promise.all([loadReads(), isGroup ? refreshMembers() : null, loadRefs(data || [])]);
    render();
    $('#chat-list').scrollTop = $('#chat-list').scrollHeight;
    markRead();
    prefetchUrls();
  }

  // ---------- 既読 ----------
  async function loadReads() {
    const cid = convId;
    const { data, error } = await supabase.from('conversation_members').select('user_id, last_read_at').eq('conversation_id', cid);
    if (cid !== convId) return;
    if (error) { warnOnce('既読情報を取得できませんでした', error); return; }
    // グループから削除された・グループが削除された場合、参加者の行が1件も見えなくなる
    if (isGroup && (data || []).length === 0) { groupGone(); return; }
    reads = new Map((data || []).filter((r) => r.user_id !== me.id).map((r) => [r.user_id, r.last_read_at]));
  }

  // 画面を見ているときだけ既読にする(連続呼び出しは間引く)
  function markRead() {
    if (!convId || document.visibilityState !== 'visible') return;
    const wait = 1500 - (Date.now() - lastMark);
    if (wait > 0) {
      if (!markTimer) markTimer = setTimeout(() => { markTimer = null; markRead(); }, wait);
      return;
    }
    lastMark = Date.now();
    supabase.rpc('mark_read', { p_conversation_id: convId }).then(({ data, error }) => {
      if (error || data !== true) warnOnce('既読を記録できませんでした', error || { message: 'false' });
    });
  }

  // 失敗してもユーザーには表示しない(開発者向けにコンソールにだけ残す)
  function warnOnce(msg, err) {
    console.warn('[LXTalk]', msg, err && (err.code || err.message));
  }

  // 相手の既読を定期的に確認(リアルタイムが届かない環境のための保険)
  async function refreshReads() {
    if (!convId || document.visibilityState !== 'visible') return;
    const before = JSON.stringify([...reads]);
    await loadReads();
    if (JSON.stringify([...reads]) !== before) render();
  }

  // ---------- 入力中 ----------
  function showTyping(uid) {
    if (isGroup && uid) {
      clearTimeout(typers.get(uid));
      typers.set(uid, setTimeout(() => { typers.delete(uid); renderTyping(); }, 5000));
      renderTyping();
      return;
    }
    $('#chat-typing').hidden = false;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(hideTyping, 5000);
  }
  function renderTyping() {
    const box = $('#chat-typing');
    const ids = [...typers.keys()];
    if (!ids.length) { box.hidden = true; return; }
    const names = ids.map((u) => { const m = members.get(u); return m ? m.display_name : null; });
    box.textContent = ids.length === 1 ? `${names[0] || 'メンバー'}が入力中…`
      : ids.length === 2 && names[0] && names[1] ? `${names[0]}、${names[1]}が入力中…` : `${ids.length}人が入力中…`;
    box.hidden = false;
  }
  function hideTyping(uid) {
    if (isGroup) {
      if (uid) { clearTimeout(typers.get(uid)); typers.delete(uid); }
      else { for (const t of typers.values()) clearTimeout(t); typers.clear(); }
      renderTyping();
      return;
    }
    clearTimeout(typingTimer);
    typingTimer = null;
    $('#chat-typing').hidden = true;
  }
  function sendTyping() {
    if (!typingChannel || editingId) return;
    const now = Date.now();
    if (now - lastTypingSent < 3000) return;     // 3秒に1回まで
    lastTypingSent = now;
    typingChannel.send({ type: 'broadcast', event: 'typing', payload: { u: me.id } });
  }

  async function loadOlder() {
    const oldest = sorted()[0];
    if (!oldest) return;
    const { data, error } = await supabase.from('messages').select(COLS)
      .eq('conversation_id', convId).lt('created_at', oldest.created_at)
      .order('created_at', { ascending: false }).limit(PAGE);
    if (error) return toast('通信エラー');
    merge(data || []);
    hasMore = (data || []).length === PAGE;
    await loadRefs(data || []);
    render({ keepBottom: false });
  }

  async function fetchOne(id) {
    const { data } = await supabase.from('messages').select(COLS).eq('id', id).maybeSingle();
    if (data && data.conversation_id === convId) {
      messages.set(data.id, data);
      await loadRefs([data]);
      if (refs.has(data.id)) refs.set(data.id, data);
      if (needsMembers(data)) { await refreshMembers(); if (data.kind === 'system') refreshGroupHead(); }
      if (data.conversation_id !== convId) return;
      render();
      if (data.sender_id !== me.id) { hideTyping(data.sender_id); markRead(); }
      prefetchUrls();
    }
  }

  // ---------- 送信・編集・削除 ----------
  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const ta = $('#chat-input');
    const text = ta.value.trim();
    if (!text) return;
    busy = true;
    try {
      if (editingId) {
        const { data, error } = await supabase.rpc('edit_message', { p_message_id: editingId, p_body: text });
        if (error || data !== true) return toast('編集できませんでした');
        const id = editingId;
        cancelEdit();
        await fetchOne(id);
      } else {
        const { data, error } = await supabase.rpc('send_message', { p_conversation_id: convId, p_body: text, p_reply_to: replyingTo ? replyingTo.id : null });
        if (error) {
          return toast(String(error.message || '').includes('rate_limited')
            ? '送信が多すぎます。少し待ってからお試しください' : '送信できませんでした');
        }
        if (!data) return toast('送信できませんでした');
        ta.value = '';
        cancelReply();
        autosize();
        ta.focus();   // 送信してもキーボードを閉じない
        await fetchOne(data);
      }
    } finally {
      busy = false;
    }
  }

  function startEdit(m) {
    cancelReply();
    editingId = m.id;
    $('#chat-edit-bar').hidden = false;
    $('#chat-send').textContent = '保存';
    const ta = $('#chat-input');
    ta.value = m.body ?? '';
    autosize();
    ta.focus();
  }

  function cancelEdit() {
    editingId = null;
    $('#chat-edit-bar').hidden = true;
    $('#chat-send').textContent = '送信';
    $('#chat-input').value = '';
    autosize();
  }

  function messageMenu(m) {
    const actions = [];
    if (m.sender_id !== me.id) {
      actions.push({ label: '返信する', run: () => startReply(m) });
      return openSheet('メッセージの操作', actions);
    }
    if (m.kind === 'text') actions.push({ label: '編集する', run: () => startEdit(m) });
    actions.push({ label: '削除する', danger: true, run: () => confirmDelete(m) });
    openSheet('メッセージの操作', actions);
  }

  function confirmDelete(m) {
    openSheet('このメッセージを削除しますか?(元に戻せません)', [
      { label: '削除する', danger: true, run: async () => {
        const { data, error } = await supabase.rpc('delete_message', { p_message_id: m.id });
        if (error || data !== true) return toast('削除できませんでした');
        if (editingId === m.id) cancelEdit();
        await fetchOne(m.id);
      } },
    ]);
  }

  function openSheet(title, actions) {
    const dlg = $('#sheet');
    $('#sheet-title').textContent = title;
    const box = $('#sheet-actions');
    box.replaceChildren();
    for (const a of actions) {
      const b = el('button', a.danger ? 'danger' : '', a.label);
      b.type = 'button';
      b.addEventListener('click', () => { dlg.close(); a.run?.(); });
      box.appendChild(b);
    }
    const cancel = el('button', '', 'キャンセル');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dlg.close());
    box.appendChild(cancel);
    dlg.showModal();
  }

  // ---------- ファイル ----------
  async function onPickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;
    // 種類(拡張子・形式)は制限しない。容量のみ10MBまで(サーバー側でも強制)
    if (file.size > MAX_FILE_BYTES) return toast('ファイルは10MB以下にしてください');
    busy = true;
    $('#chat-attach').disabled = true;
    toast('ファイルを送信中…');
    try {
      const label = labelFromName(file.name);
      const path = `${convId}/${uuid()}`;
      const up = await supabase.storage.from('chat-files')
        .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
      if (up.error) return toast('ファイルを送信できませんでした');
      const { data, error } = await supabase.rpc('send_file_message', {
        p_conversation_id: convId, p_storage_path: path, p_original_name: file.name, p_type_label: label,
        p_reply_to: replyingTo ? replyingTo.id : null,
      });
      if (error || !data) return toast('ファイルを送信できませんでした');
      toast('送信しました');
      cancelReply();
      await fetchOne(data);
    } finally {
      busy = false;
      $('#chat-attach').disabled = false;
    }
  }

  // 署名付きURLは会話を開いたときにまとめて取得しておく(クリック時の待ち時間をなくす)
  const urlCache = new Map();   // storage_path → { url, exp }
  const URL_SEC = 1800;
  async function signedUrl(path) {
    const c = urlCache.get(path);
    if (c && c.exp > Date.now() + 60000) return c.url;
    const { data, error } = await supabase.storage.from('chat-files').createSignedUrl(path, URL_SEC);
    if (error || !data?.signedUrl) return null;
    urlCache.set(path, { url: data.signedUrl, exp: Date.now() + URL_SEC * 1000 });
    return data.signedUrl;
  }
  async function prefetchUrls() {
    const store = supabase.storage.from('chat-files');
    if (!store.createSignedUrls) return;
    const paths = sorted().slice(-60).filter((m) => !m.deleted_at).flatMap((m) => m.attachments || [])
      .filter((a) => !a.file_deleted_at && mediaKind(a.original_name) && !urlCache.has(a.storage_path))
      .map((a) => a.storage_path).slice(-20);
    if (!paths.length) return;
    const cid = convId;
    const { data } = await store.createSignedUrls(paths, URL_SEC);
    if (cid !== convId) return;
    for (const r of data || []) if (r.signedUrl && !r.error) urlCache.set(r.path, { url: r.signedUrl, exp: Date.now() + URL_SEC * 1000 });
  }

  // 画像・動画・音声(拡張子で判断)は、ダウンロードとは別に画面内で全画面表示する
  let viewToken = 0;
  async function preview(att, kind) {
    const token = ++viewToken;
    const dlg = $('#viewer');
    const box = $('#viewer-media');
    // 押した瞬間に全画面を開き、「読み込み中」を出す(体感の待ち時間を短くする)
    const spin = el('div', 'viewer-loading', '読み込み中…');
    box.replaceChildren(spin);
    $('#viewer-name').textContent = att.original_name;
    $('#viewer-dl').onclick = (ev) => download(att, ev.currentTarget);
    if (!dlg.open) dlg.showModal();
    const url = await signedUrl(att.storage_path);
    if (token !== viewToken || !dlg.open) return;           // 待っている間に閉じられた
    if (!url) { spin.textContent = '表示できませんでした'; return; }
    const m = document.createElement(kind === 'image' ? 'img' : kind === 'video' ? 'video' : 'audio');
    m.className = 'viewer-' + kind;
    m.hidden = kind === 'image';                            // 画像は読み込みが終わってから表示(途中の崩れた表示を避ける)
    if (kind !== 'image') { m.controls = true; m.autoplay = true; m.playsInline = true; m.preload = 'auto'; }
    else { m.alt = att.original_name; m.decoding = 'async'; }
    const ready = () => { if (token === viewToken) { spin.remove(); m.hidden = false; } };
    m.addEventListener(kind === 'image' ? 'load' : 'loadeddata', ready, { once: true });
    if (kind === 'audio') m.addEventListener('loadedmetadata', ready, { once: true });
    m.addEventListener('error', () => {
      if (token !== viewToken) return;
      spin.textContent = 'このファイルはブラウザで表示できません。ダウンロードをお試しください';
      m.remove();
    });
    m.src = url;
    box.appendChild(m);
  }

  function closeViewer() {
    const dlg = $('#viewer');
    const box = $('#viewer-media');
    viewToken++;
    box.querySelectorAll('video,audio').forEach((m) => { m.pause(); m.removeAttribute('src'); m.load(); });
    box.replaceChildren();
    if (dlg.open) dlg.close();
  }

  async function download(att, btn) {
    btn.disabled = true;
    try {
      // 署名付きURL(60秒)。download を付けて、必ず「保存」として扱わせる(ブラウザ内で開かない)
      const { data, error } = await supabase.storage.from('chat-files')
        .createSignedUrl(att.storage_path, 60, { download: att.original_name });
      if (error || !data?.signedUrl) return toast('ダウンロードできませんでした');
      const a = document.createElement('a');
      a.href = data.signedUrl;
      a.rel = 'noopener';
      a.download = att.original_name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 入力欄 ----------
  function autosize() {
    const ta = $('#chat-input');
    ta.style.height = 'auto';
    // box-sizing: border-box のため、枠線(上下)の分も高さに含める。含めないと1行でも2pxあふれてスクロールしてしまう
    const h = ta.scrollHeight + (ta.offsetHeight - ta.clientHeight);
    ta.style.height = Math.min(h, 140) + 'px';
    // 上限(140px)に達するまでは内部スクロールさせない
    ta.style.overflowY = h > 140 ? 'auto' : 'hidden';
  }

  function wire() {
    if (wired) return;
    wired = true;
    $('#form-chat').addEventListener('submit', onSubmit);
    $('#chat-input').addEventListener('input', () => { autosize(); if ($('#chat-input').value.trim()) sendTyping(); });
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#form-chat').requestSubmit(); }
    });
    $('#chat-attach').addEventListener('click', () => $('#file-chat').click());
    $('#file-chat').addEventListener('change', onPickFile);
    $('#chat-back').addEventListener('click', () => { close(); onClose(); });
    // 送信・添付ボタンを押しても入力欄からフォーカスを奪わない(スマホでキーボードが閉じるのを防ぐ)
    for (const id of ['#chat-send', '#chat-attach']) $(id).addEventListener('mousedown', (ev) => ev.preventDefault());
    $('#viewer-close').addEventListener('click', closeViewer);
    $('#viewer').addEventListener('cancel', (ev) => { ev.preventDefault(); closeViewer(); });
    $('#viewer').addEventListener('click', (ev) => { if (ev.target.id === 'viewer') closeViewer(); });
    $('#chat-edit-cancel').addEventListener('click', cancelEdit);
    $('#chat-reply-cancel').addEventListener('click', cancelReply);
    $('#chat-head-info').addEventListener('click', openGroupInfo);
    document.addEventListener('visibilitychange', () => {
      if (convId && document.visibilityState === 'visible') loadLatest();
    });
  }

  function headAvatar(p) {
    const initial = Array.from(p.display_name || '?')[0] || '?';
    const fallback = () => el('span', 'avatar', initial);
    if (!p.avatar_path) return fallback();
    const img = el('img', 'avatar');
    img.alt = '';
    img.src = supabase.storage.from('avatars').getPublicUrl(p.avatar_path).data.publicUrl;
    img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
    return img;
  }

  // ---------- 公開API ----------
  function open(f, meProfile) {
    wire();
    close();
    me = meProfile;
    friend = f;
    isGroup = f.type === 'group';
    members = new Map();
    typers = new Map();
    refs = new Map();
    cancelReply();
    convId = f.conversation_id;
    $('#chat-head-info').classList.toggle('tappable', isGroup);
    $('#chat-head-info').disabled = !isGroup;
    messages = new Map();
    hasMore = false;
    editingId = null;
    $('#chat-edit-bar').hidden = true;
    $('#chat-send').textContent = '送信';
    $('#chat-input').value = '';
    autosize();
    $('#chat-head-avatar').replaceChildren(headAvatar(f));
    $('#chat-title').textContent = f.display_name;
    $('#chat-sub').textContent = isGroup ? `${f.member_count || ''}${f.member_count ? '人' : ''}`
      : '@' + f.user_id + (f.joined_at ? ` ・ ${fmtDate(f.joined_at)}に登録` : '');
    $('#chat-list').replaceChildren();
    clearInterval(readsTimer);
    readsTimer = setInterval(refreshReads, 10000);
    loadLatest();
    // 入力中(broadcast): 会話の参加者だけが送受信できる(サーバー側のRLSで制限)
    typingChannel = supabase.channel('lx-chat-' + convId, { config: { private: true } })
      .on('broadcast', { event: 'typing' }, (msg) => { if (msg?.payload?.u && msg.payload.u !== me.id) showTyping(msg.payload.u); })
      .subscribe();
    // 新着・編集・削除・既読をリアルタイムに反映(RLSにより会話の参加者にだけ届く)
    channel = supabase.channel('lx-db-' + convId)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversation_members', filter: `conversation_id=eq.${convId}` },
        (payload) => {
          const r = payload.new;
          if (r && r.user_id && r.user_id !== me.id) { reads.set(r.user_id, r.last_read_at); render(); }
        })
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `conversation_id=eq.${convId}` },
        (payload) => { const id = payload.new?.id; if (id) fetchOne(id); })
      .subscribe();
  }

  function close() {
    if (channel) { supabase.removeChannel(channel); channel = null; }
    if (typingChannel) { supabase.removeChannel(typingChannel); typingChannel = null; }
    convId = null;
    hideTyping();
    friend = null;
    refs = new Map();
    replyingTo = null;
    $('#chat-reply-bar').hidden = true;
    isGroup = false;
    members = new Map();
    typers = new Map();
    groupUI.close();
    reads = new Map();
    clearInterval(readsTimer); readsTimer = null;
    urlCache.clear();
    clearTimeout(markTimer); markTimer = null; lastMark = 0; lastTypingSent = 0;
    hideTyping();
    messages = new Map();
    editingId = null;
    const list = $('#chat-list');
    if (list) list.replaceChildren();
  }

  return { open, close };
}
