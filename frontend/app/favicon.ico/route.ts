const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#111318"/><path d="m6 11 10-5 10 5v12l-10 5-10-5z" fill="none" stroke="#a8f931" stroke-width="2" stroke-linejoin="round"/><path d="m6 11 10 5 10-5M16 16v12" fill="none" stroke="#f5f5f7" stroke-width="2" stroke-linejoin="round"/></svg>`;

export function GET() {
  return new Response(icon, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
