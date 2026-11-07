// Photo Vault - UI (Hinglish). Token and owner/repo live only in this device's localStorage.
import { Vault, GitHubStore, CHUNK } from './vault.js';

const $ = (id) => document.getElementById(id);
const LS = { token: 'pv.token', owner: 'pv.owner', repo: 'pv.repo' };
const DEFAULT_OWNER = 'neha2905mathur';
const DEFAULT_REPO = 'photo-vault';

// Test hook: the GitHub API address can only be changed on localhost, so a shared link can never
// send the saved token to another server.
const apiParam = new URLSearchParams(location.search).get('api');
const API = apiParam && /^(http:\/\/localhost|http:\/\/127\.0\.0\.1)(:\d+)?$/.test(apiParam) ? apiParam : 'https://api.github.com';

let vault = null;
let busy = false;
const viewerUrls = [];

function show(screen) {
  for (const s of ['setup', 'unlock', 'main']) $(s).hidden = s !== screen;
  for (const s of ['usage-section', 'list-section']) $(s).hidden = screen !== 'main';
}
function msg(el, text, kind = '') {
  el.textContent = text || '';
  el.className = 'msg ' + kind;
}
function mb(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function dateStr(iso) {
  try { return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return iso; }
}
function setBusy(on) {
  busy = on;
  document.querySelectorAll('button, input[type=file]').forEach((b) => {
    if (b.id !== 'lock-btn') b.disabled = on;
  });
}
function freshStore(token) {
  return new GitHubStore({
    api: API,
    owner: localStorage.getItem(LS.owner) || DEFAULT_OWNER,
    repo: localStorage.getItem(LS.repo) || DEFAULT_REPO,
    token,
  });
}

// ---------- Screen: token (once) ----------
$('owner').value = localStorage.getItem(LS.owner) || DEFAULT_OWNER;
$('repo').value = localStorage.getItem(LS.repo) || DEFAULT_REPO;

$('token-save').onclick = async () => {
  const token = $('token').value.trim();
  const owner = $('owner').value.trim();
  const repo = $('repo').value.trim();
  if (!token || !owner || !repo) return msg($('setup-msg'), 'Token, owner aur repo teeno bharo.', 'bad');
  msg($('setup-msg'), 'Check kar raha hoon...');
  try {
    const store = new GitHubStore({ api: API, owner, repo, token });
    const info = await store.repoInfo();
    if (info.permissions && info.permissions.push === false) {
      return msg($('setup-msg'), 'Token mein write permission nahi hai. Token mein "Contents: Read and write" do.', 'bad');
    }
    localStorage.setItem(LS.token, token);
    localStorage.setItem(LS.owner, owner);
    localStorage.setItem(LS.repo, repo);
    $('token').value = '';
    msg($('setup-msg'), '');
    goUnlock();
  } catch (e) {
    msg($('setup-msg'), e.message, 'bad');
  }
};

function goUnlock() {
  $('pass-confirm-wrap').hidden = true;
  $('unlock-btn').textContent = 'Vault kholo';
  $('pass').value = '';
  $('pass2').value = '';
  msg($('unlock-msg'), '');
  show('unlock');
  $('pass').focus();
}

function resetToken() {
  if (!confirm('GitHub token is phone se hata du? (Photos GitHub par hi rahengi.)')) return;
  localStorage.removeItem(LS.token);
  if (vault) vault.lock();
  vault = null;
  show('setup');
}
$('token-reset')?.addEventListener('click', resetToken);

// ---------- Screen: passphrase ----------
$('unlock-btn').onclick = async () => {
  const pass = $('pass').value;
  const createMode = !$('pass-confirm-wrap').hidden;
  if (pass.length < 8) return msg($('unlock-msg'), 'Passphrase kam se kam 8 characters ka rakho.', 'bad');
  if (createMode && pass !== $('pass2').value) return msg($('unlock-msg'), 'Dono passphrase same nahi hain.', 'bad');
  msg($('unlock-msg'), 'Vault khul raha hai... (thoda time lagega)');
  setBusy(true);
  try {
    const store = freshStore(localStorage.getItem(LS.token));
    vault = new Vault(store);
    await vault.open(pass, { create: createMode });
    $('pass').value = '';
    $('pass2').value = '';
    msg($('unlock-msg'), '');
    show('main');
    await refresh();
  } catch (e) {
    if (e.code === 'no_vault') {
      msg($('unlock-msg'), 'Ye naya vault hai. Passphrase do do baar likho aur "Naya vault banao" dabao.', '');
      $('pass-confirm-wrap').hidden = false;
      $('unlock-btn').textContent = 'Naya vault banao';
    } else {
      msg($('unlock-msg'), e.message, 'bad');
    }
    vault = null;
  } finally {
    setBusy(false);
  }
};

$('pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('unlock-btn').click(); });

$('token-change').onclick = resetToken;

// ---------- Screen: main ----------
$('lock-btn').onclick = () => {
  if (vault) vault.lock();
  vault = null;
  clearViewerUrls();
  show('unlock');
  goUnlock();
};

$('refresh-btn').onclick = () => refresh();

async function refresh() {
  if (!vault || !vault.key) return;
  try {
    const repo = await vault.s.repoInfo();
    const u = vault.usage();
    $('usage').innerHTML =
      `<b>${u.count}</b> file(s) backup mein<br>` +
      `Aapki asli files: <b>${mb(u.plain)}</b><br>` +
      `GitHub par (encrypted): <b>${mb(u.encBytes)}</b><br>` +
      `Repo ka size: ${mb((repo.size || 0) * 1024)} (free limit: lagbhag 1 GB safe)`;
  } catch (e) {
    const u = vault.usage();
    $('usage').textContent = `${u.count} file(s). Space abhi check nahi ho paaya: ${e.message}`;
  }
  renderList();
}

function renderList() {
  const list = $('list');
  list.innerHTML = '';
  const items = [...vault.index.items].sort((a, b) => (a.added < b.added ? 1 : -1));
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Abhi koi photo backup nahi hai. Upar wale button se photos chuniye.';
    list.appendChild(p);
    return;
  }
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = it.name;
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.textContent = `${mb(it.size)} · ${dateStr(it.added)}`;
    const row = document.createElement('div');
    row.className = 'row';
    row.append(
      btn('Dekho', 'btn-small', () => view(it)),
      btn('Download', 'btn-small', () => download(it)),
      btn('Hatao', 'btn-small danger', () => removeItem(it)),
    );
    card.append(title, meta, row);
    list.appendChild(card);
  }
}

function btn(label, cls, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = 'btn ' + cls;
  b.onclick = onClick;
  return b;
}

$('pick').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length || !vault) return;
  setBusy(true);
  let done = 0, failed = 0;
  try {
    for (const f of files) {
      const chunks = Math.max(1, Math.ceil(f.size / CHUNK));
      msg($('status'), `(${done + 1}/${files.length}) "${f.name}" encrypt karke upload ho raha hai... (${chunks} hissa)`);
      try {
        await vault.upload(f, (i, n) => msg($('status'), `(${done + 1}/${files.length}) hissa ${i}/${n} upload ho raha hai...`));
        done++;
      } catch (err) {
        failed++;
        msg($('status'), `"${f.name}" upload nahi hua: ${err.message}`, 'bad');
        break;
      }
    }
    if (!failed) msg($('status'), `${done} file(s) safely backup ho gayi. ✅`, 'ok');
  } finally {
    setBusy(false);
    await refresh();
  }
});

async function download(it) {
  setBusy(true);
  msg($('status'), `"${it.name}" decrypt ho raha hai...`);
  try {
    const blob = await vault.download(it);
    const url = URL.createObjectURL(blob);
    viewerUrls.push(url);
    const a = document.createElement('a');
    a.href = url;
    a.download = it.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    msg($('status'), `"${it.name}" download ho gaya.`, 'ok');
  } catch (e) {
    msg($('status'), 'Download nahi hua: ' + e.message, 'bad');
  } finally {
    setBusy(false);
  }
}

async function view(it) {
  setBusy(true);
  msg($('status'), `"${it.name}" khul raha hai...`);
  try {
    const blob = await vault.download(it);
    const url = URL.createObjectURL(blob);
    viewerUrls.push(url);
    const box = $('viewer-body');
    box.innerHTML = '';
    if (it.mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = it.name;
      box.appendChild(img);
    } else if (it.mime.startsWith('video/')) {
      const v = document.createElement('video');
      v.src = url;
      v.controls = true;
      v.playsInline = true;
      box.appendChild(v);
    } else {
      const p = document.createElement('p');
      p.textContent = 'Ye file type yahan nahi dikh sakti. Download dabao.';
      box.appendChild(p);
    }
    $('viewer-title').textContent = it.name;
    $('viewer').showModal();
    msg($('status'), '');
  } catch (e) {
    msg($('status'), 'Nahi khul paayi: ' + e.message, 'bad');
  } finally {
    setBusy(false);
  }
}

function clearViewerUrls() {
  while (viewerUrls.length) URL.revokeObjectURL(viewerUrls.pop());
}
$('viewer-close').onclick = () => {
  $('viewer').close();
  $('viewer-body').innerHTML = '';
  clearViewerUrls();
};

async function removeItem(it) {
  if (!confirm(`"${it.name}" backup se hatana hai? Ye wapas nahi aayega.`)) return;
  setBusy(true);
  msg($('status'), `"${it.name}" hata raha hoon...`);
  try {
    await vault.remove(it);
    msg($('status'), 'Hata diya. ✅', 'ok');
  } catch (e) {
    msg($('status'), 'Hataya nahi gaya: ' + e.message, 'bad');
  } finally {
    setBusy(false);
    await refresh();
  }
}

// ---------- start ----------
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
if (localStorage.getItem(LS.token)) goUnlock(); else show('setup');
window.__pv = { get vault() { return vault; }, API };
