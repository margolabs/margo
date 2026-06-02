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
    --panel: #ffffff;
    --fg: #0a0a0a;
    --fg-strong: #000000;
    --muted: #71717a;
    --muted-strong: #52525b;
    --border: #e4e4e7;
    --border-strong: #d4d4d8;
    --hover: #f4f4f5;
    --accent: #2563eb;
    --accent-hover: #1d4ed8;
    --accent-fg: #ffffff;
    --accent-soft: rgba(37, 99, 235, 0.08);
    --accent-soft-strong: rgba(37, 99, 235, 0.12);
    --danger: #dc2626;
    --danger-soft: rgba(220, 38, 38, 0.08);
    --ok: #16a34a;
    --ok-soft: rgba(22, 163, 74, 0.08);
    --warn: #d97706;
    --warn-soft: rgba(217, 119, 6, 0.08);
    --code-bg: #f4f4f5;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
    --shadow-focus: 0 0 0 3px rgba(37, 99, 235, 0.18);
    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-lg: 12px;
    --radius-pill: 9999px;
    --control-h: 38px;
    --control-h-sm: 30px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    background: var(--bg); color: var(--fg);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { color: var(--accent-hover); }
  ::selection { background: var(--accent-soft-strong); color: var(--fg-strong); }

  .container { max-width: 760px; margin: 0 auto; padding: 56px 24px 80px; }
  .container.narrow { max-width: 400px; padding-top: 80px; }

  .brand {
    font-size: 16px; font-weight: 600; letter-spacing: -0.015em;
    color: var(--fg-strong); margin: 0 0 36px;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .brand .dot {
    display: inline-block; width: 9px; height: 9px; border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }

  .panel {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius-lg); padding: 32px;
    box-shadow: var(--shadow-sm);
  }

  /* Typography */
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; color: var(--fg-strong); }
  h2 {
    margin: 40px 0 6px; font-size: 13px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-strong);
  }
  h1 + p.muted, h2 + p.muted { margin-top: 0; }
  p.muted { color: var(--muted); margin: 0 0 20px; font-size: 13px; line-height: 1.55; }
  .alt { font-size: 13px; color: var(--muted); }
  code, .code {
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;
    font-size: 12px; color: var(--fg-strong);
  }
  p code, span code { background: var(--code-bg); padding: 1.5px 5px; border-radius: 4px; font-size: 12px; }

  /* Form controls — uniform height, no weird wrapping */
  label { display: block; margin: 14px 0 6px; font-size: 13px; font-weight: 500; color: var(--fg-strong); }
  input[type="email"],
  input[type="text"],
  input[type="password"],
  select {
    width: 100%; height: var(--control-h);
    padding: 0 12px; border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm); font-size: 14px;
    background: var(--panel); color: var(--fg);
    font-family: inherit; line-height: 1; box-shadow: var(--shadow-sm);
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  input::placeholder { color: var(--muted); }
  input:hover:not(:focus), select:hover:not(:focus) { border-color: var(--muted); }
  input:focus, select:focus {
    outline: none; border-color: var(--accent); box-shadow: var(--shadow-focus);
  }
  select {
    appearance: none; padding-right: 32px;
    background-image: url("data:image/svg+xml;charset=UTF-8,%3Csvg viewBox='0 0 12 12' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2371717a' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center; background-size: 12px;
  }

  /* Buttons — uniform height, single line, proper padding */
  button {
    height: var(--control-h);
    padding: 0 16px; border: 1px solid transparent; border-radius: var(--radius-sm);
    font-size: 14px; font-weight: 500; cursor: pointer; font-family: inherit;
    line-height: 1; white-space: nowrap;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    transition: background-color .12s ease, border-color .12s ease, color .12s ease, transform .04s ease;
  }
  button:active { transform: translateY(0.5px); }
  button.primary {
    background: var(--accent); color: var(--accent-fg);
    box-shadow: var(--shadow-sm);
  }
  button.primary:hover { background: var(--accent-hover); }
  button.primary:focus-visible { box-shadow: var(--shadow-focus); outline: none; }
  button.secondary {
    background: var(--panel); color: var(--fg-strong); border-color: var(--border-strong);
    box-shadow: var(--shadow-sm);
  }
  button.secondary:hover { background: var(--hover); border-color: var(--muted); }
  button.subtle {
    background: transparent; color: var(--muted-strong);
    height: var(--control-h-sm); padding: 0 10px; font-size: 13px; border: 0;
  }
  button.subtle:hover { color: var(--fg-strong); background: var(--hover); }
  button.danger {
    background: transparent; color: var(--danger);
    height: var(--control-h-sm); padding: 0 10px; font-size: 13px; font-weight: 500;
    border: 0;
  }
  button.danger:hover { background: var(--danger-soft); }
  button[disabled] { opacity: .45; cursor: not-allowed; }

  /* Layout helpers */
  .actions { display: flex; gap: 10px; margin-top: 24px; align-items: center; }
  .actions .grow { flex: 1; }
  .form-row {
    display: grid; gap: 10px; align-items: center; margin-top: 8px;
  }
  .form-row.two   { grid-template-columns: 1fr 1fr auto; }
  .form-row.input-plus-btn { grid-template-columns: 1fr auto; }

  /* Feedback banners */
  .error {
    margin-top: 16px; padding: 10px 12px; border-radius: var(--radius-sm);
    background: var(--danger-soft); color: var(--danger);
    font-size: 13px; line-height: 1.45;
    border: 1px solid rgba(220, 38, 38, 0.18);
  }
  .ok-banner {
    margin: 0 0 16px; padding: 11px 14px; border-radius: var(--radius-sm);
    background: var(--ok-soft); color: var(--ok); font-size: 13px;
    border: 1px solid rgba(22, 163, 74, 0.2);
  }

  /* Nav */
  .nav {
    display: flex; align-items: center; gap: 16px;
    padding: 0 0 20px; margin: 0 0 8px;
    border-bottom: 1px solid var(--border);
  }
  .nav .brand { margin: 0; }
  .nav .grow { flex: 1; }
  .nav .who {
    font-size: 13px; color: var(--muted);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .nav .who strong { color: var(--fg-strong); font-weight: 500; }

  /* Badges */
  .badge {
    display: inline-flex; align-items: center;
    padding: 1px 8px; border-radius: var(--radius-pill);
    font-size: 11px; font-weight: 500; letter-spacing: 0.01em; line-height: 1.6;
    vertical-align: middle;
    background: var(--accent-soft); color: var(--accent);
    margin-left: 8px;
  }

  /* Lists / grids — projects, tokens, members */
  .project-grid, .token-grid, .member-grid {
    display: flex; flex-direction: column;
    border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--panel); overflow: hidden;
    box-shadow: var(--shadow-sm);
    margin-top: 12px;
  }
  .project-row, .token-row, .member-row {
    display: grid; align-items: center;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px; transition: background-color .12s ease;
  }
  .project-row:last-child, .token-row:last-child, .member-row:last-child { border-bottom: 0; }
  .project-row { grid-template-columns: minmax(0, 220px) 1fr auto; gap: 14px; }
  .token-row   { grid-template-columns: minmax(0, 1fr) auto; gap: 16px; }
  .member-row  { grid-template-columns: minmax(0, 1fr) 130px 80px; gap: 12px; }

  a.project-row { color: inherit; }
  a.project-row:hover { background: var(--hover); }

  .project-row .slug {
    font-weight: 500; color: var(--fg-strong);
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;
    font-size: 13px;
  }
  .project-row .muted, .project-row > span.muted { color: var(--muted); font-size: 13px; }
  .project-row .role,
  h1 .role {
    padding: 2px 10px; border-radius: var(--radius-pill);
    background: var(--code-bg); color: var(--muted-strong);
    font-size: 11px; font-weight: 500; line-height: 1.7;
    text-transform: capitalize;
    margin-left: auto; vertical-align: middle;
  }
  h1 .role { margin-left: 10px; }

  .token-label { font-weight: 500; color: var(--fg-strong); }
  .token-meta {
    color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px;
    margin-top: 2px;
  }

  /* Empty state */
  .empty {
    padding: 36px 20px; text-align: center;
    color: var(--muted); font-size: 13px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-md);
    background: transparent; margin-top: 12px;
  }
  .empty strong { color: var(--fg-strong); font-weight: 500; }

  /* Secret token display */
  pre.token-display {
    margin: 12px 0 0; padding: 14px; background: var(--code-bg);
    border-radius: var(--radius-sm); overflow-x: auto;
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;
    font-size: 12px; line-height: 1.5;
    word-break: break-all; white-space: pre-wrap;
    color: var(--fg-strong);
    border: 1px solid var(--border);
  }

  /* Member-row specifics */
  .member-name { font-weight: 500; font-size: 13px; color: var(--fg-strong); }
  .member-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .member-meta .muted { font-size: 12px; color: var(--muted); }

  select.role-select {
    height: var(--control-h-sm); padding: 0 28px 0 10px;
    font-size: 12px; box-shadow: none;
    background-size: 10px; background-position: right 8px center;
  }
  select#invite-role {
    /* Inherits standard select sizing; just ensure it sits at the same
       height as the input + button in the form row. */
    width: auto; min-width: 110px;
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

export function renderSetup(): string {
  // Distinct first-run UX: framed as "claim the host" rather than "create
  // an account." The form fields are similar to signup but the copy, layout,
  // and call-to-action are different so an operator doesn't mistake this
  // for an everyday signup form.
  return shell('Set up', `
    <div class="setup-bg">
      <div class="container narrow" style="padding-top:64px">
        <div class="setup-card">
          <div class="setup-eyebrow">First-run setup</div>
          <h1 class="setup-title">Claim this host</h1>
          <p class="muted">
            This margo host has no accounts yet. The first user to set up
            becomes the <strong>superuser</strong> — they manage projects,
            members, and the host itself. Anyone you share the URL with
            after this will sign up as a regular user.
          </p>
          <form id="form" autocomplete="on" style="margin-top:18px">
            <label for="name">Your name</label>
            <input id="name" name="name" type="text" autocomplete="name" required autofocus />
            <label for="email">Your email</label>
            <input id="email" name="email" type="email" autocomplete="email" required />
            <label for="password">Pick a password</label>
            <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8" />
            <p class="muted" style="margin-top:6px; font-size:12px">At least 8 characters. You can change it later from your dashboard.</p>
            <div class="actions">
              <button type="submit" class="primary">Become superuser</button>
            </div>
          </form>
          <div id="error" class="error" style="display:none; margin-top:14px"></div>
        </div>
        <p class="setup-footnote">
          Once this account exists, the welcome page is gone and the regular
          login/signup pages take over.
        </p>
      </div>
    </div>
    <style>
      .setup-bg {
        min-height: 100vh;
        background:
          radial-gradient(ellipse at top, hsl(220 70% 50% / .08) 0%, transparent 50%),
          radial-gradient(ellipse at bottom, hsl(280 70% 50% / .06) 0%, transparent 50%),
          var(--bg);
      }
      .setup-card {
        background: var(--panel); border: 1px solid var(--border);
        border-radius: 12px; padding: 32px;
        box-shadow: 0 12px 40px hsl(220 30% 30% / .06);
      }
      .setup-eyebrow {
        font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--accent); font-weight: 600; margin-bottom: 8px;
      }
      .setup-title {
        margin: 0 0 12px; font-size: 24px; font-weight: 600; letter-spacing: -0.02em;
      }
      .setup-footnote {
        margin-top: 20px; text-align: center; color: var(--muted); font-size: 12px;
      }
    </style>
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
        const res = await fetch('/api/auth/setup-admin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) { location.href = '/dashboard'; return; }
        const data = await res.json().catch(() => ({}));
        errorBox.textContent = data.error || ('Setup failed (' + res.status + ').');
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
        <span class="who"><strong>${escapeHtml(data.user.name)}</strong> &lt;${escapeHtml(data.user.email)}&gt;${superBadge}</span>
        <button type="button" class="subtle" id="logout">Log out</button>
      </div>

      <h2>Projects</h2>
      <h1>Your projects</h1>
      <p class="muted">Create a new project — you'll be its admin — or open one you've already been invited to.</p>
      <div class="form-row two">
        <input id="new-project-slug" type="text" placeholder="Slug (e.g. acme-pricing)" autocomplete="off" />
        <input id="new-project-name" type="text" placeholder="Display name" autocomplete="off" />
        <button type="button" class="primary" id="new-project">Create project</button>
      </div>
      <div id="new-project-error" class="error" style="display:none"></div>
      ${projectRows}

      <h2 style="margin-top:48px">Tokens</h2>
      <h1>Your tokens</h1>
      <p class="muted">Use a token as <code>MARGO_TOKEN</code> in your shell. Issued tokens are hashed at rest — once you close the panel below, the host can no longer reveal them.</p>

      <div class="form-row input-plus-btn">
        <input id="new-token-label" type="text" placeholder="Label (e.g. laptop-dev)" autocomplete="off" />
        <button type="button" class="primary" id="new-token">Mint new token</button>
      </div>

      <div id="new-token-panel" style="display:none; margin: 16px 0 0;">
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
    <h2 style="margin-top:48px">Invite</h2>
    <h1>Add a member</h1>
    <p class="muted">They must already have an account on this host — share <code>/signup</code> with them first.</p>
    <div class="form-row two">
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
        <span class="who"><strong>${escapeHtml(data.user.name)}</strong> &lt;${escapeHtml(data.user.email)}&gt;${superBadge}</span>
      </div>

      <h2>Project</h2>
      <h1>${escapeHtml(data.project.name)} ${myRoleBadge}</h1>
      <p class="muted">
        <code>${escapeHtml(data.project.slug)}</code> · created ${formatDate(data.project.createdAt)}
      </p>

      <h2 style="margin-top:40px">Members</h2>
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

export interface CliLoginPageData {
  user: { email: string; name: string }
  /** Present when the userCode lookup succeeded and the session is in a
   *  confirmable state ('pending', not yet consumed). */
  session?: { userCode: string; label: string; expiresAt: string }
  /** Present when the lookup failed — unknown code, expired, denied,
   *  already consumed, etc. We render an explanatory card instead of
   *  the authorize/cancel form. */
  errorMessage?: string
}

export function renderCliLogin(data: CliLoginPageData): string {
  if (!data.session) {
    return shell('Device authorization', `
      <div class="container narrow">
        <div class="brand"><span class="dot"></span> margo host</div>
        <div class="panel cli-panel">
          <div class="cli-glyph cli-glyph-error">${svgInfo()}</div>
          <h1>Can't confirm this device</h1>
          <p class="muted">${escapeHtml(data.errorMessage ?? 'This sign-in code is no longer valid.')}</p>
          <div class="actions actions-centered">
            <a href="/dashboard" class="alt">← Back to dashboard</a>
          </div>
        </div>
      </div>
      ${cliLoginStyles()}
    `)
  }
  const session = data.session
  return shell('Device authorization', `
    <div class="container narrow">
      <div class="brand"><span class="dot"></span> margo host</div>
      <div class="panel cli-panel">

        <!-- Pending: the default state. Replaced wholesale (not greyed
             out + appended-callout) on Authorize / Cancel so the page
             always has exactly one focal point. -->
        <div class="cli-state" id="state-pending">
          <div class="cli-eyebrow">Device authorization</div>
          <h1>Authorize this device?</h1>
          <p class="muted">
            Sign in request from <strong>${escapeHtml(session.label)}</strong>
            on behalf of <code>${escapeHtml(data.user.email)}</code>.
            Approving issues a new bearer token tied to your account —
            the device sees it once and you can revoke it any time from
            the dashboard.
          </p>
          <div class="cli-code-box">
            <div class="cli-code-label">Verification code</div>
            <div class="cli-code-value">${escapeHtml(session.userCode)}</div>
            <div class="cli-code-meta">Confirm this matches the code shown by the requesting device.</div>
          </div>
          <div class="actions">
            <button type="button" class="primary" id="authorize">Authorize device</button>
            <button type="button" class="subtle" id="cancel">Cancel</button>
          </div>
          <div id="error" class="error" hidden></div>
        </div>

        <!-- Success: the form is gone; only the confirmation remains.
             Keeps the verification code visible so the user has a record
             of what they approved. -->
        <div class="cli-state cli-state-centered" id="state-success" hidden>
          <div class="cli-glyph cli-glyph-ok">${svgCheck()}</div>
          <h1>You're signed in</h1>
          <p class="cli-line">
            Signed in as <strong id="success-name">${escapeHtml(data.user.name || data.user.email)}</strong>
            · <code>${escapeHtml(data.user.email)}</code>
          </p>
          <p class="muted cli-line">
            Verified code <code class="cli-inline-code">${escapeHtml(session.userCode)}</code>.
            You can close this tab — the requesting device will pick up the new credential automatically.
          </p>
          <div class="actions actions-centered">
            <a href="/dashboard" class="alt">Open dashboard</a>
          </div>
        </div>

        <!-- Cancelled: same shape as success but neutral, with a retry
             affordance so a misclick isn't a dead-end. -->
        <div class="cli-state cli-state-centered" id="state-cancelled" hidden>
          <div class="cli-glyph cli-glyph-neutral">${svgX()}</div>
          <h1>Cancelled</h1>
          <p class="muted cli-line">
            No token was issued. The requesting device's sign-in will
            time out on its own — you can close this tab, or
            <a href="javascript:location.reload()">try again</a>.
          </p>
        </div>

      </div>
    </div>
    ${cliLoginStyles()}
    <script>
      const USER_CODE = ${JSON.stringify(session.userCode)};
      const states = {
        pending: document.getElementById('state-pending'),
        success: document.getElementById('state-success'),
        cancelled: document.getElementById('state-cancelled'),
      };
      const authorizeBtn = document.getElementById('authorize');
      const cancelBtn = document.getElementById('cancel');
      const errorBox = document.getElementById('error');

      function show(which) {
        for (const [name, el] of Object.entries(states)) {
          el.hidden = name !== which;
        }
      }

      authorizeBtn.addEventListener('click', async () => {
        errorBox.hidden = true;
        authorizeBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
          const res = await fetch('/api/auth/cli-login/authorize', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userCode: USER_CODE }),
          });
          if (res.ok) {
            show('success');
            return;
          }
          const data = await res.json().catch(() => ({}));
          errorBox.textContent = data.error || ('Authorize failed (' + res.status + ').');
          errorBox.hidden = false;
          authorizeBtn.disabled = false;
          cancelBtn.disabled = false;
        } catch (err) {
          errorBox.textContent = 'Could not reach the host. Check your network and try again.';
          errorBox.hidden = false;
          authorizeBtn.disabled = false;
          cancelBtn.disabled = false;
        }
      });

      cancelBtn.addEventListener('click', () => {
        show('cancelled');
      });
    </script>
  `)
}

function cliLoginStyles(): string {
  return `
    <style>
      .cli-panel { padding-top: 32px; }
      .cli-state[hidden] { display: none; }
      .cli-state-centered { text-align: center; }
      .cli-state-centered h1 { margin-top: 4px; }
      .cli-eyebrow {
        font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--accent); font-weight: 600; margin-bottom: 8px;
      }
      .cli-code-box {
        margin: 20px 0 0; padding: 18px 20px;
        border: 1px solid var(--border); border-radius: var(--radius-md);
        background: var(--code-bg); text-align: center;
      }
      .cli-code-label {
        font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--muted); font-weight: 600; margin-bottom: 8px;
      }
      .cli-code-value {
        font-family: ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;
        font-size: 28px; font-weight: 600; letter-spacing: 0.1em;
        color: var(--fg-strong);
      }
      .cli-code-meta {
        margin-top: 10px; font-size: 12px; color: var(--muted);
      }
      /* Status glyph — single round badge holding an icon. Same shape
         across success / cancelled / error so the page reads as
         consistent state transitions, not three different layouts. */
      .cli-glyph {
        margin: 0 auto 18px;
        width: 56px; height: 56px;
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
      }
      .cli-glyph svg { width: 28px; height: 28px; }
      .cli-glyph-ok {
        background: hsl(142 72% 94%);
        color: hsl(142 72% 32%);
      }
      .cli-glyph-neutral {
        background: hsl(220 14% 94%);
        color: hsl(220 9% 42%);
      }
      .cli-glyph-error {
        background: hsl(0 80% 95%);
        color: hsl(0 70% 42%);
      }
      .cli-line { margin: 6px 0; }
      .cli-line code {
        font-family: ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;
      }
      .cli-inline-code {
        font-family: ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;
        background: var(--code-bg);
        padding: 1px 6px; border-radius: 4px;
        font-size: 0.92em;
      }
      .actions-centered { justify-content: center; }
    </style>
  `
}

function svgCheck(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`
}

function svgX(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`
}

function svgInfo(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`
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
