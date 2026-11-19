window.__ModuleLoader__.load({
  id: 'dsh-plugin-jira',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Credential references shared with the host half. */
    const FIELDS = [
      { key: 'site', ref: 'JIRA_SITE', label: 'Site URL', placeholder: 'https://yourorg.atlassian.net' },
      { key: 'email', ref: 'JIRA_EMAIL', label: 'Email (optional)', placeholder: 'you@company.com' },
      { key: 'token', ref: 'JIRA_API_TOKEN', label: 'API token', placeholder: 'Atlassian API token, or an encoded Basic value', secret: true },
    ]
    const EMPTY = { site: '', email: '', token: '' }

    /** Required client services. */
    const inject = ['slots', 'remote', 'remote.credentials']

    const label = { fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' }
    const hint = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', margin: 0 }
    const input = {
      boxSizing: 'border-box', width: '100%', height: 32, padding: '0 10px', fontSize: 14,
      borderRadius: 'var(--dsw-radius-md)', border: '.5px solid var(--dsw-alias-border-l4)',
      background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    }
    const button = {
      height: 32, padding: '0 14px', fontSize: 14, cursor: 'pointer', border: 'none',
      borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-button-primary-fill)',
      color: 'var(--dsw-alias-label-primary-foreground)',
    }

    /** Settings → Jira: store the three credentials the host half resolves. */
    function apply(ctx) {
      function JiraSettings() {
        const [values, setValues] = React.useState(EMPTY)
        const [configured, setConfigured] = React.useState({})
        const [status, setStatus] = React.useState('')

        const refresh = React.useCallback(async () => {
          try {
            const response = await ctx.remote.credentials.describe(FIELDS.map((f) => f.ref))
            if (!response.ok) {
              setStatus(response.error?.message ?? 'Could not read credentials.')
              return
            }
            setConfigured(Object.fromEntries(FIELDS.map((f) => [f.key, Boolean(response.value[f.ref]?.configured)])))
          } catch (error) {
            setStatus(String(error?.message ?? error))
          }
        }, [])

        React.useEffect(() => { refresh() }, [refresh])

        async function save() {
          const pending = FIELDS.map((field) => [field, values[field.key].trim()]).filter(([, value]) => value)
          if (pending.length === 0) {
            setStatus('Nothing to save — fill a field first.')
            return
          }
          setStatus('Saving…')
          try {
            for (const [field, value] of pending) {
              const response = await ctx.remote.credentials.set(field.ref, value)
              if (!response.ok) throw new Error(response.error?.message ?? `Could not save ${field.ref}.`)
            }
            setValues(EMPTY)
            await refresh()
            setStatus('Saved.')
          } catch (error) {
            setStatus(String(error?.message ?? error))
          }
        }

        const rows = FIELDS.map((field) => h('label', { key: field.key, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('span', { style: label },
            field.label,
            configured[field.key] ? h('span', { style: { color: 'var(--dsw-alias-state-success-primary)', marginLeft: 8 } }, '● configured') : null),
          h('input', {
            style: input,
            type: field.secret ? 'password' : 'text',
            placeholder: field.placeholder,
            value: values[field.key],
            onChange: (event) => setValues({ ...values, [field.key]: event.target.value }),
          })))

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 } },
          h('p', { style: hint },
            'Credentials for the /jira-do command. Stored in the DSH credential store, not in settings. Leave a field blank to keep its current value. With the email blank, the token is sent as a Bearer PAT (Jira Data Center); with an email, it is encoded as Basic (Jira Cloud).'),
          ...rows,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
            h('button', { type: 'button', style: button, onClick: save }, 'Save'),
            h('span', { style: hint }, status)),
          h('p', { style: hint }, 'Usage: /jira-do TCKT-123 — checks out dev, pulls, branches the ticket key, then hands the ticket to the agent.'))
      }

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'jira',
        order: 25,
        label: () => 'Jira',
      }, JiraSettings)), 'jira: settings page')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
