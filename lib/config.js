/** Credential resolution shared by every command and tool. */

const REF = { site: 'JIRA_SITE', email: 'JIRA_EMAIL', token: 'JIRA_API_TOKEN' }
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Resolve the credentials. `JIRA_EMAIL` + `JIRA_API_TOKEN` are encoded into Basic auth (Jira Cloud);
 * with the email left blank the token is sent as `Bearer` (Jira Data Center PAT) unless it is already
 * a `Basic …` value.
 */
export async function readConfig(ctx) {
  const read = async (ref) => (await ctx.credentials.resolve(ref))?.value
  const [site, email, token] = await Promise.all([read(REF.site), read(REF.email), read(REF.token)])
  if (!site || !token) {
    throw new Error('Jira is not configured — open Settings → Jira and set site URL and API token.')
  }
  let url
  try {
    url = new URL(site)
  } catch {
    throw new Error(`Jira: "${site}" is not a valid site URL.`)
  }
  if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('Jira: the site URL must use https (the API token would otherwise travel in cleartext).')
  }
  const authorization = email
    ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
    : /^Basic\s/i.test(token) ? token : `Bearer ${token}`
  return { site: site.replace(/\/+$/, ''), authorization }
}

/** A 404 hides both a missing issue and rejected credentials; ask /myself when it happens. */
export async function credentialHint(config) {
  try {
    const response = await fetch(`${config.site}/rest/api/3/myself`, {
      headers: { authorization: config.authorization, accept: 'application/json' },
    })
    if (response.status === 401) {
      return ' — Jira rejected the credentials (401 on /myself); update the email/API token in Settings → Jira.'
    }
  } catch {}
  return ''
}
