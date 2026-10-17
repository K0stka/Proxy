import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Wizard } from './wizards.jsx';
import { api } from './api.js';
import { useNavigation, useWizardField } from './navigation.js';
export default function DomainsWizard({ state, onClose, onSaved }) {
  const { step, setStep } = useNavigation();
  const [value, setValue] = useWizardField('domains', state.settings);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function save() {
    setError('');
    setBusy(true);
    try {
      await api('/settings', { method: 'PUT', body: value });
      await onSaved('Domains updated');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Wizard
      title="Domains & certificates"
      steps={['Domains', 'Review']}
      step={step}
      onStep={setStep}
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      submitLabel="Apply"
      error={error}
    >
      {step === 0 && (
        <>
          {value.domains.map((domain, index) => (
            <div className="domain-input" key={index}>
              <label>
                Domain
                <input
                  required
                  value={domain.name}
                  onChange={(e) =>
                    setValue((v) => ({
                      ...v,
                      domains: v.domains.map((item, i) =>
                        i === index ? { name: e.target.value } : item,
                      ),
                    }))
                  }
                />
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove domain ${index + 1}`}
                onClick={() =>
                  setValue((v) => ({ ...v, domains: v.domains.filter((_, i) => i !== index) }))
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={value.domains.length >= 50}
            onClick={() => setValue((v) => ({ ...v, domains: [...v.domains, { name: '' }] }))}
          >
            <Plus size={15} />
            Add domain
          </button>
          <section className="option-group">
            <h2>Certificates</h2>
            <label>
              Certificate email
              <input
                type="email"
                required={value.domains.length > 0}
                value={value.certificates.email}
                onChange={(e) =>
                  setValue((v) => ({
                    ...v,
                    certificates: { ...v.certificates, email: e.target.value },
                  }))
                }
              />
            </label>
          </section>
          <details className="route-options" open={value.certificates.staging || undefined}>
            <summary>Certificate diagnostics</summary>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={value.certificates.staging}
                onChange={(e) =>
                  setValue((v) => ({
                    ...v,
                    certificates: { ...v.certificates, staging: e.target.checked },
                  }))
                }
              />
              Test certificates (staging)
            </label>
            {value.certificates.staging && (
              <p className="hint">Test certificates cannot publish HTTPS routes.</p>
            )}
            <label>
              DNS propagation (seconds)
              <input
                type="number"
                required
                min={10}
                max={600}
                value={value.certificates.propagationSeconds}
                onChange={(e) =>
                  setValue((v) => ({
                    ...v,
                    certificates: { ...v.certificates, propagationSeconds: Number(e.target.value) },
                  }))
                }
              />
            </label>
          </details>
        </>
      )}
      {step === 1 && (
        <>
          <dl className="review-list">
            <div>
              <dt>Domains</dt>
              <dd>{value.domains.map((domain) => domain.name).join(', ') || 'None'}</dd>
            </div>
            <div>
              <dt>Certificates</dt>
              <dd>{value.certificates.staging ? 'Staging' : 'Production'}</dd>
            </div>
            <div>
              <dt>Certificate email</dt>
              <dd>{value.certificates.email || 'None'}</dd>
            </div>
          </dl>
        </>
      )}
    </Wizard>
  );
}
