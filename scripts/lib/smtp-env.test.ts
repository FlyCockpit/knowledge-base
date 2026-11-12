import assert from "node:assert/strict";
import { test } from "node:test";
import { DEV_SINK, readSmtpHostValue, withDevSmtpSink } from "./smtp-env.ts";

test("readSmtpHostValue is null when the line is absent, commented, or empty", () => {
  assert.equal(readSmtpHostValue(""), null);
  assert.equal(readSmtpHostValue("# SMTP_HOST=localhost\n"), null);
  assert.equal(readSmtpHostValue("SMTP_HOST=\n"), null);
  assert.equal(readSmtpHostValue('OTHER=1\nSMTP_HOST=""\n'), null);
});

test("readSmtpHostValue reads an active value, trimming quotes", () => {
  assert.equal(readSmtpHostValue("SMTP_HOST=smtp.example.com\n"), "smtp.example.com");
  assert.equal(readSmtpHostValue('SMTP_HOST="smtp.example.com"\n'), "smtp.example.com");
});

test("withDevSmtpSink activates commented template lines in place", () => {
  const input = [
    "# --- Email (SMTP) ---",
    "# SMTP_HOST=localhost",
    "# SMTP_PORT=1025",
    'SMTP_FROM="noreply@example.com"',
    "",
  ].join("\n");
  const out = withDevSmtpSink(input);
  assert.match(out, /^SMTP_HOST=localhost$/m);
  assert.match(out, /^SMTP_PORT=1025$/m);
  assert.match(out, /^SMTP_FROM=noreply@dev\.local$/m);
  assert.ok(!/^# SMTP_HOST/m.test(out));
});

test("withDevSmtpSink appends the block when the lines are missing entirely", () => {
  const out = withDevSmtpSink("OTHER=1\n");
  assert.match(out, /^SMTP_HOST=localhost$/m);
  assert.match(out, /^SMTP_PORT=1025$/m);
  assert.match(out, /^SMTP_FROM=noreply@dev\.local$/m);
});

test("withDevSmtpSink is a no-op when SMTP_HOST already has a real value", () => {
  const input = "SMTP_HOST=smtp.postmark.example\nSMTP_PORT=587\n";
  assert.equal(withDevSmtpSink(input), input);
});

test("withDevSmtpSink is idempotent across repeated calls", () => {
  const once = withDevSmtpSink("# SMTP_HOST=localhost\n");
  assert.equal(withDevSmtpSink(once), once);
});

test("DEV_SINK points at the dev compose mailpit service", () => {
  assert.equal(DEV_SINK.host, "localhost");
  assert.equal(DEV_SINK.port, "1025");
});
