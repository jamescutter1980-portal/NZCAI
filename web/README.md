# NZC AI · Scope 3 front end

Vite and React, TypeScript, no router or state library. Views are in
`src/views/`, the typed API client in `src/api.ts`, house-style CSS in
`src/index.css`.

```bash
npm install
npm run dev      # proxies /api to the Python adapter on 127.0.0.1:8765
npm run build    # writes dist/, which `python3 -m api.server --static` serves
npm run lint
node smoke.mjs 8790   # Playwright, against a seeded static-serving adapter
```
