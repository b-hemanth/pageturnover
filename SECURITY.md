# Security

PageTurnover is a local application. It has no hosted account system and sends
no telemetry. Papers remain in `workspaces/` on the machine running the server.

Production serving defaults to `127.0.0.1` and creates a random 48-hex access
token at `.runtime/access-token` with owner-only permissions. Do not commit or
share `.runtime/`. When using Remote SSH, prefer editor port forwarding over a
public listener. If you bind to `0.0.0.0`, you are responsible for the host
firewall, tunnel, and network exposure.

The optional AI Writing Desk sends only the selected/file context requested by
the user to the configured provider. No proposed edit is applied until the user
chooses **Apply**.

Report vulnerabilities through the repository's private GitHub security
advisory flow rather than a public issue containing an exploit or document.
