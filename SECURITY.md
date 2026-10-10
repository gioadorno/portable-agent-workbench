# Security boundaries

This package coordinates trusted local coding tools sharing one OS account. It does not isolate hostile processes or stop direct filesystem/database modification. Use native host sandbox, permissions and dedicated test environments for actual resource protection.

Approved commands execute project code. Owners must inspect their argv, working directory, side effects and external dependencies. Common credential patterns are redacted, but only explicit inspection can establish that a selected export is safe to publish.

Report suspected toolkit vulnerabilities privately to the repository maintainer through GitHub's private security reporting when available. Avoid posting real credentials, private project records or exploit logs containing sensitive data in public issues.

Supported release line: 0.1.x. Security fixes receive regression coverage and explicit releases. No automatic upstream skill updates or silent storage fallback are performed.
