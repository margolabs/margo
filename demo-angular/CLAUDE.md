# CLAUDE.md

Project instructions for Claude Code.

This project uses margo for live-app feedback. Unlike the Vite/Next demos, the Angular demo doesn't run margo as a native plugin — Angular CLI doesn't accept Vite plugins. Instead, margo runs as a **sidecar** server (`margo serve`) and the Angular dev server proxies `/__margo/*` to it.

`npm run dev` boots both processes via `concurrently`.

See `.margo/CLAUDE.md` for how AI should engage with the comment inbox. The `/margo` skill triages and processes the open inbox.
