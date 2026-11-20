# Contributor map

- Read README.md, docs/architecture.md and docs/security.md before changing behavior.
- This is a sanitized, standalone QQ adapter. Never import private source, history,
  customer data, credentials, operational exports or deployment snapshots.
- Run npm run check and npm run demo. Money/identity semantics require targeted
  regression tests and a short decision in docs/adr/.
- Chat has no tools. Business actions come only from deterministic parsing of
  fresh, trusted SDK events. The backend owns authorization and durable idempotency.
- Keep default access closed. No automatic retry of uncertain money or sends.
- Never make production changes as part of contributing here.
- Check all staged files with check:public and a current secret scanner before push.
