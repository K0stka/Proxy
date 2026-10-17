import { TextInput, Switch } from '@mantine/core';
import React, { useState } from 'react';
import { Wizard } from './wizards.jsx';
import { api } from './api.js';
import { useNavigation, useWizardField } from './navigation.js';
export default function DomainWizard({ initial, emailConfigured, onClose, onSaved }) {
  const { step, setStep } = useNavigation();
  const [value, setValue] = useWizardField(
    'domain',
    initial ?? {
      name: '',
      subdomains: true,
    },
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api(initial ? '/domains/' + encodeURIComponent(initial.name) : '/domains', {
        method: initial ? 'PUT' : 'POST',
        body: value,
      });
      await onSaved('Domain saved');
    } catch (e) {
      if ([400, 409].includes(e.status)) setStep(0);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Wizard
      title={initial ? 'Edit domain' : 'Add domain'}
      steps={['Domain', 'Review']}
      step={step}
      onStep={setStep}
      onClose={onClose}
      onSubmit={save}
      onValidate={() =>
        api('/validate', {
          method: 'POST',
          body: {
            kind: 'domain',
            value,
            previous: initial?.name,
          },
        })
      }
      submitLabel={initial ? 'Save changes' : 'Add domain'}
      error={error}
      busy={busy}
    >
      {step === 0 ? (
        <>
          {!emailConfigured && (
            <p className="hint">
              Set the shared email in <a href="/settings/certificates">Settings → Certificates</a>{' '}
              before saving a domain.
            </p>
          )}
          <TextInput
            required
            autoComplete="off"
            placeholder="example.com"
            value={value.name}
            onChange={(e) =>
              setValue((v) => ({
                ...v,
                name: e.target.value,
              }))
            }
            label={'Domain'}
          />
          <Switch
            checked={value.subdomains}
            onChange={(e) =>
              setValue((v) => ({
                ...v,
                subdomains: e.target.checked,
              }))
            }
            label={'Allow third-level subdomains'}
            className="checkbox"
          />
          <p className="hint">
            {value.name || 'example.com'}
            {value.subdomains ? ', *.' + (value.name || 'example.com') : ''}
          </p>
        </>
      ) : (
        <dl className="review-list">
          <div>
            <dt>Domain</dt>
            <dd>{value.name}</dd>
          </div>
          <div>
            <dt>Certificate names</dt>
            <dd>
              {value.name}
              {value.subdomains ? ', *.' + value.name : ''}
            </dd>
          </div>
        </dl>
      )}
    </Wizard>
  );
}
