// Receives mail for the production sign-in test address and keeps only GitFoundry sign-in codes,
// so the end-to-end check can complete a real email-code sign-in.
const sender = 'login@gitfoundry.dev';
// Email Sending delivers with this bounce address as the envelope sender.
const envelopeSender = 'bounces@cf-bounce.gitfoundry.dev';
const subjectPattern = /^(\d{6}) is your GitFoundry sign-in code$/;

export function signInCode(message, address) {
  const headerFrom = /<([^>]+)>/.exec(message.headers.get('from') ?? '')?.[1] ?? message.headers.get('from') ?? '';
  if (message.from?.toLowerCase() !== envelopeSender || headerFrom.trim().toLowerCase() !== sender || message.to?.toLowerCase() !== address.toLowerCase()) return null;
  return subjectPattern.exec(message.headers.get('subject') ?? '')?.[1] ?? null;
}

export default {
  async email(message, env) {
    const code = signInCode(message, env.E2E_ADDRESS);
    if (!code) {
      console.log('gitfoundry.e2e_inbox.rejected', { envelope: message.from, from: message.headers.get('from'), to: message.to });
      message.setReject?.('not a GitFoundry sign-in code for the test address');
      return;
    }
    await env.INBOX.prepare('INSERT INTO inbox (address, code, received_at) VALUES (?, ?, ?)').bind(env.E2E_ADDRESS, code, new Date().toISOString()).run();
  }
};
