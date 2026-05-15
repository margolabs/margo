# website

Landing site for [margo](https://github.com/margolabs/margo), deployed to **margo-dev.com** via Vercel.

## Dev

```sh
npm install        # at repo root (workspaces install Astro)
cd website
npm run dev        # http://localhost:4321
```

## Build

```sh
npm run build      # → website/dist/
```

## Deploy

Connected to Vercel. Project settings:

- **Root Directory**: `website`
- **Framework Preset**: Astro (auto-detected)
- **Build Command**: `npm run build` (default)
- **Output Directory**: `dist` (default)
- **Domains**: margo-dev.com

In Git → Ignored Build Step (saves build minutes when only product code changed):

```sh
git diff --quiet HEAD^ HEAD -- website/ || exit 1
```

That command exits 1 (i.e. "do build") when `website/` has diffs in the last commit, else exits 0 (skip).

## Structure

```
website/
├── astro.config.mjs
├── src/
│   ├── layouts/Layout.astro   # shared head/body shell, OG tags
│   └── pages/index.astro      # the landing page
├── public/                    # favicon, demo.gif (when ready), og.png
└── package.json
```

Adding docs later: drop `@astrojs/starlight` in and create `src/content/docs/`. Or use Astro content collections directly. The current setup is intentionally one-page; expand only when the docs surface justifies it.
