# Frontend

The web application, analysis status views, event timeline, evidence review,
and user feedback interfaces belong here.

The frontend uses React, TypeScript, and Vite.

```bash
npm run dev
```

The dashboard supports:

- direct presigned uploads with byte-level progress;
- one-second analysis and stage polling;
- live activity and stage transitions;
- media metadata and Tier-1 scan summaries;
- logical-window and speech-candidate display paginated at 300 records per
  page.

`VITE_API_BASE_URL` defaults to `http://localhost:3000/v1`. Copy
`.env.example` to `.env` inside this directory when using a different backend
address.
