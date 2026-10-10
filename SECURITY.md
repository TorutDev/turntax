# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

Include the version (`turntax --version`), steps to reproduce, and the impact you see. You can expect a first reply within a week.

## Scope

turntax reads files and, only when you opt in, sends them to a vendor API. Reports about these areas are especially welcome:

- file contents or API keys sent anywhere without `--claude-api`, `--gemini-api` or `--translate`
- API keys appearing in output, logs, error messages or URLs
- reading files outside the target directory
- the web page making any network request with your files

## Supported versions

Only the latest published version receives fixes.
