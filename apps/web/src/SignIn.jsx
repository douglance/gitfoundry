import logo from './logo.svg';
import React, { useEffect, useRef, useState } from 'react';
import { Banner, Button, Input, Text } from '@cloudflare/kumo';
import './sign-in.css';

const messages = {
  invalid_email: 'Enter a complete email address, like you@company.com.',
  invalid_code: 'That code did not work. Use the newest code we sent, or send a new one.',
  email_unavailable: 'We could not send email just now. Try again in a minute.',
  network: 'GitFoundry could not be reached. Check your connection and try again.'
};

async function post(path, body) {
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, error: data.error };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export default function SignIn() {
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const codeField = useRef(null);
  const emailField = useRef(null);

  useEffect(() => { (step === 'code' ? codeField : emailField).current?.focus(); }, [step, attempt]);

  async function sendCode(event) {
    event?.preventDefault();
    const address = email.trim();
    setBusy(true); setError(''); setNotice('');
    const result = await post('/auth/email/start', { email: address });
    setBusy(false);
    if (!result.ok) { setError(messages[result.error] ?? messages.email_unavailable); return; }
    setEmail(address);
    setAttempt(value => value + 1);
    setStep('code');
    if (event === undefined) setNotice('We sent a new code to ' + address + '.');
  }

  async function verify(event) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '').replace(/\D/g, '');
    if (code.length !== 6) { setError('Enter all six digits of the code.'); return; }
    setBusy(true); setError(''); setNotice('');
    const result = await post('/auth/email/verify', { email, code });
    if (result.ok) { window.location.assign('/'); return; }
    setBusy(false);
    setError(messages[result.error] ?? messages.invalid_code);
  }

  return <main className="sign-in" aria-labelledby="sign-in-title">
    <section className="sign-in-brand" aria-hidden="true">
      <div className="sign-in-mark"><img src={logo} width={36} height={36} alt="" /><span>GitFoundry</span></div>
      <div className="sign-in-story">
        <p className="sign-in-tagline">Every change is a fork. Every fork is checked before it lands.</p>
        <ol className="sign-in-lineage">
          <li className="is-head"><span>main</span><code>authoritative</code></li>
          <li><span>fork · sign-in-copy</span><code>checks passed</code></li>
          <li><span>fork · retry-deploy</span><code>in review</code></li>
        </ol>
      </div>
    </section>
    <section className="sign-in-panel">
      <div className="sign-in-card">
        <div className="sign-in-mobile-mark" aria-hidden="true"><img src={logo} width={28} height={28} alt="" /><span>GitFoundry</span></div>
        {step === 'email' ? <form className="sign-in-form" onSubmit={sendCode} noValidate>
          <div className="sign-in-heading">
            <Text as="h1" id="sign-in-title" variant="heading">Sign in to GitFoundry</Text>
            <Text variant="secondary">We will email you a six-digit code. New to GitFoundry? The same code creates your workspace.</Text>
          </div>
          {error && <Banner variant="error" title={error} />}
          <Input ref={emailField} id="sign-in-email" label="Work email" name="email" type="email" autoComplete="email" inputMode="email" placeholder="you@company.com" value={email} onChange={event => setEmail(event.target.value)} required disabled={busy} />
          <Button type="submit" variant="primary" className="sign-in-submit" disabled={busy || !email.trim()} loading={busy}>{busy ? 'Sending code…' : 'Email me a code'}</Button>
        </form> : <form key={attempt} className="sign-in-form" onSubmit={verify} noValidate>
          <div className="sign-in-heading">
            <Text as="h1" id="sign-in-title" variant="heading">Check your email</Text>
            <Text variant="secondary">Enter the code we sent to <strong className="sign-in-address">{email}</strong>. It expires in 10 minutes.</Text>
          </div>
          {notice && <Banner variant="info" title={notice} />}
          {error && <Banner variant="error" title={error} />}
          <Input ref={codeField} id="sign-in-code" label="Six-digit code" name="code" className="sign-in-code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]*" maxLength={6} placeholder="000000" required disabled={busy} />
          <Button type="submit" variant="primary" className="sign-in-submit" disabled={busy} loading={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          <div className="sign-in-secondary">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => sendCode()}>Send a new code</Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => { setStep('email'); setError(''); setNotice(''); }}>Use a different email</Button>
          </div>
        </form>}
      </div>
    </section>
  </main>;
}
