// HTML + CSS for the host's self-service web UI. Vanilla — no framework,
// no build step. Each page is a single function returning a complete
// document so the host can serve it with one write. The CSS lives in
// SHARED_CSS to share rules across pages without duplicating bytes on
// every response.
//
// Design constraints:
//   - Server-rendered. JS is minimal (form fetch + redirect) and stays
//     inline so there's nothing to bundle.
//   - Single-file mental model. A teammate landing on the host should
//     immediately understand login → dashboard → mint a token → paste
//     into their margo.config. No nested SPAs, no client-side routing.
//   - No external assets. The page works offline / in air-gapped envs.

const SHARED_CSS = `
  :root {
    --bg: #fafafa;
    --panel: #fff;
    --fg: #18181b;
    --muted: #71717a;
    --border: #e4e4e7;
    --accent: hsl(220 70% 50%);
    --accent-fg: #fff;
    --danger: hsl(0 70% 45%);
    --ok: hsl(140 50% 35%);
    --code-bg: #f4f4f5;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg); color: var(--fg);
    min-height: 100vh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .container {
    max-width: 720px; margin: 0 auto; padding: 48px 24px;
  }
  .container.narrow { max-width: 380px; }
  .brand {
    font-size: 18px; font-weight: 600; letter-spacing: -0.02em;
    color: var(--fg); margin-bottom: 32px; display: flex; align-items: center; gap: 6px;
  }
  .brand .dot {
    display: inline-block; width: 10px; height: 10px; border-radius: 50%;
    background: var(--accent);
  }
  .panel {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 24px;
  }
  h1 { margin: 0 0 16px; font-size: 20px; font-weight: 600; }
  h2 { margin: 24px 0 12px; font-size: 16px; font-weight: 600; }
  p.muted { color: var(--muted); margin: 0 0 16px; font-size: 13px; }
  label { display: block; margin: 12px 0 4px; font-size: 13px; font-weight: 500; }
  input[type="email"], input[type="text"], input[type="password"] {
    width: 100%; padding: 9px 12px; border: 1px solid var(--border);
    border-radius: 6px; font-size: 14px; background: #fff; color: var(--fg);
    font-family: inherit;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  button {
    padding: 9px 14px; border: 0; border-radius: 6px;
    font-size: 14px; font-weight: 500; cursor: pointer; font-family: inherit;
  }
  button.primary { background: var(--accent); color: var(--accent-fg); }
  button.primary:hover { filter: brightness(1.05); }
  button.subtle {
    background: transparent; color: var(--muted); padding: 4px 8px;
    font-size: 12px;
  }
  button.subtle:hover { color: var(--fg); }
  button.danger { background: transparent; color: var(--danger); padding: 4px 8px; font-size: 12px; }
  button.danger:hover { background: hsl(0 70% 45% / .08); }
  button[disabled] { opacity: .5; cursor: not-allowed; }
  .actions { display: flex; gap: 8px; margin-top: 20px; align-items: center; }
  .actions .grow { flex: 1; }
  .alt { font-size: 13px; color: var(--muted); }
  .error {
    margin-top: 14px; padding: 9px 12px; border-radius: 6px;
    background: hsl(0 70% 50% / .08); color: var(--danger); font-size: 13px;
    border: 1px solid hsl(0 70% 50% / .2);
  }
  .ok-banner {
    margin: 0 0 16px; padding: 10px 12px; border-radius: 6px;
    background: hsl(140 50% 50% / .08); color: var(--ok); font-size: 13px;
    border: 1px solid hsl(140 50% 50% / .2);
  }
  .token-grid {
    border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
  }
  .token-row {
    display: grid; grid-template-columns: 1fr auto auto; gap: 12px;
    align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .token-row:last-child { border-bottom: 0; }
  .token-label { font-weight: 500; }
  .token-meta { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; }
  .empty { padding: 20px; text-align: center; color: var(--muted); font-size: 13px; }
  code, .code {
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;
    font-size: 12px;
  }
  pre.token-display {
    margin: 12px 0 0; padding: 12px; background: var(--code-bg);
    border-radius: 6px; overflow-x: auto; font-size: 12px;
    word-break: break-all; white-space: pre-wrap;
  }
  .nav {
    display: flex; align-items: center; gap: 12px; margin-bottom: 24px;
    padding-bottom: 12px; border-bottom: 1px solid var(--border);
  }
  .nav .brand { margin: 0; }
  .nav .grow { flex: 1; }
  .nav .who { font-size: 13px; color: var(--muted); }
  .badge {
    display: inline-block; padding: 1px 6px; border-radius: 10px;
    font-size: 10px; line-height: 1.5; vertical-align: middle;
    background: hsl(220 70% 50% / .12); color: var(--accent); margin-left: 4px;
  }
  .project-grid {
    display: grid; gap: 8px; margin-top: 8px;
  }
  .project-row {
    display: flex; gap: 8px; align-items: center; padding: 8px 10px;
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--panel); font-size: 13px;
  }
  .project-row .slug { font-weight: 500; }
  .project-row .role {
    margin-left: auto; padding: 2px 8px; border-radius: 10px;
    background: var(--code-bg); color: var(--muted); font-size: 11px;
  }
  a.project-row { color: inherit; }
  a.project-row:hover { background: hsl(220 70% 50% / .04); text-decoration: none; }
  h1 .role {
    padding: 2px 8px; border-radius: 10px;
    background: var(--code-bg); color: var(--muted); font-size: 11px;
    vertical-align: middle; font-weight: 500;
  }
  .member-grid {
    border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
    background: var(--panel);
  }
  .member-row {
    display: grid; grid-template-columns: 1fr auto auto; gap: 12px;
    align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border);
  }
  .member-row:last-child { border-bottom: 0; }
  .member-name { font-weight: 500; font-size: 13px; }
  .member-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .member-meta .muted { font-size: 12px; }
  select.role-select {
    padding: 4px 8px; border: 1px solid var(--border);
    border-radius: 6px; font-size: 12px; background: #fff;
    font-family: inherit;
  }
  select#invite-role {
    padding: 9px 12px; border: 1px solid var(--border);
    border-radius: 6px; font-size: 14px; background: #fff; font-family: inherit;
  }
`

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · margo</title>
  <style>${SHARED_CSS}</style>
</head>
<body>
${body}
</body>
</html>`
}

export function renderLogin(opts: { errorMessage?: string } = {}): string {
  const error = opts.errorMessage
    ? `<div class="error">${escapeHtml(opts.errorMessage)}</div>`
    : ''
  return shell('Log in', `
    <div class="container narrow">
      <div class="brand"><span class="dot"></span> margo host</div>
      <div class="panel">
        <h1>Log in</h1>
        <p class="muted">Use the email and password you signed up with.</p>
        <form id="form" autocomplete="on">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" required autofocus />
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
          <div class="actions">
            <button type="submit" class="primary">Log in</button>
            <span class="alt">No account? <a href="/signup">Sign up</a></span>
          </div>
        </form>
        ${error}
        <div id="error" class="error" style="display:none"></div>
      </div>
    </div>
    <script>
      const form = document.getElementById('form');
      const errorBox = document.getElementById('error');
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        errorBox.style.display = 'none';
        const fd = new FormData(form);
        const body = { email: fd.get('email'), password: fd.get('password') };
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) { location.href = '/dashboard'; return; }
        const data = await res.json().catch(() => ({}));
        errorBox.textContent = data.error || ('Login failed (' + res.status + ').');
        errorBox.style.display = 'block';
      });
    </script>
  `)
}

export function renderSignup(opts: { errorMessage?: string } = {}): string {
  const error = opts.errorMessage
    ? `<div class="error">${escapeHtml(opts.errorMessage)}</div>`
    : ''
  return shell('Sign up', `
    <div class="container narrow">
      <div class="brand"><span class="dot"></span> margo host</div>
      <div class="panel">
        <h1>Create your account</h1>
        <p class="muted">Anyone who can reach this host can sign up. Project access is granted by an admin.</p>
        <form id="form" autocomplete="on">
          <label for="name">Display name</label>
          <input id="name" name="name" type="text" autocomplete="name" required autofocus />
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" required />
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8" />
          <div class="actions">
            <button type="submit" class="primary">Create account</button>
            <span class="alt">Have one? <a href="/login">Log in</a></span>
          </div>
        </form>
        ${error}
        <div id="error" class="error" style="display:none"></div>
      </div>
    </div>
    <script>
      const form = document.getElementById('form');
      const errorBox = document.getElementById('error');
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        errorBox.style.display = 'none';
        const fd = new FormData(form);
        const body = {
          name: fd.get('name'),
          email: fd.get('email'),
          password: fd.get('password'),
        };
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) { location.href = '/dashboard'; return; }
        const data = await res.json().catch(() => ({}));
        errorBox.textContent = data.error || ('Signup failed (' + res.status + ').');
        errorBox.style.display = 'block';
      });
    </script>
  `)
}

export interface DashboardData {
  user: { id: string; email: string; name: string; isSuperuser?: boolean }
  projects: { slug: string; name: string; role: string }[]
  tokens: { id: string; label: string; createdAt: string; lastUsedAt?: string; plainPrefix: string }[]
}

export interface ProjectPageData {
  user: { id: string; email: string; name: string; isSuperuser: boolean }
  project: { slug: string; name: string; createdAt: string }
  /** The viewer's role on this project (or 'read' for superusers without membership). */
  myRole: string
  /** Whether the viewer can manage members (project admin or superuser). */
  canManage: boolean
  members: { userId: string; email: string; name: string; role: string }[]
}

export function renderDashboard(data: DashboardData): string {
  const projectRows = data.projects.length === 0
    ? `<div class="empty">No projects yet. Create one above, or wait for a project admin to invite you.</div>`
    : `<div class="project-grid">${data.projects.map((p) => `
        <a class="project-row" href="/projects/${escapeHtml(p.slug)}">
          <span class="slug">${escapeHtml(p.slug)}</span>
          <span class="muted">${escapeHtml(p.name)}</span>
          <span class="role">${escapeHtml(p.role)}</span>
        </a>
      `).join('')}</div>`

  const tokenRows = data.tokens.length === 0
    ? `<div class="empty">No tokens yet. Click <strong>New token</strong> to mint one.</div>`
    : `<div class="token-grid">${data.tokens.map((t) => `
        <div class="token-row" data-token-id="${escapeHtml(t.id)}">
          <div>
            <div class="token-label">${escapeHtml(t.label)}</div>
            <div class="token-meta">
              <span class="code">${escapeHtml(t.plainPrefix)}…</span>
              · created ${formatDate(t.createdAt)}
              ${t.lastUsedAt ? `· last used ${formatDate(t.lastUsedAt)}` : '· never used'}
            </div>
          </div>
          <span></span>
          <button type="button" class="danger" data-revoke="${escapeHtml(t.id)}">Revoke</button>
        </div>
      `).join('')}</div>`

  const superBadge = data.user.isSuperuser ? '<span class="badge">superuser</span>' : ''
  return shell('Dashboard', `
    <div class="container">
      <div class="nav">
        <div class="brand"><span class="dot"></span> margo host</div>
        <div class="grow"></div>
        <span class="who">${escapeHtml(data.user.name)} &lt;${escapeHtml(data.user.email)}&gt;${superBadge}</span>
        <button type="button" class="subtle" id="logout">Log out</button>
      </div>

      <h1>Your projects</h1>
      <p class="muted">Create a new project (you'll be its admin) or open one you've already been invited to.</p>
      <div class="actions" style="margin-bottom:12px">
        <input id="new-project-slug" type="text" placeholder="Slug (e.g. acme-pricing)" />
        <input id="new-project-name" type="text" placeholder="Display name" />
        <button type="button" class="primary" id="new-project">Create project</button>
      </div>
      <div id="new-project-error" class="error" style="display:none"></div>
      ${projectRows}

      <h1 style="margin-top:32px">Your tokens</h1>
      <p class="muted">Use a token as <code>MARGO_TOKEN</code> in your shell. Issued tokens are hashed at rest — once you close the panel below, the host can no longer reveal them.</p>

      <div class="actions" style="margin-bottom:12px">
        <input id="new-token-label" type="text" placeholder="Label (e.g. laptop-dev)" />
        <button type="button" class="primary" id="new-token">Mint new token</button>
      </div>

      <div id="new-token-panel" style="display:none; margin-bottom:16px">
        <div class="ok-banner">Token created. Copy it now — you won't see it again.</div>
        <pre class="token-display" id="new-token-value"></pre>
      </div>

      <div id="tokens">${tokenRows}</div>
    </div>

    <script>
      document.getElementById('logout').addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        location.href = '/login';
      });

      const newProjectError = document.getElementById('new-project-error');
      document.getElementById('new-project').addEventListener('click', async () => {
        newProjectError.style.display = 'none';
        const slug = document.getElementById('new-project-slug').value.trim();
        const name = document.getElementById('new-project-name').value.trim();
        if (!slug || !name) {
          newProjectError.textContent = 'Slug and display name are required.';
          newProjectError.style.display = 'block';
          return;
        }
        const res = await fetch('/api/me/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug, name }),
        });
        if (res.ok) { location.href = '/projects/' + encodeURIComponent(slug); return; }
        const data = await res.json().catch(() => ({}));
        newProjectError.textContent = data.error || ('Create failed (' + res.status + ').');
        newProjectError.style.display = 'block';
      });

      const newPanel = document.getElementById('new-token-panel');
      const newValue = document.getElementById('new-token-value');
      const newInput = document.getElementById('new-token-label');
      document.getElementById('new-token').addEventListener('click', async () => {
        const label = (newInput.value || 'token').trim();
        const res = await fetch('/api/me/tokens', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label }),
        });
        if (!res.ok) { alert('Failed to mint token (' + res.status + ').'); return; }
        const data = await res.json();
        newValue.textContent = data.plainToken;
        newPanel.style.display = 'block';
        newInput.value = '';
        // Reload list after a tick so the new row is visible alongside the panel.
        setTimeout(() => reloadTokens(), 250);
      });

      document.addEventListener('click', async (ev) => {
        const id = ev.target?.dataset?.revoke;
        if (!id) return;
        if (!confirm('Revoke this token? Any client using it will stop authenticating immediately.')) return;
        const res = await fetch('/api/me/tokens/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!res.ok) { alert('Revoke failed (' + res.status + ').'); return; }
        reloadTokens();
      });

      async function reloadTokens() {
        const res = await fetch('/api/me/tokens');
        if (!res.ok) return;
        const data = await res.json();
        const wrap = document.getElementById('tokens');
        if (!data.tokens || data.tokens.length === 0) {
          wrap.innerHTML = '<div class="empty">No tokens yet. Click <strong>New token</strong> to mint one.</div>';
          return;
        }
        wrap.innerHTML = '<div class="token-grid">' + data.tokens.map((t) =>
          '<div class="token-row" data-token-id="' + escapeAttr(t.id) + '">' +
            '<div>' +
              '<div class="token-label">' + escapeText(t.label) + '</div>' +
              '<div class="token-meta">' +
                '<span class="code">' + escapeText(t.plainPrefix) + '…</span>' +
                ' · created ' + new Date(t.createdAt).toLocaleString() +
                (t.lastUsedAt ? ' · last used ' + new Date(t.lastUsedAt).toLocaleString() : ' · never used') +
              '</div>' +
            '</div>' +
            '<span></span>' +
            '<button type="button" class="danger" data-revoke="' + escapeAttr(t.id) + '">Revoke</button>' +
          '</div>'
        ).join('') + '</div>';
      }
      function escapeText(s) { return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
      function escapeAttr(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
    </script>
  `)
}

export function renderProject(data: ProjectPageData): string {
  const superBadge = data.user.isSuperuser ? '<span class="badge">superuser</span>' : ''
  const myRoleBadge = `<span class="role">${escapeHtml(data.myRole)}</span>`

  const memberRows = data.members.map((m) => `
    <div class="member-row" data-user-id="${escapeHtml(m.userId)}">
      <div class="member-meta">
        <div class="member-name">${escapeHtml(m.name)}</div>
        <div class="muted code">${escapeHtml(m.email)}</div>
      </div>
      ${data.canManage ? `
        <select class="role-select" data-user-id="${escapeHtml(m.userId)}">
          <option value="read"${m.role === 'read' ? ' selected' : ''}>read</option>
          <option value="write"${m.role === 'write' ? ' selected' : ''}>write</option>
          <option value="admin"${m.role === 'admin' ? ' selected' : ''}>admin</option>
        </select>
        <button type="button" class="danger" data-remove="${escapeHtml(m.userId)}">Remove</button>
      ` : `
        <span class="role">${escapeHtml(m.role)}</span>
        <span></span>
      `}
    </div>
  `).join('')

  const manageBlock = data.canManage ? `
    <h2>Invite a member</h2>
    <p class="muted">They must already have an account on this host — share the URL <code>/signup</code> with them first.</p>
    <div class="actions" style="margin-bottom:12px">
      <input id="invite-email" type="email" placeholder="email@your-domain" autocomplete="off" />
      <select id="invite-role">
        <option value="read">read</option>
        <option value="write" selected>write</option>
        <option value="admin">admin</option>
      </select>
      <button type="button" class="primary" id="invite-btn">Invite</button>
    </div>
    <div id="invite-error" class="error" style="display:none"></div>
  ` : ''

  return shell(`Project ${data.project.slug}`, `
    <div class="container">
      <div class="nav">
        <div class="brand"><span class="dot"></span> margo host</div>
        <div class="grow"></div>
        <a href="/dashboard" class="alt">← Dashboard</a>
        <span class="who">${escapeHtml(data.user.name)} &lt;${escapeHtml(data.user.email)}&gt;${superBadge}</span>
      </div>

      <h1>${escapeHtml(data.project.name)} ${myRoleBadge}</h1>
      <p class="muted">
        Slug: <code>${escapeHtml(data.project.slug)}</code>
        · Created ${formatDate(data.project.createdAt)}
      </p>

      <h2 style="margin-top:32px">Members</h2>
      <div class="member-grid" id="members">${memberRows}</div>

      ${manageBlock}
    </div>

    <script>
      const PROJECT_SLUG = ${JSON.stringify(data.project.slug)};

      ${data.canManage ? `
        const inviteErr = document.getElementById('invite-error');
        document.getElementById('invite-btn').addEventListener('click', async () => {
          inviteErr.style.display = 'none';
          const email = document.getElementById('invite-email').value.trim();
          const role = document.getElementById('invite-role').value;
          if (!email) { inviteErr.textContent = 'Email is required.'; inviteErr.style.display = 'block'; return; }
          const res = await fetch('/api/projects/' + encodeURIComponent(PROJECT_SLUG) + '/members', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, role }),
          });
          if (res.ok) { location.reload(); return; }
          const data = await res.json().catch(() => ({}));
          inviteErr.textContent = data.error || ('Invite failed (' + res.status + ').');
          inviteErr.style.display = 'block';
        });

        document.addEventListener('change', async (ev) => {
          const userId = ev.target?.dataset?.userId;
          if (!userId || !ev.target.classList.contains('role-select')) return;
          const role = ev.target.value;
          const res = await fetch('/api/projects/' + encodeURIComponent(PROJECT_SLUG) + '/members/' + encodeURIComponent(userId), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ role }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.error || 'Role change failed.');
            location.reload();
          }
        });

        document.addEventListener('click', async (ev) => {
          const userId = ev.target?.dataset?.remove;
          if (!userId) return;
          if (!confirm('Remove this member from the project?')) return;
          const res = await fetch('/api/projects/' + encodeURIComponent(PROJECT_SLUG) + '/members/' + encodeURIComponent(userId), {
            method: 'DELETE',
          });
          if (res.ok) { location.reload(); return; }
          const data = await res.json().catch(() => ({}));
          alert(data.error || 'Remove failed.');
        });
      ` : ''}
    </script>
  `)
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string))
}
