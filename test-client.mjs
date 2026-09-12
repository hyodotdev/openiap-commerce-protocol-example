import { CREDENTIALS } from './server.mjs';
export async function request(app, path, input, role = 'server', method = 'POST') {
  const response = await fetch(app.url + path, { method, headers: { 'Content-Type': 'application/json', ...(role ? { Authorization: `Bearer ${CREDENTIALS[role] ?? role}` } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) });
  return { status: response.status, body: await response.json() };
}
export const receipt = { store: 'fixture', fixture: { receipt: 'alice-monthly' } };
