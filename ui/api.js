let csrf = '';
export const setCSRF = (value) => {
  csrf = value ?? '';
};
export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error ?? 'Request failed');
    error.status = response.status;
    throw error;
  }
  return data;
}
