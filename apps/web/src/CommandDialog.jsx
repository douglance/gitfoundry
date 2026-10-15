import React, { useEffect, useRef, useState } from 'react';
import { Banner, Button, Dialog, Input, Select, Text, Textarea } from '@cloudflare/kumo';
import { Form } from '@cloudflare/kumo/primitives/form';

import { errorLabel, invokeCommand } from './api.js';
import { getCommand } from './commands.js';

const fieldLabel = name => name.replace(/^input\./, '').replaceAll('_', ' ').replace(/^./, char => char.toUpperCase());

function commandFieldsFor(command) {
  const schema = command.inputSchema || { properties: {} };
  const fields = [];
  for (const [key, definition = {}] of Object.entries(schema.properties || {})) {
    if (key === 'expected_version' && schema.properties?.input?.properties?.expected_version) continue;
    if (key === 'input' && definition.properties) {
      for (const [name, inputDefinition = {}] of Object.entries(definition.properties)) {
        fields.push({ name: 'input.' + name, schema: inputDefinition, required: (definition.required || []).includes(name) });
      }
    } else {
      fields.push({ name: key, schema: definition, required: (schema.required || []).includes(key) });
    }
  }
  return fields;
}

function coerceFieldValue(schema = {}, value) {
  if (value === '' && !schema.default) return undefined;
  if (schema.type === 'integer') return Number.parseInt(value, 10);
  if (schema.type === 'number') return Number(value);
  if (schema.type === 'boolean') return value === true || value === 'true';
  if (schema.type === 'object' || schema.type === 'array' || schema.anyOf || schema.$ref) return typeof value === 'string' ? JSON.parse(value || (schema.type === 'array' ? '[]' : '{}')) : value;
  return value;
}

function assignField(target, name, value) {
  if (value === undefined) return;
  const parts = name.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {};
  cursor[parts.at(-1)] = value;
}

function parseFields(command, values) {
  const parsed = {};
  for (const field of commandFieldsFor(command)) assignField(parsed, field.name, coerceFieldValue(field.schema, values[field.name]));
  return parsed;
}

function CommandField({ field, defaults }) {
  const { name, schema, required } = field;
  const value = defaults[name] ?? schema.default ?? '';
  const props = { id: 'command-' + name, name, label: fieldLabel(name), required, defaultValue: String(value), disabled: name === 'tenant_id' };
  if (schema.enum || schema.type === 'boolean') {
    const choices = schema.enum || [true, false];
    return <Select {...props} items={[...(!required ? [{ value: '', label: 'Not set' }] : []), ...choices.map(value => ({ value: String(value), label: String(value) }))]} placeholder="Choose a value" />;
  }
  if (schema.type === 'object' || schema.type === 'array' || schema.anyOf || schema.$ref) {
    return <Textarea {...props} defaultValue={typeof value === 'string' ? value : JSON.stringify(value)} rows={3} placeholder={schema.type === 'array' ? '[]' : '{}'} />;
  }
  return <Input {...props} type={schema.type === 'integer' || schema.type === 'number' ? 'number' : 'text'} step={schema.type === 'integer' ? 1 : 'any'} min={schema.minimum} max={schema.maximum} minLength={schema.minLength} maxLength={schema.maxLength} pattern={schema.pattern} />;
}

export default function CommandDialog({ commandId, defaults, onClose, onExecuted }) {
  const command = getCommand(commandId);
  const [initialValues] = useState(() => ({ ...defaults, ...(command.inputSchema.required?.includes('idempotency_key') ? { idempotency_key: crypto.randomUUID() } : {}) }));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const inFlight = useRef(false);
  const controller = useRef(new AbortController());
  useEffect(() => () => controller.current.abort(), []);

  async function submit(event) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setResult(null);
    try {
      const args = parseFields(command, { ...Object.fromEntries(new FormData(event.currentTarget)), tenant_id: initialValues.tenant_id });
      const response = await invokeCommand(commandId, args, controller.current.signal);
      if (controller.current.signal.aborted) return;
      setResult(response);
      if (response.ok) onExecuted?.({ commandId, args, response });
    } catch (error) {
      if (!controller.current.signal.aborted) setResult({ ok: false, error: { status: 0, data: { error: 'Invalid input', detail: error.message } } });
    } finally {
      inFlight.current = false;
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog className="workspace-chrome-dialog max-h-[85dvh] overflow-y-auto" >
      <div data-command-dialog={commandId}>
      <Dialog.Title>{command.label}</Dialog.Title>
      <Dialog.Description>Complete the fields, then run the command.</Dialog.Description>
      <Text variant="secondary" size="sm">{command.cli}</Text>
      <Form id="command-form" className="space-y-4" onSubmit={submit}>
        {commandFieldsFor(command).map(field => <CommandField key={field.name} field={field} defaults={initialValues} />)}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy || !initialValues.tenant_id}>{busy ? 'Running…' : 'Run command'}</Button>
          <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </Form>
      {!initialValues.tenant_id && <Banner variant="info">Choose a workspace before running commands.</Banner>}
      {result && <div className="mt-4" role="status" data-command-result>
        {result.ok ? <><Text>Request finished</Text><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(result.data, null, 2)}</pre></> : <Banner variant="error">{errorLabel(result.error)}</Banner>}
      </div>}
      </div>
    </Dialog>
  </Dialog.Root>;
}
