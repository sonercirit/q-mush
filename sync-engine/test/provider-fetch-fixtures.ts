export function unavailableProviderResponse(status = 500): Promise<Response> {
  return Promise.resolve(new Response(null, { status }));
}
