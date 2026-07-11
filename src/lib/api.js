async function req(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  })
  let data = {}
  try { data = await res.json() } catch {}
  if (!res.ok) throw new Error(data.error || 'Something went wrong.')
  return data
}
export const api = {
  me:      () => req('/api/me'),
  signup:  (b) => req('/api/signup', { method: 'POST', body: b }),
  login:   (b) => req('/api/login',  { method: 'POST', body: b }),
  logout:  () => req('/api/logout',  { method: 'POST' }),
  saveProfile: (b) => req('/api/profile', { method: 'PUT', body: b }),
  orders:  () => req('/api/orders'),
  order:   (b) => req('/api/orders', { method: 'POST', body: b })
}
