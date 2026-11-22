// グループの作成・メンバー管理の画面。ユーザー入力は必ず textContent で描画する(XSS対策)
// 権限の判定は必ずサーバー側(RPC)で行う。ここでの表示の出し分けは見た目だけ。
const $ = (sel, root = document) => root.querySelector(sel);
const MAX = 50;
const ERR = '操作できませんでした。時間をおいてお試しください';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
function avatar(name) {
  return el('span', 'avatar', Array.from(name || '?')[0] || '?');
}

export function createGroupUI({ supabase, toast }) {
  const dlg = () => $('#gdialog');
  const box = () => $('#gbox');

  function show(nodes) {
    box().replaceChildren(...nodes);
    if (!dlg().open) dlg().showModal();
  }
  function close() { if (dlg().open) dlg().close(); }

  async function loadFriends() {
    const { data, error } = await supabase.rpc('get_friends');
    return error ? null : (data || []);
  }

  // 友達を選ぶ一覧(チェックボックス)。selected: Set<user_id>
  function friendPicker(friends, selected, onChange, limit) {
    const ul = el('ul', 'rows picker');
    for (const f of friends) {
      const li = el('li', 'row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'pick-' + f.user_id;
      cb.checked = selected.has(f.user_id);
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (selected.size >= limit) { cb.checked = false; return toast(`選べるのは${limit}人までです`); }
          selected.add(f.user_id);
        } else selected.delete(f.user_id);
        onChange();
      });
      const lab = el('label', 'names');
      lab.htmlFor = cb.id;
      lab.append(el('div', 'dn', f.display_name), el('div', 'uid', '@' + f.user_id));
      li.append(cb, avatar(f.display_name), lab);
      ul.appendChild(li);
    }
    return ul;
  }

  // ---------- 作成 ----------
  async function openCreate({ onCreated }) {
    const friends = await loadFriends();
    if (friends === null) return toast('通信エラー');
    if (friends.length === 0) return toast('グループに招待できる友達がいません。先に友達を追加してください');
    const selected = new Set();
    const name = el('input');
    name.type = 'text'; name.maxLength = 30; name.placeholder = 'グループ名(30文字まで)'; name.id = 'gname';
    name.setAttribute('aria-label', 'グループ名');
    const count = el('p', 'muted small', '友達を選んでください(1人以上)');
    const err = el('p', 'error');
    err.setAttribute('role', 'alert');
    const ok = btn('作成', 'primary');
    ok.disabled = true;
    const refresh = () => {
      count.textContent = selected.size ? `${selected.size}人を選択中(あなたを含めて${selected.size + 1}人)` : '友達を選んでください(1人以上)';
      ok.disabled = !name.value.trim() || selected.size === 0;
    };
    name.addEventListener('input', refresh);
    const list = friendPicker(friends, selected, refresh, MAX - 1);
    ok.addEventListener('click', async () => {
      ok.disabled = true; err.textContent = '';
      const { data, error } = await supabase.rpc('create_group', { p_name: name.value.trim(), p_user_ids: [...selected] });
      if (error || !data) {
        err.textContent = error && String(error.message || '').includes('rate_limited')
          ? '短時間に作りすぎです。しばらくしてからお試しください' : 'グループを作成できませんでした';
        return refresh();
      }
      close();
      onCreated(data, name.value.trim(), selected.size + 1);
    });
    show([el('h2', 'gtitle', 'グループを作成'), name, count, list, err,
      el('div', 'gbtns', '') , ]);
    const row = box().lastChild;
    row.append(btn('キャンセル', 'btn-sm', close), ok);
    name.focus();
  }

  // ---------- 情報・管理 ----------
  // group: { conversation_id, display_name, role }, members: get_group_members の結果(現在のメンバーのみ使う)
  async function openInfo({ group, members, meId, onChanged, onGone }) {
    const isOwner = group.role === 'owner';
    const current = members.filter((m) => m.is_member);
    const rpc = async (fn, args) => {
      const { data, error } = await supabase.rpc(fn, args);
      if (error) { toast(String(error.message || '').includes('rate_limited') ? '操作が多すぎます。しばらくしてからお試しください' : ERR); return null; }
      return data;
    };

    function home() {
      const nodes = [el('h2', 'gtitle', group.display_name), el('p', 'muted small', `メンバー ${current.length}人`)];
      const ul = el('ul', 'rows');
      for (const m of current) {
        const li = el('li', 'row');
        const names = el('div', 'names');
        names.append(el('div', 'dn', m.display_name + (m.member_id === meId ? '(あなた)' : '')), el('div', 'uid', '@' + m.user_id));
        li.append(avatar(m.display_name), names);
        if (m.role === 'owner') li.appendChild(el('span', 'tag', '作成者'));
        else if (isOwner) {
          const rm = btn('削除', 'btn-sm danger');
          rm.addEventListener('click', () => {
            if (rm.dataset.armed !== '1') { rm.dataset.armed = '1'; rm.textContent = '本当に削除'; return; }
            rm.disabled = true;
            rpc('remove_group_member', { p_conversation_id: group.conversation_id, p_user_id: m.user_id }).then((r) => {
              if (r === true) { current.splice(current.indexOf(m), 1); onChanged(); home(); }
              else if (r === false) toast('削除できませんでした');
            });
          });
          li.appendChild(rm);
        }
        ul.appendChild(li);
      }
      nodes.push(ul);
      const acts = el('div', 'gactions');
      if (isOwner) {
        acts.append(
          btn('メンバーを追加', 'btn-sm', addView),
          btn('グループ名を変更', 'btn-sm', renameView),
          btn('グループを削除', 'btn-sm danger', () => confirmView('グループを削除しますか?全員のメッセージとファイルが消え、元に戻せません。', '削除する', async () => {
            if (await rpc('delete_group', { p_conversation_id: group.conversation_id }) === true) { close(); onGone('deleted'); } else toast('削除できませんでした');
          })));
      } else {
        acts.append(btn('グループを退出', 'btn-sm danger', () => confirmView('このグループを退出しますか?退出すると、このグループのメッセージは見られなくなります。', '退出する', async () => {
          if (await rpc('leave_group', { p_conversation_id: group.conversation_id }) === true) { close(); onGone('left'); } else toast('退出できませんでした');
        })));
      }
      acts.appendChild(btn('閉じる', 'btn-sm', close));
      nodes.push(acts);
      show(nodes);
    }

    function confirmView(text, label, run) {
      const yes = btn(label, 'btn-sm danger');
      yes.addEventListener('click', async () => { yes.disabled = true; await run(); yes.disabled = false; });
      show([el('p', '', text), el('div', 'gbtns')]);
      box().lastChild.append(btn('キャンセル', 'btn-sm', home), yes);
    }

    function renameView() {
      const input = el('input'); input.type = 'text'; input.maxLength = 30; input.value = group.display_name;
      input.setAttribute('aria-label', 'グループ名');
      const save = btn('保存', 'primary');
      save.addEventListener('click', async () => {
        const v = input.value.trim();
        if (!v) return;
        save.disabled = true;
        const r = await rpc('rename_group', { p_conversation_id: group.conversation_id, p_name: v });
        if (r === true) { group.display_name = v; onChanged(v); home(); } else { save.disabled = false; if (r === false) toast('変更できませんでした'); }
      });
      show([el('h2', 'gtitle', 'グループ名を変更'), input, el('div', 'gbtns')]);
      box().lastChild.append(btn('キャンセル', 'btn-sm', home), save);
      input.focus();
    }

    async function addView() {
      const friends = await loadFriends();
      if (friends === null) return toast('通信エラー');
      const inGroup = new Set(current.map((m) => m.user_id));
      const candidates = friends.filter((f) => !inGroup.has(f.user_id));
      if (candidates.length === 0) { toast('追加できる友達がいません'); return; }
      const room = MAX - current.length;
      const selected = new Set();
      const count = el('p', 'muted small', `追加できるのはあと${room}人です`);
      const add = btn('追加', 'primary'); add.disabled = true;
      const refresh = () => { add.disabled = selected.size === 0; count.textContent = selected.size ? `${selected.size}人を選択中(あと${room}人まで)` : `追加できるのはあと${room}人です`; };
      add.addEventListener('click', async () => {
        add.disabled = true;
        const r = await rpc('add_group_members', { p_conversation_id: group.conversation_id, p_user_ids: [...selected] });
        if (r === null) { add.disabled = false; return; }
        if (r === undefined || typeof r !== 'number') return;
        toast(`${r}人を追加しました`);
        for (const f of candidates.filter((c) => selected.has(c.user_id))) current.push({ member_id: null, user_id: f.user_id, display_name: f.display_name, role: 'member', is_member: true });
        onChanged();
        home();
      });
      show([el('h2', 'gtitle', 'メンバーを追加'), count, friendPicker(candidates, selected, refresh, room), el('div', 'gbtns')]);
      box().lastChild.append(btn('キャンセル', 'btn-sm', home), add);
    }

    home();
  }

  return { openCreate, openInfo, close };
}
