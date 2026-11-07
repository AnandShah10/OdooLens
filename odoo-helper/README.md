# OdooLens Runtime Helper (Odoo module)

The server-side half of OdooLens's optional **runtime registry** feature. The VS Code
extension's `Odoo: Connect to Runtime` / `Odoo: Inspect Runtime Registry` commands call the four
read-only endpoints this module exposes, to compare "what static analysis sees in source" with
"what this live server's registry actually has".

> **Install on development/staging databases only.** It exposes model/field/view metadata
> (never record data) to anyone holding the token. It is read-only and disabled until you set a
> token, but there's no reason to run it in production.

## Install

1. Copy the `odoolens_helper/` folder into one of your Odoo addons paths.
2. Update the apps list and install **OdooLens Runtime Helper** (technical name `odoolens_helper`).
3. **Set the token** — until you do, every request is refused with `401`:
   *Settings → Technical → System Parameters → New*: key `odoolens.api_token`, value a long
   random string (e.g. `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`).
4. In VS Code: enable `odooIntelligence.enableRuntimeRegistry`, run **Odoo: Connect to
   Runtime**, and enter the server URL, database name, and that token. The token is stored in
   VS Code's SecretStorage, never in settings or logs.

## Endpoints

All `POST`, JSON body must include `"database"`, header `Authorization: Bearer <token>`:

| Path | Extra body | Returns |
|---|---|---|
| `/odoolens/models` | — | sorted list of every model name in the registry |
| `/odoolens/model` | `model` | `{name, fields, methods, inheritedModules}` or `null` |
| `/odoolens/field` | `model`, `field` | `{name, type, comodel?, store, present}` or `null` |
| `/odoolens/views` | `model` | `[{id, name, type}]` |

`methods` lists public (non-underscore) callables found on the model *class* — introspection
never instantiates computed fields or evaluates properties, so it has no side effects.

## Security model

- Disabled by default: no token configured → `401` for everything.
- Token compared with `hmac.compare_digest` (constant time).
- Error responses never include exception details (they're logged server-side only).
- Strictly read-only; only registry/`ir.model`/`ir.ui.view` metadata is read.
- You are still putting an unauthenticated-route (`auth='none'`) module on your server: use a
  strong token, serve over HTTPS if it's reachable beyond localhost, and uninstall it when
  you're done.

## Tests

The logic lives in `introspection.py`, free of any `odoo` import so it can be tested with plain
Python fakes:

```bash
python3 -m unittest discover -s odoo-helper/tests -v
```

## Compatibility

Written against APIs common to Odoo 14–19 (`odoo.registry(db)`, `api.Environment`,
`ir.model.modules`, `ir.ui.view.type`). The controller itself — the thin shell that needs a real
Odoo — has **not** been run against a live server in this project's build environment (there's no
Odoo install there); the introspection logic and the VS Code client are tested (see above and
`tests/runtime/`), but treat a first run on a real instance as the final verification step.
