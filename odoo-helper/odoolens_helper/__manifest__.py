{
    'name': 'OdooLens Runtime Helper',
    'summary': 'Read-only introspection endpoints for the OdooLens VS Code extension.',
    'description': """
Exposes a small set of read-only JSON endpoints (/odoolens/models, /odoolens/model,
/odoolens/field, /odoolens/views) that let the OdooLens VS Code extension compare its static
source analysis against this server's live registry.

Disabled by default: every endpoint refuses requests until the system parameter
`odoolens.api_token` is set. Install only on development/staging databases.
""",
    'version': '1.0.0',
    'category': 'Tools',
    'author': 'Anand Shah',
    'license': 'MIT',
    'depends': ['base'],
    'data': [],
    'installable': True,
    'application': False,
}
