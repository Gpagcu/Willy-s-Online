/* Willy's store - Customer chat and admin chat inbox */
// ---------- views: chat ----------
function chatLogHtml(msgs, myRole) {
  return msgs.map((m) => `<div class="msg ${m.sender_role === myRole ? 'me' : 'them'}">${m.image_id ? `<a href="/api/images/${esc(m.image_id)}" target="_blank" rel="noopener"><img class="chat-img" src="/api/images/${esc(m.image_id)}" alt="Photo" loading="lazy"></a>` : ''}${m.body ? esc(m.body) : ''}<small>${fmtDate(m.created_at)}</small></div>`).join('');
}

async function mountChat(fetchPath, sendPath, myRole, intro) {
  $app.insertAdjacentHTML('beforeend', `<div class="chat card"><div class="chat-log" id="log"></div>
    <div id="attach-preview" class="attach-preview" hidden></div>
    <form class="chat-form" id="cf"><button class="btn secondary attach-btn" type="button" id="attach" aria-label="Attach a photo" title="Attach a photo">&#128247;</button><input type="file" id="photo" accept="image/*" hidden><input name="body" placeholder="Type a message…" autocomplete="off" maxlength="1000"><button class="btn" type="submit">Send</button></form></div>`);
  const log = document.getElementById('log');
  let last = 0, all = [];
  async function poll() {
    try {
      const r = await api(`${fetchPath}?after=${last}`);
      if (r.messages.length) {
        all = all.concat(r.messages); last = all[all.length - 1].id;
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
        log.innerHTML = chatLogHtml(all, myRole);
        if (atBottom || all.length === r.messages.length) log.scrollTop = log.scrollHeight;
        pollUnread();
      } else if (!all.length) log.innerHTML = `<p class="muted">${esc(intro)}</p>`;
    } catch {}
  }
  await poll(); every(poll, 3500);
  // photo attach: pick -> shrink -> upload -> small preview with a remove (x) button
  let attached = null; // { id, url }
  const preview = document.getElementById('attach-preview');
  const attachBtn = document.getElementById('attach');
  const fileInput = document.getElementById('photo');
  const showPreview = () => {
    preview.hidden = !attached;
    preview.innerHTML = attached ? `<img src="${esc(attached.url)}" alt="Photo to send"><button type="button" class="attach-x" aria-label="Remove photo">&times;</button>` : '';
    const x = preview.querySelector('.attach-x'); if (x) x.onclick = () => { attached = null; showPreview(); };
  };
  attachBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files[0]; fileInput.value = ''; if (!f) return;
    attachBtn.disabled = true; attachBtn.textContent = '…';
    try { attached = await uploadPhoto(f); showPreview(); } catch (err) { toast(err.message); }
    attachBtn.disabled = false; attachBtn.innerHTML = '&#128247;';
  };
  document.getElementById('cf').onsubmit = async (e) => {
    e.preventDefault();
    const input = e.target.body; const body = input.value.trim(); if (!body && !attached) return;
    const sending = attached; input.value = ''; attached = null; showPreview();
    try { await api(sendPath, { method: 'POST', body: { body, image_id: sending ? sending.id : '' } }); await poll(); log.scrollTop = log.scrollHeight; }
    catch (err) { toast(err.message); input.value = body; if (sending) { attached = sending; showPreview(); } }
  };
}

async function viewChat() {
  if (!state.user) return needLogin();
  $app.innerHTML = '<h1>Chat with Willy\'s</h1><p class="muted">Ask about sizes, custom leather work, stock or your order. We reply as soon as we can.</p>';
  await mountChat('/chat', '/chat', 'customer', 'No messages yet. Say hello 👋');
}


async function viewAdminChat(parts) {
  if (!guardAdmin()) return;
  const uid = parts[2];
  if (uid) {
    $app.innerHTML = `${adminNav('/chat')}<p><a href="#/admin/chat">← All conversations</a></p><h1>Conversation</h1>`;
    await mountChat(`/admin/chat/${uid}`, `/admin/chat/${uid}`, 'admin', 'No messages yet.');
    return;
  }
  const r = await api('/admin/chat/threads');
  $app.innerHTML = `${adminNav('/chat')}<h1>Customer chats</h1>` + (r.threads.length
    ? `<div class="table-wrap"><table><tbody>${r.threads.map((t) => `<tr><td><a href="#/admin/chat/${t.id}"><b>${esc(t.name)}</b></a><br><span class="muted">${esc(t.email)}</span></td><td>${esc(t.last_message)}</td><td>${fmtDate(t.last_at)}</td><td>${t.unread ? `<span class="badge">${t.unread} new</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">No customer messages yet.</p>');
  every(async () => { if (location.hash === '#/admin/chat') { try { viewAdminChatListQuiet(); } catch {} } }, 8000);
}
async function viewAdminChatListQuiet() { /* simple: refresh list */ if (location.hash === '#/admin/chat') { clearTimers(); await viewAdminChat(['admin', 'chat']); } }
